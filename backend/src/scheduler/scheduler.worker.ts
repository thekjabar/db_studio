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
import { evaluateAlert, type AlertCondition } from './alert-evaluator';

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

// How many result rows to render inline in the HTML email body. The full set
// is still attached as CSV; this is just a readable preview.
const EMAIL_PREVIEW_ROWS = 50;
const EMAIL_PREVIEW_COLS = 12;
const EMAIL_CELL_MAX = 120;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > EMAIL_CELL_MAX ? s.slice(0, EMAIL_CELL_MAX) + '…' : s;
}

/**
 * Build a rich HTML body with an inline preview table of the query result, so
 * recipients see the data at a glance without opening the CSV attachment.
 * Inline styles only (email clients strip <style>/external CSS).
 */
function buildEmailHtml(input: {
  name: string;
  rows: Record<string, unknown>[];
  durationMs: number;
  isAlert: boolean;
  alertSummary: string | null;
}): string {
  const { name, rows, durationMs, isAlert, alertSummary } = input;
  const headers = rows.length ? Object.keys(rows[0]).slice(0, EMAIL_PREVIEW_COLS) : [];
  const previewRows = rows.slice(0, EMAIL_PREVIEW_ROWS);
  const extraCols = rows.length && Object.keys(rows[0]).length > EMAIL_PREVIEW_COLS;

  const headerCells = headers
    .map(
      (h) =>
        `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #e5e7eb;font-size:12px;color:#374151;white-space:nowrap;">${escapeHtml(h)}</th>`,
    )
    .join('');

  const bodyRows = previewRows
    .map((r, i) => {
      const bg = i % 2 ? '#f9fafb' : '#ffffff';
      const cells = headers
        .map(
          (h) =>
            `<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#111827;white-space:nowrap;">${escapeHtml(cellText(r[h]))}</td>`,
        )
        .join('');
      return `<tr style="background:${bg};">${cells}</tr>`;
    })
    .join('');

  const table = rows.length
    ? `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
         <thead><tr>${headerCells}</tr></thead>
         <tbody>${bodyRows}</tbody>
       </table>`
    : `<p style="color:#6b7280;font-style:italic;">Query returned no rows.</p>`;

  const note: string[] = [];
  if (rows.length > EMAIL_PREVIEW_ROWS)
    note.push(`Showing first ${EMAIL_PREVIEW_ROWS} of ${rows.length} rows — full results in the attached CSV.`);
  if (extraCols) note.push(`Some columns hidden in this preview; the CSV has them all.`);

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:760px;">
    <div style="margin-bottom:12px;">
      <div style="font-size:16px;font-weight:600;">${escapeHtml(name)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">
        ${isAlert ? `🔔 Alert fired — ${escapeHtml(alertSummary ?? '')} · ` : ''}${rows.length} row${rows.length === 1 ? '' : 's'} · ${durationMs}ms
      </div>
    </div>
    ${table}
    ${note.length ? `<p style="font-size:12px;color:#6b7280;margin-top:10px;">${note.map(escapeHtml).join(' ')}</p>` : ''}
    <p style="font-size:11px;color:#9ca3af;margin-top:16px;border-top:1px solid #f1f5f9;padding-top:10px;">
      Sent by DB Studio · scheduled query
    </p>
  </div>`;
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
        // Scope unqualified table names to the chosen schema. The driver sets
        // search_path on the SAME pooled client before running the query —
        // passing it as an option (not concatenated) so pg returns the
        // SELECT's rows, not the SET's empty result.
        const execPromise = drv.runRawQuery(
          schedule.sqlText,
          [],
          schedule.schemaName ? { searchPath: schedule.schemaName } : undefined,
        );
        const result = await Promise.race([
          execPromise,
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`Query exceeded ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        const rows = (result.rows ?? []) as Record<string, unknown>[];
        const durationMs = Date.now() - started;
        const preview = rows.slice(0, MAX_PREVIEW_ROWS);

        // Alert evaluation: if an alertCondition is set, we only notify on a
        // positive match (and respect cooldown). With no condition the
        // schedule behaves as a classic "mail me the result" job.
        const condition = (schedule.alertCondition as AlertCondition | null | undefined) ?? null;
        const outcome = evaluateAlert(condition, rows);
        const inCooldown =
          !!condition &&
          outcome.triggered &&
          schedule.lastAlertedAt != null &&
          schedule.alertCooldownMin != null &&
          Date.now() - schedule.lastAlertedAt.getTime() < schedule.alertCooldownMin * 60_000;

        await this.prisma.scheduledQueryRun.update({
          where: { id: run.id },
          data: {
            status: ScheduledRunStatus.SUCCESS,
            finishedAt: new Date(),
            rowCount: rows.length,
            durationMs,
            resultPreview: preview as unknown as Prisma.InputJsonValue,
            alertTriggered: !!condition && outcome.triggered,
            alertSummary: condition ? outcome.summary : null,
          },
        });

        // Only update lastAlertedAt when we actually fired a notification —
        // otherwise cooldown math gets broken when a flap-n-recover burst
        // triggers condition but stays inside the cooldown window.
        const willNotify = !condition || (outcome.triggered && !inCooldown);
        await this.prisma.scheduledQuery.update({
          where: { id: scheduleId },
          data: {
            lastRunAt: new Date(),
            lastStatus: ScheduledRunStatus.SUCCESS,
            ...(willNotify && condition ? { lastAlertedAt: new Date() } : {}),
          },
        });

        if (!willNotify) {
          // Alert condition unmet (or suppressed) — silent run. The run row is
          // still recorded so users can see the recent-history chart.
          return;
        }

        // Dispatch notifications. Email uses the existing bullmq email queue.
        // Slack posts inline — it's a single HTTPS call, not worth a separate
        // queue. If Slack fails we log and continue so it doesn't prevent the
        // email path from firing.
        const recipients = schedule.emailTo
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const subjectPrefix = condition ? '[DB Studio alert]' : '[DB Studio]';
        const subject = condition
          ? `${subjectPrefix} ${schedule.name} — ${outcome.summary}`
          : `${subjectPrefix} ${schedule.name} — ${rows.length} rows`;
        const body = condition
          ? `Alert "${schedule.name}" fired.\n\nCondition matched: ${outcome.summary}\nRows: ${rows.length}\nDuration: ${durationMs}ms\n`
          : `Scheduled query "${schedule.name}" completed successfully.\n\nRows: ${rows.length}\nDuration: ${durationMs}ms\n` +
            (rows.length > MAX_EMAIL_ROWS ? `Note: only first ${MAX_EMAIL_ROWS} rows attached.\n` : '');

        if (recipients.length > 0 && this.email.enabled) {
          const csv = toCsv(rows.slice(0, MAX_EMAIL_ROWS));
          const html = buildEmailHtml({
            name: schedule.name,
            rows,
            durationMs,
            isAlert: !!condition,
            alertSummary: condition ? outcome.summary : null,
          });
          await this.queues.enqueueEmail({
            scheduleId,
            runId: run.id,
            to: recipients,
            subject,
            body,
            html,
            csv,
            filename: `${schedule.name.replace(/[^a-z0-9-_]+/gi, '_')}.csv`,
          });
        }
        if (schedule.slackWebhook) {
          await this.postSlack(schedule.slackWebhook, schedule.name, body, rows).catch((err) => {
            this.log.warn(`Slack post failed for ${scheduleId}: ${(err as Error).message}`);
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
    const { runId, to, subject, body, html, csv, filename } = job.data;
    try {
      await this.email.send({ to, subject, body, html, csv, filename });
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

  /** POST a short markdown summary to a Slack incoming webhook. */
  private async postSlack(
    webhook: string,
    name: string,
    body: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    // Preview a few rows as a compact markdown block so responders have
    // context without clicking through. Cap at 10 rows to stay under
    // Slack's 40kb message size.
    const preview = rows.slice(0, 10);
    const sample = preview.length
      ? '```\n' +
        preview
          .map((r) => JSON.stringify(r))
          .join('\n')
          .slice(0, 2500) +
        '\n```'
      : '_(no rows)_';
    const payload = {
      text: name,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: name } },
        { type: 'section', text: { type: 'mrkdwn', text: body } },
        { type: 'section', text: { type: 'mrkdwn', text: sample } },
      ],
    };
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Slack ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
