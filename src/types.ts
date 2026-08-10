export interface RedisLockClient {
  set(
    key: string,
    value: string,
    options: {
      NX: true;
      PX: number;
    },
  ): Promise<string | null>;

  eval(
    script: string,
    options: {
      keys: string[];
      arguments: string[];
    },
  ): Promise<unknown>;
}

export interface DistributedLockOptions {
  readonly redis: RedisLockClient;
  readonly prefix?: string;
}

export type DistributedCronErrorPhase = "acquire" | "handler" | "release";

export interface DistributedCronErrorContext {
  readonly key: string;
  readonly expression: string;
  readonly phase: DistributedCronErrorPhase;
}

export interface DistributedCronOptions {
  readonly redis: RedisLockClient;
  readonly prefix?: string;
  readonly defaultTtl?: number;
  readonly onError?: (error: unknown, context: DistributedCronErrorContext) => void;
}

export interface DistributedCronJobOptions {
  readonly key: string;
  readonly ttl?: number;
}

export interface DistributedCronJob {
  start(): void;
  stop(): void;
  destroy(): void;
}

export interface AcquireLockOptions {
  readonly ttl: number;
}

export interface Lock {
  readonly key: string;

  release(): Promise<boolean>;
}

export type RunExclusiveResult<T> =
  | {
      readonly acquired: true;
      readonly value: T;
    }
  | {
      readonly acquired: false;
    };
