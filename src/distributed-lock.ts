import { randomUUID } from "node:crypto";
import { DistributedLockValidationError } from "./errors.js";
import { RedisLock } from "./lock.js";
import type {
  AcquireLockOptions,
  DistributedLockOptions,
  Lock,
  RedisLockClient,
  RunExclusiveResult,
} from "./types.js";
import { validateKey, validatePrefix, validateRedisClient, validateTtl } from "./validation.js";

const DEFAULT_PREFIX = "distributed-cron-lock";

export class DistributedLock {
  readonly #redis: RedisLockClient;
  readonly #prefix: string;

  constructor(options: DistributedLockOptions) {
    if (!options || typeof options !== "object") {
      throw new DistributedLockValidationError("DistributedLock options are required.");
    }

    validateRedisClient(options.redis);

    const prefix = options.prefix ?? DEFAULT_PREFIX;
    validatePrefix(prefix);

    this.#redis = options.redis;
    this.#prefix = prefix;
  }

  async acquire(key: string, options: AcquireLockOptions): Promise<Lock | null> {
    validateKey(key);
    validateTtl(options?.ttl);

    const token = randomUUID();
    const redisKey = this.#buildKey(key);
    const result = await this.#redis.set(redisKey, token, {
      NX: true,
      PX: options.ttl,
    });

    if (result !== "OK") {
      return null;
    }

    return new RedisLock({
      key,
      redisKey,
      token,
      redis: this.#redis,
    });
  }

  async runExclusive<T>(
    key: string,
    options: AcquireLockOptions,
    callback: () => Promise<T> | T,
  ): Promise<RunExclusiveResult<T>> {
    if (typeof callback !== "function") {
      throw new DistributedLockValidationError("runExclusive callback must be a function.");
    }

    const lock = await this.acquire(key, options);

    if (!lock) {
      return { acquired: false };
    }

    let value: T;

    try {
      value = await callback();
    } catch (error) {
      try {
        await lock.release();
      } catch {
        // Preserve the protected job's original failure.
      }

      throw error;
    }

    try {
      await lock.release();
    } catch (error) {
      throw error;
    }

    return { acquired: true, value };
  }

  #buildKey(key: string): string {
    return `${this.#prefix}:${key}`;
  }
}
