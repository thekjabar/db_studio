import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import type Redis from 'ioredis';
import { AppConfigService } from '../config/config.service';
import {
  QUEUE_EMAIL,
  QUEUE_EXEC,
  REDIS_CLIENT,
  type EmailJobData,
  type ExecJobData,
} from './scheduler.constants';

@Injectable()
export class QueuesService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QueuesService.name);
  exec: Queue<ExecJobData> | null = null;
  email: Queue<EmailJobData> | null = null;
  private execEvents: QueueEvents | null = null;

  constructor(
    private readonly cfg: AppConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit() {
    if (!this.redis) return;
    this.exec = new Queue<ExecJobData>(QUEUE_EXEC, { connection: this.redis });
    this.email = new Queue<EmailJobData>(QUEUE_EMAIL, { connection: this.redis });
    this.execEvents = new QueueEvents(QUEUE_EXEC, { connection: this.redis });
    this.log.log('bullmq queues initialized');
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.exec?.close(),
      this.email?.close(),
      this.execEvents?.close(),
    ]);
  }

  /** Register/refresh the cron trigger for a schedule. */
  async upsertCron(scheduleId: string, cron: string, tz?: string | null) {
    if (!this.exec) return;
    const repeatKey = `schedule:${scheduleId}`;
    // bullmq dedupes repeatable jobs by the jobId when provided — safe to call
    // this on every schedule create/update.
    await this.exec.removeRepeatableByKey(repeatKey).catch(() => {});
    await this.exec.add(
      `schedule:${scheduleId}`,
      { scheduleId },
      {
        repeat: { pattern: cron, tz: tz ?? undefined, key: repeatKey },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    );
  }

  async removeCron(scheduleId: string) {
    if (!this.exec) return;
    const repeats = await this.exec.getRepeatableJobs();
    for (const r of repeats) {
      if (r.id === `schedule:${scheduleId}` || r.name === `schedule:${scheduleId}`) {
        await this.exec.removeRepeatableByKey(r.key).catch(() => {});
      }
    }
  }

  /** Enqueue an ad-hoc execution (used by "run now" + retries). */
  async enqueueExec(scheduleId: string) {
    if (!this.exec) return;
    await this.exec.add(`manual:${scheduleId}`, { scheduleId }, { attempts: 1 });
  }

  async enqueueEmail(data: EmailJobData) {
    if (!this.email) return;
    await this.email.add('send', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    });
  }
}
