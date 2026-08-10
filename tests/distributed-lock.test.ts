import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DistributedLock, DistributedLockValidationError } from "../src/index.js";
import { FakeRedisLockClient } from "./fake-redis.js";

describe("DistributedLock", () => {
  it("acquires a lock once and returns null for another owner", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis });
    const second = new DistributedLock({ redis });

    const firstLock = await first.acquire("billing:daily-report", { ttl: 30_000 });
    const secondLock = await second.acquire("billing:daily-report", { ttl: 30_000 });

    assert.ok(firstLock);
    assert.equal(secondLock, null);
  });

  it("allows another owner to acquire after release", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis });
    const second = new DistributedLock({ redis });

    const firstLock = await first.acquire("cleanup", { ttl: 30_000 });
    assert.ok(firstLock);
    assert.equal(await firstLock.release(), true);

    const secondLock = await second.acquire("cleanup", { ttl: 30_000 });
    assert.notEqual(secondLock, null);
  });

  it("allows different keys to be held at the same time", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis });
    const second = new DistributedLock({ redis });

    const jobA = await first.acquire("job-a", { ttl: 30_000 });
    const jobB = await second.acquire("job-b", { ttl: 30_000 });

    assert.ok(jobA);
    assert.ok(jobB);
  });

  it("allows acquisition after TTL expiration", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis });
    const second = new DistributedLock({ redis });

    const firstLock = await first.acquire("reports", { ttl: 10 });
    assert.ok(firstLock);

    redis.advanceBy(11);

    const secondLock = await second.acquire("reports", { ttl: 10 });
    assert.ok(secondLock);
  });

  it("does not let an expired owner release a newer owner's lock", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis, prefix: "test-lock" });
    const second = new DistributedLock({ redis, prefix: "test-lock" });

    const firstLock = await first.acquire("ownership", { ttl: 10 });
    assert.ok(firstLock);

    redis.advanceBy(11);

    const secondLock = await second.acquire("ownership", { ttl: 100 });
    assert.ok(secondLock);

    assert.equal(await firstLock.release(), false);
    assert.equal(redis.has("test-lock:ownership"), true);
    assert.equal(await secondLock.release(), true);
  });

  it("returns false for repeated release calls", async () => {
    const redis = new FakeRedisLockClient();
    const locker = new DistributedLock({ redis });
    const lock = await locker.acquire("once", { ttl: 30_000 });

    assert.ok(lock);
    assert.equal(await lock.release(), true);
    assert.equal(await lock.release(), false);
    assert.equal(redis.evalCalls, 1);
  });

  it("runs only the acquired runExclusive callback", async () => {
    const redis = new FakeRedisLockClient();
    const first = new DistributedLock({ redis });
    const second = new DistributedLock({ redis });
    let firstCalls = 0;
    let secondCalls = 0;

    const firstResult = await first.runExclusive("daily-report", { ttl: 30_000 }, async () => {
      firstCalls += 1;

      const secondResult = await second.runExclusive("daily-report", { ttl: 30_000 }, () => {
        secondCalls += 1;
        return "second";
      });

      assert.deepEqual(secondResult, { acquired: false });
      return "first";
    });

    assert.deepEqual(firstResult, { acquired: true, value: "first" });
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
  });

  it("attempts release and propagates the original callback error", async () => {
    const redis = new FakeRedisLockClient();
    const locker = new DistributedLock({ redis });
    const expected = new Error("job failed");

    await assert.rejects(
      locker.runExclusive("failing-job", { ttl: 30_000 }, () => {
        throw expected;
      }),
      expected,
    );

    assert.equal(redis.evalCalls, 1);
    assert.equal(await locker.acquire("failing-job", { ttl: 30_000 }).then(Boolean), true);
  });

  it("preserves callback errors when release also fails", async () => {
    const redis = new FakeRedisLockClient();
    const locker = new DistributedLock({ redis });
    const expected = new Error("job failed");

    redis.evalFailure = new Error("redis release failed");

    await assert.rejects(
      locker.runExclusive("double-failure", { ttl: 30_000 }, () => {
        throw expected;
      }),
      expected,
    );

    assert.equal(redis.evalCalls, 1);
  });

  it("propagates release failures when the callback succeeds", async () => {
    const redis = new FakeRedisLockClient();
    const locker = new DistributedLock({ redis });
    const expected = new Error("redis release failed");

    redis.evalFailure = expected;

    await assert.rejects(
      locker.runExclusive("release-failure", { ttl: 30_000 }, () => "value"),
      expected,
    );

    assert.equal(redis.evalCalls, 1);
  });

  it("propagates Redis acquisition failures and does not run the callback", async () => {
    const redis = new FakeRedisLockClient();
    const locker = new DistributedLock({ redis });
    const expected = new Error("redis unavailable");
    let callbackCalls = 0;

    redis.setFailure = expected;

    await assert.rejects(
      locker.runExclusive("unsafe-job", { ttl: 30_000 }, () => {
        callbackCalls += 1;
      }),
      expected,
    );

    assert.equal(callbackCalls, 0);
  });

  it("allows exactly one concurrent acquisition for the same key", async () => {
    const redis = new FakeRedisLockClient();
    const lockers = Array.from({ length: 20 }, () => new DistributedLock({ redis }));

    const locks = await Promise.all(
      lockers.map((locker) => locker.acquire("concurrent", { ttl: 30_000 })),
    );

    assert.equal(locks.filter(Boolean).length, 1);
  });

  it("validates public input", async () => {
    const redis = new FakeRedisLockClient();

    assert.throws(() => new DistributedLock({ redis, prefix: "" }), {
      name: "DistributedLockValidationError",
    });

    const locker = new DistributedLock({ redis });

    await assert.rejects(locker.acquire("", { ttl: 30_000 }), DistributedLockValidationError);
    await assert.rejects(locker.acquire("job", { ttl: 0 }), DistributedLockValidationError);
    await assert.rejects(locker.acquire("job", { ttl: 1.5 }), DistributedLockValidationError);
    await assert.rejects(
      locker.runExclusive("job", { ttl: 30_000 }, undefined as never),
      DistributedLockValidationError,
    );
  });
});
