import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import type Redis from 'ioredis';
import { Role, ScheduledRunStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionsService } from '../connections/connections.service';
import { AppConfigService } from '../config/config.service';
import { QueuesService } from './queues.service';
import { EmailService } from './email.service';
import {
  QUEUE_EMAIL,
  QUEUE_EXEC,
  REDIS_CLIENT,
  type EmailJobData,
  type ExecJobData,
} from './scheduler.constants';

const MAX_PREVIEW_ROWS = 50;
const MAX_EMAIL_ROWS = 10_000;

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(','));
  return lines.join('\n');
}

@Injectable()
export class SchedulerWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SchedulerWorker.name);
  private execWorker: Worker<ExecJobData> | null = null;
  private emailWorker: Worker<EmailJobData> | null = null;

  constructor(
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly email: EmailService,
    private readonly queues: QueuesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  async onModuleInit() {
    if (!this.redis) return;

    this.execWorker = new Worker<ExecJobData>(
      QUEUE_EXEC,
      (job) => this.runExec(job),
      {
        connection: this.redis,
        concurrency: this.cfg.schedulerConcurrency,
      },
    );
    this.execWorker.on('failed', (job, err) => {
      this.log.warn(`Exec failed (${job?.id}): ${err.message}`);
    });

    this.emailWorker = new Worker<EmailJobData>(
      QUEUE_EMAIL,
      (job) => this.sendEmail(job),
      { connection: this.redis, concurrency: 2 },
    );
    this.emailWorker.on('failed', (job, err) => {
      this.log.warn(`Email failed (${job?.id}): ${err.message}`);
    });

    this.log.log('bullmq workers started');

    // Leader election for the one-time repeatable-job registrar. Any pod can
    // process jobs (bullmq hands each job to exactly one worker), but only
    // one pod should re-register existing schedules at startup — otherwise we
    // hammer Redis with redundant upserts whenever the deployment scales.
    // SET NX EX acquires a 30-second lease; non-leaders skip. We don't need
    // to renew it: by the end of the 30s window, registration is done.
    const LOCK_KEY = 'dbs:scheduler:registrar-lock';
    const gotLock = await this.redis.set(LOCK_KEY, '1', 'EX', 30, 'NX');
    if (gotLock === 'OK') {
      this.log.log('Registering existing schedules (acquired registrar lock)');
      void this.registerAllSchedules().catch((err) =>
        this.log.warn(`Schedule registration failed: ${(err as Error).message}`),
      );
    } else {
      this.log.log('Another pod is registering schedules; skipping');
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.execWorker?.close(), this.emailWorker?.close()]);
  }

  /** On leader-pod startup, re-register repeatable bullmq jobs for every
   *  enabled schedule. bullmq keys repeatable jobs by cron pattern so this
   *  is idempotent — a re-register just replaces the existing definition. */
  private async registerAllSchedules(): Promise<void> {
    const rows = await this.prisma.scheduledQuery.findMany({
      where: { enabled: true },
      select: { id: true, cron: true, timezone: true },
    });
    for (const r of rows) {
      try {
        await this.queues.upsertCron(r.id, r.cron, r.timezone);
      } catch (err) {
        this.log.warn(`upsertCron failed for ${r.id}: ${(err as Error).message}`);
      }
    }
    this.log.log(`Registered ${rows.length} schedule(s)`);
  }

  private async runExec(job: Job<ExecJobData>): Promise<void> {
    const { scheduleId } = job.data;
    const schedule = await this.prisma.scheduledQuery.findUnique({ where: { id: scheduleId } });
    if (!schedule) {
      this.log.warn(`Schedule ${scheduleId} not found, dropping job`);
      return;
    }
    if (!schedule.enabled) {
      this.log.log(`Schedule ${scheduleId} disabled, skipping`);
      return;
    }

    const run = await this.prisma.scheduledQueryRun.create({
      data: { scheduleId, status: ScheduledRunStatus.RUNNING },
    });
    const started = Date.now();

    try {
      // Schedules run with owner's role — OWNER implicitly, so all SQL is allowed.
      const drv = await this.connections.buildDriverForRole(schedule.connectionId, Role.OWNER);
      try {
        const timeoutMs = this.cfg.schedulerQueryTimeoutMs;
        const execPromise = drv.runRawQuery(schedule.sqlText);
        const result = await Promise.race([
          execPromise,
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`Query exceeded ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        const durationMs = Date.now() - started;
        const preview = rows.slice(0, MAX_PREVIEW_ROWS);

        await this.prisma.scheduledQueryRun.update({
          where: { id: run.id },
          data: {
            status: ScheduledRunStatus.SUCCESS,
            finishedAt: new Date(),
            rowCount: rows.length,
            durationMs,
            resultPreview: preview as unknown as Prisma.InputJsonValue,
          },
        });
        await this.prisma.scheduledQuery.update({
          where: { id: scheduleId },
          data: { lastRunAt: new Date(), lastStatus: ScheduledRunStatus.SUCCESS },
        });

        // Queue an email job — decoupling exec from email means SMTP flakiness
        // doesn't burn query-execution retries.
        const recipients = schedule.emailTo
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (recipients.length > 0 && this.email.enabled) {
          const csv = toCsv(rows.slice(0, MAX_EMAIL_ROWS));
          await this.queues.enqueueEmail({
            scheduleId,
            runId: run.id,
            to: recipients,
            subject: `[DB Studio] ${schedule.name} — ${rows.length} rows`,
            body:
              `Scheduled query "${schedule.name}" completed successfully.\n\n` +
              `Rows: ${rows.length}\n` +
              `Duration: ${durationMs}ms\n` +
              (rows.length > MAX_EMAIL_ROWS ? `Note: only first ${MAX_EMAIL_ROWS} rows attached.\n` : ''),
            csv,
            filename: `${schedule.name.replace(/[^a-z0-9-_]+/gi, '_')}.csv`,
          });
        }
      } finally {
        await drv.close().catch(() => {});
      }
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.scheduledQueryRun.update({
        where: { id: run.id },
        data: {
          status: ScheduledRunStatus.FAILED,
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          errorMessage: message.slice(0, 2000),
        },
      });
      await this.prisma.scheduledQuery.update({
        where: { id: scheduleId },
        data: { lastRunAt: new Date(), lastStatus: ScheduledRunStatus.FAILED },
      });
      throw err; // bullmq handles retry/backoff
    }
  }

  private async sendEmail(job: Job<EmailJobData>): Promise<void> {
    const { runId, to, subject, body, csv, filename } = job.data;
    try {
      await this.email.send({ to, subject, body, csv, filename });
      await this.prisma.scheduledQueryRun.update({
        where: { id: runId },
        data: { emailDelivered: true },
      });
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.scheduledQueryRun.update({
        where: { id: runId },
        data: { emailError: message.slice(0, 2000) },
      });
      throw err;
    }
  }
}
