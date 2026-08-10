import type { RedisLockClient } from "../src/index.js";

interface Entry {
  readonly value: string;
  readonly expiresAt: number;
}

export class FakeRedisLockClient implements RedisLockClient {
  evalCalls = 0;
  setCalls = 0;
  setFailure: Error | null = null;
  evalFailure: Error | null = null;

  #now = 0;
  readonly #entries = new Map<string, Entry>();

  async set(
    key: string,
    value: string,
    options: { NX: true; PX: number },
  ): Promise<string | null> {
    this.setCalls += 1;

    if (this.setFailure) {
      throw this.setFailure;
    }

    this.#deleteIfExpired(key);

    if (options.NX && this.#entries.has(key)) {
      return null;
    }

    this.#entries.set(key, {
      value,
      expiresAt: this.#now + options.PX,
    });

    return "OK";
  }

  async eval(
    _script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    this.evalCalls += 1;

    if (this.evalFailure) {
      throw this.evalFailure;
    }

    const key = options.keys[0];
    const token = options.arguments[0];

    if (!key || !token) {
      return 0;
    }

    this.#deleteIfExpired(key);
    const entry = this.#entries.get(key);

    if (entry?.value !== token) {
      return 0;
    }

    this.#entries.delete(key);
    return 1;
  }

  advanceBy(milliseconds: number): void {
    this.#now += milliseconds;
  }

  has(key: string): boolean {
    this.#deleteIfExpired(key);
    return this.#entries.has(key);
  }

  #deleteIfExpired(key: string): void {
    const entry = this.#entries.get(key);

    if (entry && entry.expiresAt <= this.#now) {
      this.#entries.delete(key);
    }
  }
}
