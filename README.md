# cronductor

Distributed cron scheduler for Node.js using Redis-backed locking.

Use this package when the same Node.js application runs on multiple replicas and each replica registers the same cron job in application code.

```text
3 application replicas
       |
       v
same cron schedule fires
       |
       v
without coordination: handler runs 3 times
       |
       v
with cronductor: one replica gets the Redis lock
       |
       v
one executes, others skip
```

Every replica still has a local cron scheduler. Redis coordinates which replica owns a scheduled occurrence.

```text
Replica A cron --\
Replica B cron ---+--> Redis lock
Replica C cron --/
                     |
                     v
                  one winner
                     |
                     v
                  handler
```

## Installation

```sh
npm install cronductor
```

Install and configure a Redis client in your application as well. The examples use the official `redis` package:

```sh
npm install redis
```

## Requirements

- Node.js 20 or newer.
- Redis reachable by your application replicas.
- A Redis client compatible with this package's `RedisLockClient` interface: `set(key, value, { NX: true, PX: ttl })` and `eval(script, { keys, arguments })`.

The caller owns the Redis connection lifecycle. This package does not connect, quit, disconnect, or close the Redis client for you.

## Basic Usage

```ts
import { createClient } from "redis";
import { DistributedCron } from "cronductor";

const redis = createClient({
  url: process.env.REDIS_URL,
});

await redis.connect();

const cron = new DistributedCron({
  redis,
  defaultTtl: 60_000,
});

cron.schedule(
  "*/5 * * * *",
  {
    key: "sync-users",
  },
  async () => {
    await syncUsers();
  },
);
```

If ten replicas run this code, ten local cron timers fire, ten replicas attempt the same Redis lock, one wins, nine skip, and one handler executes while the lease remains valid.

## TTL Override

Configure a default TTL on the scheduler, or override it per job:

```ts
cron.schedule(
  "0 0 * * *",
  {
    key: "daily-report",
    ttl: 5 * 60_000,
  },
  generateDailyReport,
);
```

Choose a TTL greater than the expected maximum execution time of the protected job.

## Error Handling

Scheduled handlers are not directly awaited by user code, so errors are delivered to `onError`:

```ts
const cron = new DistributedCron({
  redis,
  defaultTtl: 60_000,
  onError(error, context) {
    console.error(
      `Cron job ${context.key} failed during ${context.phase}`,
      error,
    );
  },
});
```

`context.phase` is one of:

- `"acquire"`: Redis lock acquisition failed.
- `"handler"`: the user handler threw.
- `"release"`: ownership-safe release failed.

If Redis cannot be reached during lock acquisition, the job does not execute. The library fails closed.

If `onError` is not provided, the package writes the error and context to `console.error` to avoid unhandled promise rejections.

## Start, Stop, And Destroy

Jobs start when scheduled. The returned job handle controls the local cron task:

```ts
const job = cron.schedule(
  "0 * * * *",
  {
    key: "hourly-report",
  },
  generateHourlyReport,
);

job.stop();
job.start();
job.destroy();
```

Calling `destroy()` permanently unregisters the local scheduler task and frees the key for reuse on that `DistributedCron` instance.

## Public API

```ts
import {
  DistributedCron,
  DistributedCronConfigurationError,
  DistributedLock,
  DistributedLockValidationError,
  type AcquireLockOptions,
  type DistributedCronErrorContext,
  type DistributedCronErrorPhase,
  type DistributedCronJob,
  type DistributedCronJobOptions,
  type DistributedCronOptions,
  type DistributedLockOptions,
  type Lock,
  type RedisLockClient,
  type RunExclusiveResult,
} from "cronductor";
```

`DistributedCron` is the primary V1 API. `DistributedLock` is exported as a lower-level lock primitive for callers that need the same Redis ownership-safe lock without cron scheduling.

## `new DistributedCron(options)`

```ts
const cron = new DistributedCron({
  redis,
  prefix: "my-service",
  defaultTtl: 60_000,
  onError(error, context) {
    console.error(error, context);
  },
});
```

Options:

- `redis`: Redis client with `set()` and `eval()` methods compatible with `RedisLockClient`.
- `prefix`: optional Redis key prefix. Defaults to `cronductor`.
- `defaultTtl`: optional TTL used when a job does not specify its own `ttl`.
- `onError`: optional scheduled-job error callback.

## `cron.schedule(expression, options, handler)`

```ts
const job = cron.schedule(
  "0 * * * *",
  {
    key: "hourly-report",
    ttl: 5 * 60 * 1000,
  },
  async () => {
    await generateReport();
  },
);
```

`schedule()` validates the cron expression, job key, TTL, handler, and duplicate local keys immediately. If a job does not provide `ttl`, `defaultTtl` must be configured.

Duplicate keys are rejected only within the same `DistributedCron` instance. Multiple replicas should use the same key for the same distributed job so Redis can coordinate execution.

## Redis Ownership

Lock acquisition uses Redis atomic set-if-not-exists with a lease:

```text
SET key token NX PX ttl
```

Each acquired lock stores a unique ownership token in Redis. Release uses an atomic Lua script that deletes the key only if the stored token still matches the releasing owner.

This prevents a stale owner from deleting a newer owner's lock after TTL expiration and reacquisition.

## Important TTL Limitation

V1 does not implement automatic lock renewal.

If a job runs longer than its lock TTL, the Redis lock can expire while the original handler is still executing. Another replica may then acquire the lock and start another execution.

```text
12:00:00  Replica A acquires lock with TTL 30 seconds
12:00:30  Lock expires
12:00:30  Replica B acquires a later occurrence
12:00:30-12:00:45  Replica A and Replica B may both be running
```

This package does not guarantee exactly-once execution. Redis locking prevents concurrent replicas from executing while the lock lease remains valid.

## V1 Scope

V1 intentionally does not include NestJS integration, decorators, Express or Fastify integration, dashboards, history, metrics, queues, retries, leader election, dynamic jobs in Redis, lock renewal, fencing tokens, Redlock, multiple Redis clusters, or a web UI.
