import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Abuse-event ingest + triage. Operators review rate-limit bursts,
 * repeated failed logins, AI-quota exhaustion, webhook failures.
 * `record` is fire-and-forget — never let an audit/ingest error affect
 * the user's actual request.
 */
@Injectable()
export class AbuseService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    rule: string;
    ip?: string | null;
    userId?: string | null;
    path?: string | null;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.abuseEvent.create({
        data: {
          rule: input.rule,
          ip: input.ip ?? null,
          userId: input.userId ?? null,
          path: input.path ?? null,
          metadata: input.metadata as never,
        },
      });
    } catch {
      /* intentional */
    }
  }

  async list(params: { acked?: boolean; rule?: string; ip?: string; limit: number; offset: number }) {
    const where: Record<string, unknown> = {};
    if (params.acked === true) where.ackedAt = { not: null };
    if (params.acked === false) where.ackedAt = null;
    if (params.rule) where.rule = params.rule;
    if (params.ip) where.ip = params.ip;
    const [rows, total] = await Promise.all([
      this.prisma.abuseEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: { user: { select: { email: true, id: true } } },
      }),
      this.prisma.abuseEvent.count({ where }),
    ]);
    return { rows, total };
  }

  async ack(operatorId: string, id: string) {
    await this.prisma.abuseEvent.update({
      where: { id },
      data: { ackedAt: new Date(), ackedByOperatorId: operatorId },
    });
    return { ok: true as const };
  }

  async ackByIp(operatorId: string, ip: string) {
    await this.prisma.abuseEvent.updateMany({
      where: { ip, ackedAt: null },
      data: { ackedAt: new Date(), ackedByOperatorId: operatorId },
    });
    return { ok: true as const };
  }

  async listBlockedIps() {
    return this.prisma.blockedIp.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async blockIp(operatorId: string, ip: string, reason?: string) {
    return this.prisma.blockedIp.upsert({
      where: { ip },
      create: { ip, reason: reason ?? null, createdByOperatorId: operatorId },
      update: { reason: reason ?? null, createdByOperatorId: operatorId },
    });
  }

  async unblockIp(ip: string) {
    await this.prisma.blockedIp.delete({ where: { ip } }).catch(() => null);
    return { ok: true as const };
  }

  async isIpBlocked(ip: string) {
    const row = await this.prisma.blockedIp.findUnique({ where: { ip } });
    return !!row;
  }
}
