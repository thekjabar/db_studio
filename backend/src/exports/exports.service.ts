import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { ColumnMasksService } from '../connections/column-masks.service';
import { SsrfGuardService } from '../common/ssrf-guard.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../scheduler/email.service';

const MAX_EXPORT_ROWS = 50_000;
const MAX_SLACK_PREVIEW_ROWS = 20;

export type ExportTarget = 'email' | 'slack' | 'webhook';

export interface ExportRequest {
  connectionId: string;
  sql: string;
  target: ExportTarget;
  /** email: comma-split recipient list; slack: webhook URL; webhook: https URL */
  to: string;
  name?: string;
}

export function toCsv(rows: Record<string, unknown>[]): string {
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

function previewMarkdownTable(rows: Record<string, unknown>[], limit: number): string {
  if (rows.length === 0) return '_(no rows)_';
  const sample = rows.slice(0, limit);
  const headers = Object.keys(sample[0]);
  const fmt = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  };
  const out: string[] = [];
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  for (const r of sample) out.push('| ' + headers.map((h) => fmt(r[h])).join(' | ') + ' |');
  if (rows.length > limit) out.push(`_…and ${rows.length - limit} more_`);
  return out.join('\n');
}

@Injectable()
export class ExportsService {
  private readonly log = new Logger(ExportsService.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly masks: ColumnMasksService,
    private readonly ssrf: SsrfGuardService,
  ) {}

  async run(
    userId: string,
    role: Role,
    req: ExportRequest,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ rowCount: number; delivered: true }> {
    if (!req.sql.trim()) throw new BadRequestException('SQL is required');
    if (!req.to.trim()) throw new BadRequestException('Destination is required');

    if (req.target === 'email' && !this.email.enabled) {
      throw new ServiceUnavailableException('Email is not configured on this server');
    }
    if (req.target === 'slack' && !/^https:\/\/hooks\.slack\.com\//.test(req.to)) {
      throw new BadRequestException('Slack target requires a hooks.slack.com webhook URL');
    }
    if (req.target === 'webhook' && !/^https:\/\//.test(req.to)) {
      throw new BadRequestException('Webhook target requires an https:// URL');
    }
    // SECURITY: https alone doesn't stop this pointing at our own internals —
    // and a non-2xx reply reflects 200 chars of the internal response body back
    // in the error message.
    if (req.target === 'webhook') {
      await this.ssrf.assertPublicUrl(req.to, 'Webhook target');
    }

    const drv = await this.connections.buildDriverForRole(req.connectionId, role);
    const started = Date.now();
    let rows: Record<string, unknown>[] = [];
    try {
      const res = await drv.runRawQuery(req.sql);
      rows = ((res.rows ?? []) as Record<string, unknown>[]).slice(0, MAX_EXPORT_ROWS);
      // SECURITY: apply this user's column masks to the export too, so a masked
      // column can't be exfiltrated via email/slack/webhook export. Same
      // conservative name-match approach as the query path.
      const maskedNames = await this.masks.maskedColumnNames(userId, req.connectionId);
      if (maskedNames.size > 0) this.masks.applyMasks(rows, maskedNames);
    } finally {
      await drv.close().catch(() => {});
    }

    const title = req.name?.trim() || 'Query result';
    const csv = toCsv(rows);

    switch (req.target) {
      case 'email':
        await this.sendEmail(req.to, title, rows, csv);
        break;
      case 'slack':
        await this.sendSlack(req.to, title, rows, req.sql);
        break;
      case 'webhook':
        await this.sendWebhook(req.to, title, rows, req.sql);
        break;
    }

    await this.audit.log({
      userId,
      connectionId: req.connectionId,
      action: 'QUERY_RUN',
      sqlText: req.sql,
      affectedRows: rows.length,
      metadata: {
        export: {
          target: req.target,
          rowCount: rows.length,
          durationMs: Date.now() - started,
        },
      },
      ...meta,
    });

    return { rowCount: rows.length, delivered: true };
  }

  private async sendEmail(
    to: string,
    title: string,
    rows: Record<string, unknown>[],
    csv: string,
  ): Promise<void> {
    const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
    if (recipients.length === 0) throw new BadRequestException('At least one email recipient required');
    await this.email.send({
      to: recipients,
      subject: `[Query Schema] ${title} — ${rows.length} rows`,
      body: `${title}\n\nRows: ${rows.length}\n\nSee attachment for the full CSV.`,
      csv,
      filename: `${title.replace(/[^a-z0-9-_]+/gi, '_')}.csv`,
    });
  }

  private async sendSlack(
    webhook: string,
    title: string,
    rows: Record<string, unknown>[],
    sql: string,
  ): Promise<void> {
    const preview = previewMarkdownTable(rows, MAX_SLACK_PREVIEW_ROWS);
    const body = {
      text: `*${title}* — ${rows.length} rows`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}* — ${rows.length} rows` } },
        { type: 'section', text: { type: 'mrkdwn', text: '```\n' + sql.slice(0, 500) + '\n```' } },
        { type: 'section', text: { type: 'mrkdwn', text: preview.slice(0, 2500) } },
      ],
    };
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BadRequestException(`Slack webhook returned ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  private async sendWebhook(
    url: string,
    title: string,
    rows: Record<string, unknown>[],
    sql: string,
  ): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, sql, rowCount: rows.length, rows }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BadRequestException(`Webhook returned ${res.status}: ${text.slice(0, 200)}`);
    }
    this.log.debug(`Webhook delivered to ${url} (${rows.length} rows)`);
  }
}
