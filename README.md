# distributed-cron-lock

Distributed cron scheduling for Node.js using Redis-backed locking.

Use this package when the same application runs on multiple replicas and each replica registers the same cron jobs in application code.

Without coordination:

```text
Replica A -> execute hourly job
Replica B -> execute hourly job
Replica C -> execute hourly job
```

With `distributed-cron-lock`:

```text
Replica A -> wins Redis lock -> execute
Replica B -> lock unavailable -> skip
Replica C -> lock unavailable -> skip
```

Every replica still has a local cron scheduler. Redis coordinates which replica owns a scheduled occurrence.

## Installation

```sh
npm install distributed-cron-lock
```

## Basic Usage

```ts
import { createClient } from "redis";
import { DistributedCron } from "distributed-cron-lock";

const redis = createClient();

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

cron.schedule(
  "0 0 * * *",
  {
    key: "daily-report",
    ttl: 5 * 60_000,
  },
  async () => {
    await generateDailyReport();
  },
);
```

If ten replicas run this code, ten local cron timers fire, ten replicas attempt the same Redis lock, one wins, nine skip, and one handler executes.

## Public API

```ts
import {
  DistributedCron,
  type DistributedCronJob,
  type DistributedCronOptions,
  type DistributedCronJobOptions,
  type DistributedCronErrorContext,
} from "distributed-cron-lock";
```

### `new DistributedCron(options)`

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

- `redis`: Redis client with `set(key, value, { NX: true, PX: ttl })` and `eval(script, { keys, arguments })`.
- `prefix`: optional Redis key prefix. Defaults to `distributed-cron-lock`.
- `defaultTtl`: optional TTL used when a job does not specify its own `ttl`.
- `onError`: optional scheduled-job error callback.

The caller owns the Redis connection lifecycle. This package never calls `quit()`, `disconnect()`, or `process.exit()`.

### `cron.schedule(expression, options, handler)`

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

`schedule()` validates the cron expression, job key, TTL, handler, and duplicate local keys immediately. Jobs start as soon as they are scheduled.

The returned job handle is intentionally small:

```ts
job.stop();
job.start();
job.destroy();
```

Calling `destroy()` permanently unregisters the local scheduler task and frees the key for reuse on that `DistributedCron` instance.

## Runtime Flow

For each scheduled occurrence:

```text
cron expression fires
        |
        v
Redis SET key token NX PX ttl
        |
        +-- lock unavailable -> skip
        |
        +-- Redis error -> do not execute, report phase = "acquire"
        |
        v
handler executes
        |
        v
Lua release compares ownership token before DEL
```

Lock contention is normal and does not throw. Redis command failures are different: the package fails closed and does not execute the handler.

## Error Handling

Scheduled handlers are not directly awaited by user code, so errors are delivered to `onError`:

```ts
const cron = new DistributedCron({
  redis,
  defaultTtl: 60_000,
  onError(error, context) {
    console.error(context.phase, context.key, error);
  },
});
```

`context.phase` is one of:

- `"acquire"`: Redis lock acquisition failed.
- `"handler"`: the user handler threw.
- `"release"`: ownership-safe release failed.

If `onError` is not provided, the package writes the error and context to `console.error`. This avoids unhandled promise rejections without configuring logging globally.

Handler failures still attempt lock release. Release failures are reported separately.

## TTL And Crash Recovery

Every lock has a TTL. If a process crashes after acquiring a lock, Redis eventually expires the key and another replica can acquire it.

Choose a TTL longer than the expected maximum execution time of the protected job.

V1 uses a lease. If the TTL is shorter than the actual job duration, another replica can acquire the lock while the first job is still running:

```text
12:00:00  Replica A acquires lock with TTL 30 seconds
12:00:30  Lock expires
12:00:30  Replica B acquires a later occurrence
12:00:30-12:00:45  Replica A and Replica B may both be running
```

This package does not guarantee exactly-once execution. It provides at-most-one active execution only while the Redis lease remains valid.

## Ownership-Safe Release

Each acquired lock stores a unique ownership token in Redis. Release uses an atomic Lua script that deletes the key only if the stored token still matches the releasing owner.

This prevents a stale owner from deleting a newer owner's lock after TTL expiration and reacquisition.

## Lower-Level Lock API

`DistributedLock` remains exported as a lower-level compatibility API, but `DistributedCron` is the primary abstraction.

## V1 Scope

V1 intentionally does not include NestJS integration, decorators, Express or Fastify integration, dashboards, history, metrics, queues, retries, leader election, dynamic jobs in Redis, lock renewal, fencing tokens, Redlock, multiple Redis clusters, or a web UI.
