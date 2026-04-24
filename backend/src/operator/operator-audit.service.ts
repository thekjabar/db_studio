import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Append-only log for every operator action. Keep the write path simple
 * and non-blocking — never let audit failure break the business action.
 * If the audit row fails to write we log it but continue; the alternative
 * (rolling back a user suspension because audit DB is slow) is worse.
 */
@Injectable()
export class OperatorAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: {
    operatorId: string;
    action: string;
    targetType?: string;
    targetId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }) {
    try {
      await this.prisma.operatorAuditLog.create({
        data: {
          operatorId: entry.operatorId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          reason: entry.reason,
          metadata: entry.metadata as never,
        },
      });
    } catch {
      /* swallow — audit must not break the user-facing request */
    }
  }

  async list(params: { limit: number; offset: number; action?: string; operatorId?: string }) {
    const where: Record<string, unknown> = {};
    if (params.action) where.action = params.action;
    if (params.operatorId) where.operatorId = params.operatorId;
    const [rows, total] = await Promise.all([
      this.prisma.operatorAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: {
          operator: { select: { email: true, displayName: true } },
        },
      }),
      this.prisma.operatorAuditLog.count({ where }),
    ]);
    return { rows, total };
  }
}
