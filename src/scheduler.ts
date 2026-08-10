import cron, { type ScheduledTask } from "node-cron";

export interface ScheduledCronTask {
  start(): void;
  stop(): void;
  destroy(): void;
  execute(): Promise<unknown>;
}

export interface CronScheduler {
  schedule(expression: string, handler: () => Promise<void>): ScheduledCronTask;
  validate(expression: string): boolean;
}

export class NodeCronScheduler implements CronScheduler {
  schedule(expression: string, handler: () => Promise<void>): ScheduledCronTask {
    return cron.schedule(expression, handler) as ScheduledTask;
  }

  validate(expression: string): boolean {
    return cron.validate(expression);
  }
}
