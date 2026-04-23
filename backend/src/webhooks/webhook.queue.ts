import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';
import { WebhookEvent } from '@prisma/client';

export const QUEUE_WEBHOOKS = 'webhooks-deliver';

export interface WebhookJobData {
  webhookId: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
}

@Injectable()
export class WebhookQueue implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebhookQueue.name);
  private queue: Queue<WebhookJobData> | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  onModuleInit() {
    if (!this.redis) {
      this.log.log('Webhook queue disabled (no Redis)');
      return;
    }
    this.queue = new Queue<WebhookJobData>(QUEUE_WEBHOOKS, { connection: this.redis });
    this.log.log('Webhook queue ready');
  }

  async onModuleDestroy() {
    await this.queue?.close().catch(() => {});
  }

  /**
   * Enqueue a delivery attempt. bullmq retries + exponential backoff so the
   * caller doesn't have to worry about transient failures on the target URL.
   */
  async enqueueFromService(data: WebhookJobData): Promise<void> {
    if (!this.queue) return;
    await this.queue.add('deliver', data, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 200 },
    });
  }
}
