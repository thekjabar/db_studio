import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditInput {
  userId?: string | null;
  connectionId?: string | null;
  action: keyof typeof AuditAction | AuditAction;
  sqlText?: string | null;
  affectedRows?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Free-form audit metadata. Prisma's InputJsonValue type is strict about index
   * signatures — real callsites pass Record<string, unknown>, so widen to unknown
   * and cast at the Prisma boundary.
   */
  metadata?: unknown;
}

const MAX_SQL = 10_000;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(input: AuditInput): Promise<void> {
    try {
      const sql =
        input.sqlText && input.sqlText.length > MAX_SQL
          ? input.sqlText.slice(0, MAX_SQL) + '... [truncated]'
          : input.sqlText ?? null;
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId ?? null,
          connectionId: input.connectionId ?? null,
          action: input.action as AuditAction,
          sqlText: sql,
          affectedRows: input.affectedRows ?? null,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      // Never fail a user action because auditing failed; just log.
      this.logger.error('Audit write failed', err as Error);
    }
  }

  async findById(id: string) {
    return this.prisma.auditLog.findUnique({ where: { id } });
  }

  /**
   * Team-wide query history for a connection. Narrower than the full audit
   * list — only QUERY_RUN / SCHEMA_CHANGE actions, with optional filters by
   * user and time range. Anchored by the composite (connectionId, createdAt, id)
   * index so it scales with history volume.
   */
  async listQueryHistory(
    connectionId: string,
    opts: {
      limit?: number;
      cursor?: string;
      userId?: string;
      sinceMs?: number;
      actions?: ('QUERY_RUN' | 'SCHEMA_CHANGE')[];
      search?: string;
    } = {},
  ) {
    const take = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const actions = opts.actions && opts.actions.length > 0
      ? opts.actions
      : (['QUERY_RUN', 'SCHEMA_CHANGE'] as const);

    const filters: Prisma.AuditLogWhereInput = {
      connectionId,
      action: { in: actions as unknown as AuditAction[] },
    };
    if (opts.userId) filters.userId = opts.userId;
    if (opts.sinceMs && opts.sinceMs > 0) {
      filters.createdAt = { gte: new Date(Date.now() - opts.sinceMs) };
    }
    if (opts.search && opts.search.trim()) {
      // Case-insensitive substring on the SQL body. Limited to 200 chars so a
      // huge paste doesn't tank the query.
      filters.sqlText = { contains: opts.search.slice(0, 200), mode: 'insensitive' };
    }

    let where: Prisma.AuditLogWhereInput = filters;
    if (opts.cursor) {
      const pipe = opts.cursor.indexOf('|');
      if (pipe > 0) {
        const createdAt = new Date(opts.cursor.slice(0, pipe));
        const id = opts.cursor.slice(pipe + 1);
        if (!Number.isNaN(createdAt.getTime())) {
          where = {
            AND: [
              filters,
              {
                OR: [
                  { createdAt: { lt: createdAt } },
                  { createdAt, id: { lt: id } },
                ],
              },
            ],
          };
        }
      }
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: { user: { select: { email: true, displayName: true } } },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((r) => ({
        id: r.id,
        userId: r.userId,
        user: r.user ? (r.user.displayName || r.user.email) : null,
        action: r.action,
        sqlText: r.sqlText,
        affectedRows: r.affectedRows,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore
        ? `${items[items.length - 1].createdAt.toISOString()}|${items[items.length - 1].id}`
        : undefined,
    };
  }

  async listForConnection(connectionId: string, limit = 100, cursor?: string) {
    const take = Math.min(Math.max(1, limit), 500);

    // Keyset pagination instead of Prisma's `cursor` (which uses id alone and
    // doesn't match the createdAt ordering, degenerating to a full scan at
    // depth). Cursor shape: "<iso createdAt>|<id>" — matches the composite
    // index on (connectionId, createdAt DESC, id DESC).
    let where: Record<string, unknown> = { connectionId };
    if (cursor) {
      const pipe = cursor.indexOf('|');
      if (pipe > 0) {
        const createdAt = new Date(cursor.slice(0, pipe));
        const id = cursor.slice(pipe + 1);
        if (!Number.isNaN(createdAt.getTime())) {
          where = {
            connectionId,
            OR: [
              { createdAt: { lt: createdAt } },
              { createdAt, id: { lt: id } },
            ],
          };
        }
      }
    }

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      include: {
        user: { select: { email: true, displayName: true } },
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((r) => ({
        id: r.id,
        userId: r.userId,
        user: r.user ? (r.user.displayName || r.user.email) : null,
        connectionId: r.connectionId,
        action: r.action,
        sqlText: r.sqlText,
        affectedRows: r.affectedRows,
        ip: r.ip,
        userAgent: r.userAgent,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore
        ? `${items[items.length - 1].createdAt.toISOString()}|${items[items.length - 1].id}`
        : undefined,
    };
  }
}
