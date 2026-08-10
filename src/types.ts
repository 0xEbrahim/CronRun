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
