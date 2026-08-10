import type { ScheduledCronTask } from "./scheduler.js";
import type { DistributedCronJob } from "./types.js";

export const MANUAL_TRIGGER = Symbol("distributed-cron.manual-trigger");

export interface ManualTriggerableDistributedCronJob extends DistributedCronJob {
  [MANUAL_TRIGGER](): Promise<void>;
}

export class ScheduledDistributedCronJob implements ManualTriggerableDistributedCronJob {
  #destroyed = false;
  readonly #task: ScheduledCronTask;
  readonly #onDestroy: () => void;

  constructor(task: ScheduledCronTask, onDestroy: () => void) {
    this.#task = task;
    this.#onDestroy = onDestroy;
  }

  start(): void {
    if (!this.#destroyed) {
      this.#task.start();
    }
  }

  stop(): void {
    if (!this.#destroyed) {
      this.#task.stop();
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    this.#destroyed = true;
    this.#task.destroy();
    this.#onDestroy();
  }

  async [MANUAL_TRIGGER](): Promise<void> {
    if (!this.#destroyed) {
      await this.#task.execute();
    }
  }
}
