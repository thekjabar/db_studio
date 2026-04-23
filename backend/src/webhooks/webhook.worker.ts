import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import type Redis from 'ioredis';
import { createHmac } from 'crypto';
import { WebhookDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';
import { QUEUE_WEBHOOKS, type WebhookJobData } from './webhook.queue';

const PURPOSE = (id: string) => `webhook:${id}`;
const TIMEOUT_MS = 10_000;

@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WebhookWorker.name);
  private worker: Worker<WebhookJobData> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  onModuleInit() {
    if (!this.redis) return;
    this.worker = new Worker<WebhookJobData>(QUEUE_WEBHOOKS, (job) => this.deliver(job), {
      connection: this.redis,
      concurrency: 4,
    });
    this.worker.on('failed', (job, err) => {
      this.log.warn(`webhook delivery failed (job=${job?.id}): ${err.message}`);
    });
    this.log.log('Webhook worker started');
  }

  async onModuleDestroy() {
    await this.worker?.close().catch(() => {});
  }

  private async deliver(job: Job<WebhookJobData>): Promise<void> {
    const { webhookId, event, payload } = job.data;
    const w = await this.prisma.webhook.findUnique({ where: { id: webhookId } });
    if (!w) {
      this.log.warn(`webhook ${webhookId} not found, dropping`);
      return;
    }
    if (!w.enabled) {
      this.log.log(`webhook ${webhookId} disabled, skipping`);
      return;
    }

    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId,
        event,
        attempt: job.attemptsMade + 1,
        status: WebhookDeliveryStatus.PENDING,
      },
    });
    const started = Date.now();

    try {
      const body = JSON.stringify(payload);
      const secret = this.crypto.decrypt(w.secretCt, PURPOSE(w.id));
      const signature = createHmac('sha256', secret).update(body).digest('hex');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(w.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'DBStudio-Webhook/1.0',
            'X-DBStudio-Event': event,
            'X-DBStudio-Delivery': delivery.id,
            'X-DBStudio-Signature': `sha256=${signature}`,
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      const text = (await response.text().catch(() => '')).slice(0, 2_000);
      const ok = response.ok;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: ok ? WebhookDeliveryStatus.SUCCESS : WebhookDeliveryStatus.FAILED,
          httpStatus: response.status,
          responseBody: text || null,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhookId },
        data: {
          lastFiredAt: new Date(),
          lastStatus: ok ? WebhookDeliveryStatus.SUCCESS : WebhookDeliveryStatus.FAILED,
        },
      });
      if (!ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.FAILED,
          errorMessage: message.slice(0, 2_000),
          finishedAt: new Date(),
          durationMs: Date.now() - started,
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhookId },
        data: { lastFiredAt: new Date(), lastStatus: WebhookDeliveryStatus.FAILED },
      });
      throw err; // bullmq handles retry/backoff
    }
  }
}
