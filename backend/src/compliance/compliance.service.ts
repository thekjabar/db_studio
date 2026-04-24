import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/**
 * SOC 2-style administrative operations:
 *   - Retention enforcement: prune old rows across the high-volume tables
 *     (audit log, slow queries, refresh tokens, schedule runs).
 *   - Signed audit export: stream the full audit log as JSON lines with an
 *     HMAC so downstream archives can detect tampering.
 *   - GDPR export: gather everything the app knows about a user.
 *   - GDPR delete: wipe a user, cascading through FKs (already modeled with
 *     ON DELETE CASCADE on most relations).
 *
 * All operations are admin-only; controller enforces that.
 */
@Injectable()
export class ComplianceService {
  private readonly log = new Logger(ComplianceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
  ) {}

  /** Delete rows older than the per-table retention windows. Returns counts. */
  async applyRetention(): Promise<Record<string, number>> {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const cuts = {
      auditLog: new Date(now - this.cfg.retentionAuditDays * day),
      refreshToken: new Date(now - 30 * day), // expired + old; separate from audit
      webhookDelivery: new Date(now - 30 * day),
      scheduledQueryRun: new Date(now - 90 * day),
      emailVerification: new Date(now - 7 * day),
      passwordReset: new Date(now - 7 * day),
    };
    const results: Record<string, number> = {};
    results.auditLog = (
      await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cuts.auditLog } } })
    ).count;
    // Revoked AND expired refresh tokens.
    results.refreshToken = (
      await this.prisma.refreshToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: cuts.refreshToken } }, { revokedAt: { lt: cuts.refreshToken } }] },
      })
    ).count;
    results.webhookDelivery = (
      await this.prisma.webhookDelivery.deleteMany({ where: { startedAt: { lt: cuts.webhookDelivery } } })
    ).count;
    results.scheduledQueryRun = (
      await this.prisma.scheduledQueryRun.deleteMany({ where: { startedAt: { lt: cuts.scheduledQueryRun } } })
    ).count;
    results.emailVerification = (
      await this.prisma.emailVerification.deleteMany({ where: { createdAt: { lt: cuts.emailVerification } } })
    ).count;
    results.passwordReset = (
      await this.prisma.passwordReset.deleteMany({ where: { createdAt: { lt: cuts.passwordReset } } })
    ).count;
    this.log.log(
      `Retention applied: ${Object.entries(results)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    );
    return results;
  }

  /** Stream the audit log. Returns line-delimited JSON strings. */
  async *streamAuditLog(sinceMs?: number): AsyncGenerator<string> {
    const since = sinceMs ? new Date(Date.now() - sinceMs) : undefined;
    const PAGE = 1000;
    let cursor: string | undefined;
    // Chain key for HMAC-chain: starting seed is the ENCRYPTION_KEY
    // (not the value — just a deterministic derived secret). Every emitted
    // line carries `prevHash` so a removed line is detectable.
    const secret = createHmac('sha256', this.cfg.encryptionKey)
      .update('audit-export')
      .digest();
    let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await this.prisma.auditLog.findMany({
        where: { ...(since ? { createdAt: { gte: since } } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const payload = {
          id: r.id,
          at: r.createdAt.toISOString(),
          userId: r.userId,
          connectionId: r.connectionId,
          action: r.action,
          sqlText: r.sqlText,
          affectedRows: r.affectedRows,
          ip: r.ip,
          userAgent: r.userAgent,
          metadata: r.metadata,
          prevHash,
        };
        const body = JSON.stringify(payload);
        const hash = createHmac('sha256', secret).update(prevHash).update(body).digest('hex');
        prevHash = hash;
        yield JSON.stringify({ ...payload, hmac: hash }) + '\n';
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
  }

  /** Gather everything in the app DB about a single user. GDPR Article 15. */
  async exportUser(userId: string): Promise<unknown> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        refreshTokens: { select: { id: true, userAgent: true, ip: true, createdAt: true, expiresAt: true, revokedAt: true } },
        workspaceMembers: { select: { workspaceId: true, role: true, createdAt: true } },
        ownedWorkspaces: { select: { id: true, name: true, slug: true, createdAt: true } },
        connections: { select: { id: true, name: true, dialect: true, createdAt: true } },
        memberships: { select: { connectionId: true, role: true, createdAt: true } },
        savedQueries: { select: { id: true, name: true, sqlText: true, createdAt: true } },
        comments: { select: { id: true, body: true, target: true, createdAt: true } },
        scheduledQueries: { select: { id: true, name: true, cron: true, sqlText: true, createdAt: true } },
        apiKeys: { select: { id: true, name: true, tokenPrefix: true, createdAt: true, revokedAt: true, lastUsedAt: true } },
        dashboards: { select: { id: true, name: true, createdAt: true } },
        notebooks: { select: { id: true, name: true, createdAt: true } },
        schemaDocs: { select: { id: true, schemaName: true, tableName: true, columnName: true, updatedAt: true } },
        auditLogs: {
          take: 1000,
          orderBy: { createdAt: 'desc' },
          select: { id: true, action: true, sqlText: true, createdAt: true, ip: true, userAgent: true },
        },
      },
    });
    if (!user) throw new NotFoundException();
    // Redact sensitive fields we never expose.
    const { passwordHash, ...rest } = user;
    void passwordHash;
    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      user: rest,
    };
  }

  /** Destroy all rows that belong to this user. GDPR Article 17.
   *  Most FKs are ON DELETE CASCADE so one DELETE handles it; explicit calls
   *  remain for audit clarity. */
  async deleteUser(actorId: string, userId: string): Promise<{ ok: true }> {
    if (actorId === userId) {
      throw new BadRequestException('Admins cannot delete themselves via this endpoint');
    }
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException();
    // The schema has `User.connections -> Connection.owner` with onDelete: Cascade
    // which removes every owned connection (and its transitive rows). Same for
    // owned workspaces. The remaining audit trail references the user via an
    // optional FK that goes to SET NULL, so the event log survives the deletion.
    await this.prisma.user.delete({ where: { id: userId } });
    this.log.log(`User ${userId} deleted by admin ${actorId}`);
    return { ok: true };
  }
}
