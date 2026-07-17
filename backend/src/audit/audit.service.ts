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

/**
 * Recursively null any value whose key matches a masked column. Audit metadata
 * is free-form JSON (before/after row snapshots, export summaries), so we walk
 * the whole structure rather than assuming a shape.
 */
function maskMetadata(value: unknown, masked: Set<string>): unknown {
  if (masked.size === 0 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => maskMetadata(v, masked));
  if (typeof value === "object") {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      out[k] = masked.has(k) ? null : maskMetadata(out[k], masked);
    }
    return out;
  }
  return value;
}

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
    /** Reader — their column masks are applied to the metadata snapshots. */
    viewerId: string,
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
    const masked = await this.maskedColumnsFor(viewerId, connectionId);
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
        metadata: maskMetadata(r.metadata, masked),
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore
        ? `${items[items.length - 1].createdAt.toISOString()}|${items[items.length - 1].id}`
        : undefined,
    };
  }

  /** Masked column names for a reader on a connection (empty for owners). */
  private async maskedColumnsFor(userId: string, connectionId: string): Promise<Set<string>> {
    const rows = await this.prisma.columnMask.findMany({
      where: { connectionId, userId },
      select: { columnName: true },
    });
    return new Set(rows.map((r) => r.columnName));
  }

  /**
   * SECURITY: audit `metadata` carries before/after row snapshots for row edits,
   * so it must respect the reader's column masks — otherwise a masked VIEWER
   * could read masked values straight out of the history. `viewerId` is
   * required; masks are resolved via prisma rather than ColumnMasksService to
   * avoid an Audit<->Connections module cycle.
   */
  async listForConnection(connectionId: string, viewerId: string, limit = 100, cursor?: string) {
    const take = Math.min(Math.max(1, limit), 500);
    const masked = await this.maskedColumnsFor(viewerId, connectionId);

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
        metadata: maskMetadata(r.metadata, masked),
        createdAt: r.createdAt,
      })),
      nextCursor: hasMore
        ? `${items[items.length - 1].createdAt.toISOString()}|${items[items.length - 1].id}`
        : undefined,
    };
  }

  /**
   * CSV export of a connection's audit log for the customer's own records
   * (SOC2 / compliance). Capped at 50k rows to bound memory.
   */
  async exportConnectionCsv(connectionId: string): Promise<string> {
    const rows = await this.prisma.auditLog.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
      take: 50_000,
      include: { user: { select: { email: true, displayName: true } } },
    });
    const esc = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['createdAt', 'user', 'action', 'affectedRows', 'ip', 'sqlText'].join(',');
    const lines = rows.map((r) =>
      [
        r.createdAt.toISOString(),
        esc(r.user ? r.user.displayName || r.user.email : ''),
        esc(r.action),
        esc(r.affectedRows ?? ''),
        esc(r.ip ?? ''),
        esc(r.sqlText ?? ''),
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }
}
