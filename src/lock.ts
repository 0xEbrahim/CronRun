import { RELEASE_LOCK_SCRIPT } from "./redis/release-lock.lua.js";
import type { Lock, RedisLockClient } from "./types.js";

export class RedisLock implements Lock {
  readonly key: string;

  #released = false;
  readonly #redisKey: string;
  readonly #token: string;
  readonly #redis: RedisLockClient;

  constructor(options: {
    key: string;
    redisKey: string;
    token: string;
    redis: RedisLockClient;
  }) {
    this.key = options.key;
    this.#redisKey = options.redisKey;
    this.#token = options.token;
    this.#redis = options.redis;
  }

  async release(): Promise<boolean> {
    if (this.#released) {
      return false;
    }

    const result = await this.#redis.eval(RELEASE_LOCK_SCRIPT, {
      keys: [this.#redisKey],
      arguments: [this.#token],
    });

    this.#released = true;
    return result === 1 || result === "1" || result === true;
  }
}
