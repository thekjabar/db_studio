import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionsService } from '../connections/connections.service';
import { SqlClassifierService } from '../query/sql-classifier.service';
import { RbacService } from '../rbac/rbac.service';

/**
 * Read-only tokenized query shares. The owner shares a single SELECT; the
 * recipient opens a public page (no login) that re-runs it against the
 * owner's connection with a hard row cap and an optional expiry.
 *
 * Safety: only SELECT statements may be shared (validated by the classifier),
 * execution always uses a VIEWER-role driver (read-only, replica-preferred),
 * and the SQL is frozen at share time so the recipient can't mutate it.
 */
@Injectable()
export class SharedQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: ConnectionsService,
    private readonly classifier: SqlClassifierService,
    private readonly rbac: RbacService,
  ) {}

  async create(
    userId: string,
    input: { connectionId: string; sqlText: string; title?: string; expiresInDays?: number; rowLimit?: number },
  ) {
    // Only members who can already read the connection may share from it.
    await this.rbac.require(userId, input.connectionId, Role.VIEWER);

    const conn = await this.connections.get(input.connectionId);
    const cls = this.classifier.classify(input.sqlText, conn.dialect as Dialect);
    if (cls.kind !== 'SELECT') {
      throw new BadRequestException('Only read-only SELECT statements can be shared.');
    }

    const token = randomBytes(18).toString('base64url');
    const expiresAt = input.expiresInDays
      ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const rowLimit = Math.min(Math.max(input.rowLimit ?? 1000, 1), 10000);

    const row = await this.prisma.sharedQuery.create({
      data: {
        token,
        sqlText: input.sqlText,
        title: input.title?.slice(0, 200) || null,
        connectionId: input.connectionId,
        createdById: userId,
        expiresAt,
        rowLimit,
      },
    });
    return { token: row.token, id: row.id, expiresAt: row.expiresAt };
  }

  async listForConnection(userId: string, connectionId: string) {
    await this.rbac.require(userId, connectionId, Role.VIEWER);
    const rows = await this.prisma.sharedQuery.findMany({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        token: true,
        title: true,
        sqlText: true,
        expiresAt: true,
        viewCount: true,
        createdAt: true,
        createdBy: { select: { email: true, displayName: true } },
      },
    });
    return rows;
  }

  async revoke(userId: string, id: string) {
    const row = await this.prisma.sharedQuery.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    // Creator or an OWNER on the connection may revoke.
    if (row.createdById !== userId) {
      await this.rbac.require(userId, row.connectionId, Role.OWNER);
    }
    await this.prisma.sharedQuery.delete({ where: { id } });
    return { ok: true as const };
  }

  /** Public — metadata only, no execution. Used to render the page shell. */
  async getPublicMeta(token: string) {
    const row = await this.prisma.sharedQuery.findUnique({
      where: { token },
      select: {
        title: true,
        sqlText: true,
        expiresAt: true,
        rowLimit: true,
        connection: { select: { name: true, dialect: true } },
      },
    });
    if (!row) throw new NotFoundException('Share not found');
    if (row.expiresAt && row.expiresAt < new Date()) {
      throw new ForbiddenException('This shared link has expired.');
    }
    return {
      title: row.title,
      sqlText: row.sqlText,
      expiresAt: row.expiresAt,
      rowLimit: row.rowLimit,
      connectionName: row.connection.name,
      dialect: row.connection.dialect,
    };
  }

  /** Public — run the frozen SELECT read-only and return rows. */
  async run(token: string) {
    const row = await this.prisma.sharedQuery.findUnique({ where: { token } });
    if (!row) throw new NotFoundException('Share not found');
    if (row.expiresAt && row.expiresAt < new Date()) {
      throw new ForbiddenException('This shared link has expired.');
    }

    // Always VIEWER role => read-only driver, replica-preferred.
    // SECURITY: apply the SHARER's column masks. Without this a masked viewer
    // could share `SELECT ssn FROM employees` and then read it back through
    // this endpoint — which needs no authentication at all — laundering masked
    // data into a public URL. The share can never expose more than the person
    // who created it was allowed to see.
    const drv = await this.connections.buildDriverForRole(row.connectionId, Role.VIEWER, {
      userId: row.createdById,
    });
    const started = Date.now();
    try {
      const res = await drv.runRawQuery(row.sqlText);
      const rows = res.rows.slice(0, row.rowLimit);
      const truncated = res.rows.length > row.rowLimit;
      // Best-effort view counter — never block the response on it.
      this.prisma.sharedQuery
        .update({ where: { token }, data: { viewCount: { increment: 1 } } })
        .catch(() => {});
      return {
        fields: res.fields,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - started,
      };
    } finally {
      await drv.close().catch(() => {});
    }
  }
}
