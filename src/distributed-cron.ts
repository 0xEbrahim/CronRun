import { DistributedCronConfigurationError } from "./errors.js";
import { DistributedLock } from "./distributed-lock.js";
import { ScheduledDistributedCronJob } from "./distributed-cron-job.js";
import { NodeCronScheduler, type CronScheduler } from "./scheduler.js";
import type {
  DistributedCronErrorContext,
  DistributedCronJob,
  DistributedCronJobOptions,
  DistributedCronOptions,
} from "./types.js";
import { validatePrefix, validateRedisClient } from "./validation.js";

const DEFAULT_PREFIX = "distributed-cron-lock";

export class DistributedCron {
  readonly #lockManager: DistributedLock;
  readonly #scheduler: CronScheduler;
  readonly #defaultTtl: number | undefined;
  readonly #onError: ((error: unknown, context: DistributedCronErrorContext) => void) | undefined;
  readonly #registeredKeys = new Set<string>();

  constructor(options: DistributedCronOptions) {
    if (!options || typeof options !== "object") {
      throw new DistributedCronConfigurationError("DistributedCron options are required.");
    }

    validateRedisClient(options.redis);

    const prefix = options.prefix ?? DEFAULT_PREFIX;
    validatePrefix(prefix);

    if (options.defaultTtl !== undefined) {
      validateCronTtl(options.defaultTtl);
    }

    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new DistributedCronConfigurationError("onError must be a function when provided.");
    }

    this.#scheduler = new NodeCronScheduler();
    this.#lockManager = new DistributedLock({
      redis: options.redis,
      prefix,
    });
    this.#defaultTtl = options.defaultTtl;
    this.#onError = options.onError;
  }

  schedule<T>(
    expression: string,
    options: DistributedCronJobOptions,
    handler: () => T | Promise<T>,
  ): DistributedCronJob {
    this.#validateScheduleArguments(expression, options, handler);

    const ttl = options.ttl ?? this.#defaultTtl;
    validateCronTtl(ttl);

    if (this.#registeredKeys.has(options.key)) {
      throw new DistributedCronConfigurationError(
        `A job with key "${options.key}" is already registered on this DistributedCron instance.`,
      );
    }

    this.#registeredKeys.add(options.key);

    let taskCreated = false;

    try {
      const task = this.#scheduler.schedule(expression, async () => {
        await this.#runOccurrence(expression, options.key, ttl, handler);
      });
      taskCreated = true;

      return new ScheduledDistributedCronJob(task, () => {
        this.#registeredKeys.delete(options.key);
      });
    } finally {
      if (!taskCreated) {
        this.#registeredKeys.delete(options.key);
      }
    }
  }

  #validateScheduleArguments<T>(
    expression: unknown,
    options: DistributedCronJobOptions | undefined,
    handler: (() => T | Promise<T>) | undefined,
  ): asserts expression is string {
    if (typeof expression !== "string" || !this.#scheduler.validate(expression)) {
      throw new DistributedCronConfigurationError("Cron expression is invalid.");
    }

    if (!options || typeof options !== "object") {
      throw new DistributedCronConfigurationError("Distributed cron job options are required.");
    }

    validateCronKey(options.key);

    if (options.ttl !== undefined) {
      validateCronTtl(options.ttl);
    } else if (this.#defaultTtl === undefined) {
      throw new DistributedCronConfigurationError(
        "Job TTL is required when DistributedCron defaultTtl is not configured.",
      );
    }

    if (typeof handler !== "function") {
      throw new DistributedCronConfigurationError("Distributed cron job handler must be a function.");
    }
  }

  async #runOccurrence<T>(
    expression: string,
    key: string,
    ttl: number,
    handler: () => T | Promise<T>,
  ): Promise<void> {
    const lock = await this.#acquireLock(expression, key, ttl);

    if (!lock) {
      return;
    }

    let handlerFailed = false;

    try {
      await handler();
    } catch (error) {
      handlerFailed = true;
      this.#reportError(error, { key, expression, phase: "handler" });
    }

    try {
      await lock.release();
    } catch (error) {
      this.#reportError(error, { key, expression, phase: "release" });
    }

    if (handlerFailed) {
      return;
    }
  }

  async #acquireLock(expression: string, key: string, ttl: number) {
    try {
      return await this.#lockManager.acquire(key, { ttl });
    } catch (error) {
      this.#reportError(error, { key, expression, phase: "acquire" });
      return null;
    }
  }

  #reportError(error: unknown, context: DistributedCronErrorContext): void {
    if (this.#onError) {
      try {
        this.#onError(error, context);
      } catch (onErrorFailure) {
        console.error("Distributed cron onError callback failed.", {
          error: onErrorFailure,
          originalError: error,
          context,
        });
      }

      return;
    }

    console.error("Distributed cron job failed.", { error, context });
  }
}

function validateCronKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new DistributedCronConfigurationError("Job key must be a non-empty string.");
  }
}

function validateCronTtl(ttl: unknown): asserts ttl is number {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
    throw new DistributedCronConfigurationError("Job TTL must be a finite positive integer.");
  }
}
