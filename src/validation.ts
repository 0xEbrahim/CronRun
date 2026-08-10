import { DistributedLockValidationError } from "./errors.js";

export function validateRedisClient(redis: unknown): void {
  if (
    !redis ||
    typeof redis !== "object" ||
    typeof (redis as { set?: unknown }).set !== "function" ||
    typeof (redis as { eval?: unknown }).eval !== "function"
  ) {
    throw new DistributedLockValidationError(
      "A Redis client with set() and eval() methods is required.",
    );
  }
}

export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new DistributedLockValidationError("Lock key must be a non-empty string.");
  }
}

export function validateTtl(ttl: unknown): asserts ttl is number {
  if (typeof ttl !== "number" || !Number.isFinite(ttl) || !Number.isInteger(ttl) || ttl <= 0) {
    throw new DistributedLockValidationError("Lock TTL must be a finite positive integer.");
  }
}

export function validatePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string" || prefix.trim().length === 0) {
    throw new DistributedLockValidationError("Lock prefix must be a non-empty string.");
  }
}
