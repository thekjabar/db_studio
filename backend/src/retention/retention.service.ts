import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Configurable retention. Operators set `keepDays` per resource; a
 * nightly job deletes rows older than that. Default policies get
 * auto-seeded on first read so a fresh install has sane caps.
 *
 * `resource` values we know how to prune:
 *   audit_log       — AuditLog.createdAt
 *   query_history   — AuditLog where action='QUERY_RUN' (same table, filtered)
 *   ai_usage_day    — AiUsageDay.day (string YYYY-MM-DD)
 *   slow_query_log  — SlowQueryLog.createdAt
 *   abuse_event     — AbuseEvent.createdAt
 *   feedback        — Feedback where status='CLOSED'
 */
@Injectable()
export class RetentionService {
  private readonly log = new Logger(RetentionService.name);
  private readonly defaults: Record<string, number> = {
    audit_log: 365,
    query_history: 180,
    ai_usage_day: 90,
    slow_query_log: 90,
    abuse_event: 90,
    feedback: 730,
  };

  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.retentionPolicy.findMany({ orderBy: { resource: 'asc' } });
    const known = new Set(rows.map((r) => r.resource));
    // Seed any default resource that's missing so the UI shows all dials.
    for (const [res, days] of Object.entries(this.defaults)) {
      if (!known.has(res)) {
        await this.prisma.retentionPolicy.upsert({
          where: { resource: res },
          create: { resource: res, keepDays: days },
          update: {},
        });
      }
    }
    return this.prisma.retentionPolicy.findMany({ orderBy: { resource: 'asc' } });
  }

  async update(operatorId: string, resource: string, keepDays: number) {
    if (!(resource in this.defaults)) {
      throw new Error(`Unknown retention resource: ${resource}`);
    }
    return this.prisma.retentionPolicy.upsert({
      where: { resource },
      create: { resource, keepDays, updatedByOperatorId: operatorId },
      update: { keepDays, updatedByOperatorId: operatorId },
    });
  }

  /** One sweep across all policies. Runs on a cron or operator-triggered. */
  async sweep(): Promise<Record<string, number>> {
    const policies = await this.list();
    const out: Record<string, number> = {};
    for (const p of policies) {
      const cutoff = new Date(Date.now() - p.keepDays * 864e5);
      let deleted = 0;
      try {
        switch (p.resource) {
          case 'audit_log':
            deleted = (await this.prisma.auditLog.deleteMany({
              where: { createdAt: { lt: cutoff }, action: { not: 'QUERY_RUN' } },
            })).count;
            break;
          case 'query_history':
            deleted = (await this.prisma.auditLog.deleteMany({
              where: { createdAt: { lt: cutoff }, action: 'QUERY_RUN' },
            })).count;
            break;
          case 'ai_usage_day':
            deleted = (await this.prisma.aiUsageDay.deleteMany({
              where: { day: { lt: cutoff.toISOString().slice(0, 10) } },
            })).count;
            break;
          case 'slow_query_log':
            deleted = (await this.prisma.slowQueryLog.deleteMany({
              where: { createdAt: { lt: cutoff } },
            })).count;
            break;
          case 'abuse_event':
            deleted = (await this.prisma.abuseEvent.deleteMany({
              where: { createdAt: { lt: cutoff } },
            })).count;
            break;
          case 'feedback':
            deleted = (await this.prisma.feedback.deleteMany({
              where: { createdAt: { lt: cutoff }, status: 'CLOSED' },
            })).count;
            break;
        }
      } catch (e) {
        this.log.warn(`Retention sweep failed for ${p.resource}: ${(e as Error).message}`);
      }
      await this.prisma.retentionPolicy.update({
        where: { resource: p.resource },
        data: { lastRunAt: new Date(), lastRunRowsDeleted: deleted },
      });
      out[p.resource] = deleted;
    }
    return out;
  }
}
