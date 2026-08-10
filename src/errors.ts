export class DistributedLockValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "DistributedLockValidationError";
  }
}
