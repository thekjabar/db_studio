import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';

/**
 * Aggregations for the /admin dashboard. All queries run against the
 * app's own Postgres (not user connections) and are intentionally cheap:
 * counts, groupbys against indexed columns, short time windows.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /** High-level counters. Cheap enough to call on every dashboard load. */
  async overview() {
    const [
      users,
      admins,
      workspaces,
      connections,
      scheduled,
      webhooks,
      apiKeys,
      failedLogins24h,
      signups24h,
      activeUsers24h,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isAdmin: true } }),
      this.prisma.workspace.count(),
      this.prisma.connection.count(),
      this.prisma.scheduledQuery.count({ where: { enabled: true } }),
      this.prisma.webhook.count({ where: { enabled: true } }),
      this.prisma.apiKey.count({ where: { revokedAt: null } }),
      this.prisma.auditLog.count({
        where: { action: 'LOGIN_FAILED', createdAt: { gte: since(24 * 60 * 60 * 1000) } },
      }),
      this.prisma.auditLog.count({
        where: { action: 'SIGNUP', createdAt: { gte: since(24 * 60 * 60 * 1000) } },
      }),
      this.prisma.auditLog
        .findMany({
          where: { createdAt: { gte: since(24 * 60 * 60 * 1000) }, userId: { not: null } },
          distinct: ['userId'],
          select: { userId: true },
        })
        .then((rs) => rs.length),
    ]);

    return {
      users,
      admins,
      workspaces,
      connections,
      scheduledQueriesEnabled: scheduled,
      webhooksEnabled: webhooks,
      apiKeysActive: apiKeys,
      last24h: {
        failedLogins: failedLogins24h,
        signups: signups24h,
        activeUsers: activeUsers24h,
      },
    };
  }

  /** Query volume, grouped by hour for the last 24h. */
  async queryVolume24h(): Promise<{ hour: string; queries: number; schemaChanges: number }[]> {
    // Postgres date_trunc keeps the SQL small and index-friendly.
    const rows = await this.prisma.$queryRaw<
      { hour: Date; action: string; count: bigint }[]
    >`
      SELECT date_trunc('hour', "createdAt") AS hour, "action", COUNT(*)::bigint AS count
      FROM "AuditLog"
      WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
        AND "action" IN ('QUERY_RUN', 'SCHEMA_CHANGE')
      GROUP BY 1, 2
      ORDER BY 1 ASC
    `;
    const byHour = new Map<string, { queries: number; schemaChanges: number }>();
    for (const r of rows) {
      const key = r.hour.toISOString();
      const entry = byHour.get(key) ?? { queries: 0, schemaChanges: 0 };
      if (r.action === 'QUERY_RUN') entry.queries += Number(r.count);
      else entry.schemaChanges += Number(r.count);
      byHour.set(key, entry);
    }
    return [...byHour.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([hour, v]) => ({ hour, ...v }));
  }

  /** Top connections by query volume in the last 7d. */
  async topConnections7d(limit = 10) {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['connectionId'],
      where: {
        action: 'QUERY_RUN',
        createdAt: { gte: since(7 * 24 * 60 * 60 * 1000) },
        connectionId: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { connectionId: 'desc' } },
      take: limit,
    });
    const ids = rows.map((r) => r.connectionId!).filter(Boolean);
    const conns = await this.prisma.connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, dialect: true },
    });
    const byId = new Map(conns.map((c) => [c.id, c]));
    return rows.map((r) => ({
      connectionId: r.connectionId!,
      name: byId.get(r.connectionId!)?.name ?? '(deleted)',
      dialect: byId.get(r.connectionId!)?.dialect ?? null,
      queries: r._count._all,
    }));
  }

  /** Top users by query volume in the last 7d. */
  async topUsers7d(limit = 10) {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['userId'],
      where: {
        action: 'QUERY_RUN',
        createdAt: { gte: since(7 * 24 * 60 * 60 * 1000) },
        userId: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: limit,
    });
    const ids = rows.map((r) => r.userId!).filter(Boolean);
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, email: true, displayName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({
      userId: r.userId!,
      email: byId.get(r.userId!)?.email ?? '(deleted)',
      displayName: byId.get(r.userId!)?.displayName ?? null,
      queries: r._count._all,
    }));
  }

  /** Paginated user list for the Users tab. */
  async listUsers(opts: { search?: string; limit?: number; cursor?: string }) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where = opts.search
      ? {
          OR: [
            { email: { contains: opts.search, mode: 'insensitive' as const } },
            { displayName: { contains: opts.search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      select: {
        id: true,
        email: true,
        displayName: true,
        isAdmin: true,
        emailVerifiedAt: true,
        oauthProvider: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : undefined,
    };
  }

  async setAdmin(userId: string, isAdmin: boolean) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { isAdmin },
      select: { id: true, email: true, isAdmin: true },
    });
  }

  /** Refresh live gauges the metrics endpoint exposes. Called on each /metrics
   *  hit so gauges reflect the current state without a background loop. */
  async refreshGauges(): Promise<void> {
    const [users, connections, scheduled, webhooks] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.connection.count(),
      this.prisma.scheduledQuery.count({ where: { enabled: true } }),
      this.prisma.webhook.count({ where: { enabled: true } }),
    ]);
    this.metrics.setGauge('dbstudio_users_total', users);
    this.metrics.setGauge('dbstudio_connections_total', connections);
    this.metrics.setGauge('dbstudio_scheduled_queries_enabled', scheduled);
    this.metrics.setGauge('dbstudio_webhooks_enabled', webhooks);
  }
}

function since(ms: number): Date {
  return new Date(Date.now() - ms);
}
