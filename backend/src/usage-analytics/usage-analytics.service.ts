import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-user / per-workspace aggregations for the operator analytics UI.
 * All derived from existing audit/usage tables — no new write-path cost.
 *
 * Classification:
 *   active   = logged in within last 7 days
 *   at-risk  = no login in 14 days AND prior logins exist
 *   dormant  = no login in 30+ days
 */
@Injectable()
export class UsageAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async classifyUser(userId: string) {
    const last = await this.prisma.auditLog.findFirst({
      where: { userId, action: 'LOGIN' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const now = Date.now();
    if (!last) return 'never_logged_in' as const;
    const days = Math.floor((now - last.createdAt.getTime()) / 86_400_000);
    if (days <= 7) return 'active' as const;
    if (days <= 14) return 'at_risk' as const;
    return 'dormant' as const;
  }

  async userSeries(userId: string, days = 30) {
    const since = new Date(Date.now() - days * 864e5);
    const [logins, queries, aiDays] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { userId, action: 'LOGIN', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.auditLog.findMany({
        where: { userId, action: 'QUERY_RUN', createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      this.prisma.aiUsageDay.findMany({
        where: { userId, day: { gte: since.toISOString().slice(0, 10) } },
        select: { day: true, callsUsed: true },
      }),
    ]);

    const buckets = new Map<string, { day: string; logins: number; queries: number; aiCalls: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      buckets.set(d, { day: d, logins: 0, queries: 0, aiCalls: 0 });
    }
    for (const r of logins) {
      const d = r.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(d);
      if (b) b.logins += 1;
    }
    for (const r of queries) {
      const d = r.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(d);
      if (b) b.queries += 1;
    }
    for (const r of aiDays) {
      const b = buckets.get(r.day);
      if (b) b.aiCalls += r.callsUsed;
    }
    return {
      classification: await this.classifyUser(userId),
      series: Array.from(buckets.values()),
    };
  }

  async platformSeries(days = 30) {
    const since = new Date(Date.now() - days * 864e5);
    const signups = await this.prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true },
    });
    const logins = await this.prisma.auditLog.findMany({
      where: { action: 'LOGIN', createdAt: { gte: since } },
      select: { createdAt: true, userId: true },
    });
    const buckets = new Map<string, { day: string; signups: number; logins: number; uniqueUsers: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      buckets.set(d, { day: d, signups: 0, logins: 0, uniqueUsers: 0 });
    }
    const uniquePerDay = new Map<string, Set<string>>();
    for (const r of signups) {
      const d = r.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(d);
      if (b) b.signups += 1;
    }
    for (const r of logins) {
      const d = r.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(d);
      if (b) {
        b.logins += 1;
        if (r.userId) {
          if (!uniquePerDay.has(d)) uniquePerDay.set(d, new Set());
          uniquePerDay.get(d)!.add(r.userId);
        }
      }
    }
    for (const [d, set] of uniquePerDay) {
      const b = buckets.get(d);
      if (b) b.uniqueUsers = set.size;
    }
    return Array.from(buckets.values());
  }

  /** Support view: recent failures for a user (logins, quota blocks, webhooks). */
  async supportTimeline(userId: string, limit = 100) {
    const [failedLogins, suspendedLogins, abuseEvents] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: { userId, action: 'LOGIN_FAILED' },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.auditLog.findMany({
        where: { userId, action: 'LOGIN_SUSPENDED' },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.abuseEvent.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    ]);
    return {
      failedLogins,
      suspendedLogins,
      abuseEvents,
    };
  }
}
