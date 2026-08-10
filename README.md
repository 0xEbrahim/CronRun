# distributed-cron-lock

`distributed-cron-lock` coordinates scheduled jobs across multiple Node.js application replicas using Redis locks.

If three replicas trigger the same scheduled job at about the same time, this package lets one replica acquire a Redis lease and run the job while the others skip that execution. It does not schedule jobs, run queues, perform leader election, or provide exactly-once execution.

## Installation

```sh
npm install distributed-cron-lock
```

## Basic Usage

```ts
import { DistributedLock } from "distributed-cron-lock";

const locker = new DistributedLock({
  redis,
  prefix: "distributed-cron-lock",
});

const result = await locker.runExclusive(
  "daily-report",
  { ttl: 60_000 },
  async () => {
    await generateReport();
  },
);

if (!result.acquired) {
  console.log("Another instance is already running it");
}
```

You can also acquire and release a lock manually:

```ts
const lock = await locker.acquire("daily-report", { ttl: 60_000 });

if (!lock) {
  return;
}

try {
  await generateReport();
} finally {
  await lock.release();
}
```

## Using With a Scheduler

This package is scheduler-agnostic. A cron library, queue worker, framework scheduler, or custom timer can call it.

```ts
cron.schedule("0 0 * * *", async () => {
  const result = await locker.runExclusive(
    "daily-report",
    { ttl: 60_000 },
    async () => {
      await generateReport();
    },
  );

  if (!result.acquired) {
    return;
  }
});
```

`node-cron` is shown only as an example. It is not a dependency of this package.

## Public API

```ts
import {
  DistributedLock,
  type Lock,
  type RunExclusiveResult,
  type RedisLockClient,
} from "distributed-cron-lock";
```

### `new DistributedLock(options)`

```ts
const locker = new DistributedLock({
  redis,
  prefix: "my-service",
});
```

Options:

- `redis`: a Redis client with `set(key, value, { NX: true, PX: ttl })` and `eval(script, { keys, arguments })` methods.
- `prefix`: optional Redis key prefix. Defaults to `distributed-cron-lock`.

### `acquire(key, { ttl })`

Attempts to acquire `prefix:key` using atomic Redis `SET key token NX PX ttl` semantics.

Returns:

- `Lock` when acquired.
- `null` when another owner already holds the lock.

Redis command failures are not converted into `null`; they reject so the caller can fail closed.

### `runExclusive(key, { ttl }, callback)`

Attempts to acquire the lock, runs the callback only if acquired, and releases in `finally`.

```ts
type RunExclusiveResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };
```

Callback errors are propagated. The lock release is still attempted when the callback throws.

## TTL And Crash Recovery

Every lock has a TTL. If a process crashes after acquiring a lock, Redis eventually expires the key and another process can acquire it.

Choose a TTL longer than the expected execution time of the protected job. V1 uses a lease: if the TTL is shorter than the actual job duration, another replica can acquire the lock while the first job is still running.

For example, with a 30 second TTL and a job that unexpectedly runs for 45 seconds, another replica may acquire the lock after second 30. For those final 15 seconds, both executions may overlap. This package provides at-most-one active execution only while the lease remains valid. It does not guarantee exactly-once execution.

## Ownership-Safe Release

Each acquired lock stores a unique ownership token in Redis. Release uses an atomic Lua script that deletes the Redis key only when the stored token still matches this owner.

This prevents an old owner from deleting a newer owner's lock after the old owner's TTL has expired.

## V1 Scope

V1 intentionally stays small:

- Redis is the only backend.
- The caller owns Redis connection lifecycle.
- No scheduling, retries, queues, leader election, lock extension, metrics, dashboards, or framework integrations.
- No NestJS module or decorators are included.
