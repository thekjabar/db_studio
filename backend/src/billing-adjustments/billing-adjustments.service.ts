import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Manual credits/charges on a workspace's subscription. The MRR/revenue
 * dashboard already sums the raw workspace+pack products; this service
 * adds a `pendingAdjustmentsCents` column so operators see true net.
 */
@Injectable()
export class BillingAdjustmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(operatorId: string, workspaceId: string, input: {
    amountCents: number;
    currency: string;
    reason: string;
    periodStart?: Date | null;
    periodEnd?: Date | null;
  }) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException('Workspace not found');
    return this.prisma.billingAdjustment.create({
      data: {
        workspaceId,
        amountCents: input.amountCents,
        currency: input.currency,
        reason: input.reason,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        operatorId,
      },
    });
  }

  async listForWorkspace(workspaceId: string) {
    return this.prisma.billingAdjustment.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Sum of pending adjustments (i.e. periodEnd null OR in the future) —
   * used to offset MRR display.
   */
  async pendingSumCents(workspaceId: string) {
    const now = new Date();
    const rows = await this.prisma.billingAdjustment.findMany({
      where: {
        workspaceId,
        OR: [{ periodEnd: null }, { periodEnd: { gte: now } }],
      },
      select: { amountCents: true },
    });
    return rows.reduce((n, r) => n + r.amountCents, 0);
  }
}
