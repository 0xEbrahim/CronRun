export class DistributedLockValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "DistributedLockValidationError";
  }
}

export class DistributedCronConfigurationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "DistributedCronConfigurationError";
  }
}
