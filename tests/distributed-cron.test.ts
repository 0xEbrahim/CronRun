import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DistributedCron,
  DistributedCronConfigurationError,
  DistributedLock,
  type DistributedCronErrorContext,
  type DistributedCronJob,
} from "../src/index.js";
import {
  MANUAL_TRIGGER,
  type ManualTriggerableDistributedCronJob,
} from "../src/distributed-cron-job.js";
import { FakeRedisLockClient } from "./fake-redis.js";

const EVERY_MINUTE = "* * * * *";

describe("DistributedCron", () => {
  it("executes the handler when the lock is acquired and releases afterward", async () => {
    const redis = new FakeRedisLockClient();
    const cron = new DistributedCron({ redis, defaultTtl: 30_000 });
    let calls = 0;

    const job = cron.schedule(EVERY_MINUTE, { key: "daily-report" }, async () => {
      calls += 1;
    });
    job.stop();

    await trigger(job);

    assert.equal(calls, 1);
    assert.equal(redis.has("distributed-cron-lock:daily-report"), false);

    job.destroy();
  });

  it("skips a handler when another instance owns the lock", async () => {
    const redis = new FakeRedisLockClient();
    const firstCron = new DistributedCron({ redis, defaultTtl: 30_000 });
    const secondCron = new DistributedCron({ redis, defaultTtl: 30_000 });
    const releaseFirstHandler = deferred<void>();
    let firstCalls = 0;
    let secondCalls = 0;

    const firstJob = firstCron.schedule(EVERY_MINUTE, { key: "cleanup" }, async () => {
      firstCalls += 1;
      await releaseFirstHandler.promise;
    });
    const secondJob = secondCron.schedule(EVERY_MINUTE, { key: "cleanup" }, async () => {
      secondCalls += 1;
    });
    firstJob.stop();
    secondJob.stop();

    const firstRun = trigger(firstJob);
    await waitFor(() => firstCalls === 1);
    await trigger(secondJob);
    releaseFirstHandler.resolve();
    await firstRun;

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);

    firstJob.destroy();
    secondJob.destroy();
  });

  it("allows only one replica to execute a shared scheduled occurrence", async () => {
    const redis = new FakeRedisLockClient();
    const releaseWinner = deferred<void>();
    let handlerCalls = 0;

    const jobs = Array.from({ length: 8 }, () => {
      const cron = new DistributedCron({ redis, defaultTtl: 30_000 });
      const job = cron.schedule(EVERY_MINUTE, { key: "sync-users" }, async () => {
        handlerCalls += 1;
        await releaseWinner.promise;
      });
      job.stop();
      return job;
    });

    const runs = jobs.map((job) => trigger(job));
    await waitFor(() => handlerCalls === 1);
    releaseWinner.resolve();
    await Promise.all(runs);

    assert.equal(handlerCalls, 1);

    jobs.forEach((job) => job.destroy());
  });

  it("executes different keys independently", async () => {
    const redis = new FakeRedisLockClient();
    const cron = new DistributedCron({ redis, defaultTtl: 30_000 });
    let jobACalls = 0;
    let jobBCalls = 0;

    const jobA = cron.schedule(EVERY_MINUTE, { key: "job-a" }, () => {
      jobACalls += 1;
    });
    const jobB = cron.schedule(EVERY_MINUTE, { key: "job-b" }, () => {
      jobBCalls += 1;
    });
    jobA.stop();
    jobB.stop();

    await Promise.all([trigger(jobA), trigger(jobB)]);

    assert.equal(jobACalls, 1);
    assert.equal(jobBCalls, 1);

    jobA.destroy();
    jobB.destroy();
  });

  it("releases after handler success so a future occurrence can acquire", async () => {
    const redis = new FakeRedisLockClient();
    const cron = new DistributedCron({ redis, defaultTtl: 30_000 });
    let calls = 0;

    const job = cron.schedule(EVERY_MINUTE, { key: "repeating-job" }, () => {
      calls += 1;
    });
    job.stop();

    await trigger(job);
    await trigger(job);

    assert.equal(calls, 2);
    assert.equal(redis.has("distributed-cron-lock:repeating-job"), false);

    job.destroy();
  });

  it("releases after handler failure and reports the handler error", async () => {
    const redis = new FakeRedisLockClient();
    const errors: Array<{ error: unknown; context: DistributedCronErrorContext }> = [];
    const cron = new DistributedCron({
      redis,
      defaultTtl: 30_000,
      onError(error, context) {
        errors.push({ error, context });
      },
    });
    const expected = new Error("handler failed");

    const job = cron.schedule(EVERY_MINUTE, { key: "failing-handler" }, () => {
      throw expected;
    });
    job.stop();

    await trigger(job);

    assert.equal(redis.evalCalls, 1);
    assert.equal(redis.has("distributed-cron-lock:failing-handler"), false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, expected);
    assert.equal(errors[0]?.context.phase, "handler");

    job.destroy();
  });

  it("does not execute the handler when Redis acquisition fails", async () => {
    const redis = new FakeRedisLockClient();
    const expected = new Error("redis unavailable");
    const errors: Array<{ error: unknown; context: DistributedCronErrorContext }> = [];
    let calls = 0;

    const cron = new DistributedCron({
      redis,
      defaultTtl: 30_000,
      onError(error, context) {
        errors.push({ error, context });
      },
    });
    const job = cron.schedule(EVERY_MINUTE, { key: "unsafe-job" }, () => {
      calls += 1;
    });
    job.stop();
    redis.setFailure = expected;

    await trigger(job);

    assert.equal(calls, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, expected);
    assert.equal(errors[0]?.context.phase, "acquire");

    job.destroy();
  });

  it("reports release failures without rerunning the handler", async () => {
    const redis = new FakeRedisLockClient();
    const expected = new Error("release failed");
    const errors: Array<{ error: unknown; context: DistributedCronErrorContext }> = [];
    let calls = 0;

    const cron = new DistributedCron({
      redis,
      defaultTtl: 30_000,
      onError(error, context) {
        errors.push({ error, context });
      },
    });
    const job = cron.schedule(EVERY_MINUTE, { key: "release-failure" }, () => {
      calls += 1;
    });
    job.stop();
    redis.evalFailure = expected;

    await trigger(job);

    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, expected);
    assert.equal(errors[0]?.context.phase, "release");

    job.destroy();
  });

  it("keeps ownership-safe release behavior for expired owners", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis, prefix: "distributed-cron-lock" });
    const second = new DistributedLock({ redis, prefix: "distributed-cron-lock" });

    const firstLock = await first.acquire("ownership", { ttl: 10 });
    assert.ok(firstLock);

    redis.advanceBy(11);

    const secondLock = await second.acquire("ownership", { ttl: 100 });
    assert.ok(secondLock);

    assert.equal(await firstLock.release(), false);
    assert.equal(redis.has("distributed-cron-lock:ownership"), true);
    assert.equal(await secondLock.release(), true);
  });

  it("allows another scheduler to acquire after TTL expiration", async () => {
    const redis = new FakeRedisLockClient();
    const firstCron = new DistributedCron({ redis, defaultTtl: 10 });
    const secondCron = new DistributedCron({ redis, defaultTtl: 100 });
    const releaseFirstHandler = deferred<void>();
    let firstCalls = 0;
    let secondCalls = 0;

    const firstJob = firstCron.schedule(EVERY_MINUTE, { key: "ttl-job" }, async () => {
      firstCalls += 1;
      await releaseFirstHandler.promise;
    });
    const secondJob = secondCron.schedule(EVERY_MINUTE, { key: "ttl-job" }, () => {
      secondCalls += 1;
    });
    firstJob.stop();
    secondJob.stop();

    const firstRun = trigger(firstJob);
    await waitFor(() => firstCalls === 1);
    redis.advanceBy(11);

    await trigger(secondJob);
    releaseFirstHandler.resolve();
    await firstRun;

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1);
    assert.equal(redis.has("distributed-cron-lock:ttl-job"), false);

    firstJob.destroy();
    secondJob.destroy();
  });

  it("rejects invalid registration input immediately", () => {
    const redis = new FakeRedisLockClient();
    const cron = new DistributedCron({ redis, defaultTtl: 30_000 });

    assert.throws(
      () => cron.schedule("not a cron", { key: "job" }, () => undefined),
      DistributedCronConfigurationError,
    );
    assert.throws(
      () => cron.schedule(EVERY_MINUTE, { key: "" }, () => undefined),
      DistributedCronConfigurationError,
    );
    assert.throws(
      () => cron.schedule(EVERY_MINUTE, { key: "job", ttl: 0 }, () => undefined),
      DistributedCronConfigurationError,
    );
    assert.throws(
      () => cron.schedule(EVERY_MINUTE, { key: "job", ttl: 1.5 }, () => undefined),
      DistributedCronConfigurationError,
    );
    assert.throws(
      () => cron.schedule(EVERY_MINUTE, { key: "job" }, undefined as never),
      DistributedCronConfigurationError,
    );
    assert.throws(
      () => new DistributedCron({ redis }).schedule(EVERY_MINUTE, { key: "job" }, () => undefined),
      DistributedCronConfigurationError,
    );
  });

  it("rejects duplicate local keys until the original job is destroyed", () => {
    const redis = new FakeRedisLockClient();
    const cron = new DistributedCron({ redis, defaultTtl: 30_000 });
    const job = cron.schedule(EVERY_MINUTE, { key: "duplicate" }, () => undefined);
    job.stop();

    assert.throws(
      () => cron.schedule("*/5 * * * *", { key: "duplicate" }, () => undefined),
      DistributedCronConfigurationError,
    );

    job.destroy();
    const replacement = cron.schedule("*/5 * * * *", { key: "duplicate" }, () => undefined);
    replacement.stop();
    replacement.destroy();
  });
});

async function trigger(job: DistributedCronJob): Promise<void> {
  await (job as ManualTriggerableDistributedCronJob)[MANUAL_TRIGGER]();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });

  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.fail("Condition was not met before timeout.");
}
