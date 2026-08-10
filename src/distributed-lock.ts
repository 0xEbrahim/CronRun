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

const DEFAULT_PREFIX = "distributed-cron-lock";

export class DistributedLock {
  readonly #redis: RedisLockClient;
  readonly #prefix: string;

  constructor(options: DistributedLockOptions) {
    if (!options || typeof options !== "object") {
      throw new DistributedLockValidationError("DistributedLock options are required.");
    }

    if (
      !options.redis ||
      typeof options.redis.set !== "function" ||
      typeof options.redis.eval !== "function"
    ) {
      throw new DistributedLockValidationError(
        "A Redis client with set() and eval() methods is required.",
      );
    }

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

function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new DistributedLockValidationError("Lock key must be a non-empty string.");
  }
}

function validateTtl(ttl: unknown): asserts ttl is number {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
    throw new DistributedLockValidationError("Lock TTL must be a finite positive integer.");
  }
}

function validatePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string" || prefix.trim().length === 0) {
    throw new DistributedLockValidationError("Lock prefix must be a non-empty string.");
  }
}
