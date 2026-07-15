import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../billing/plan.service';

/**
 * Enforces per-user, per-day AI call limits and atomically increments
 * usage. One method to call from every AI endpoint before it hits a
 * provider: `await quota.consume(userId)`.
 *
 * Rules (per the billing spec):
 *   - Suspended users: 0 calls. Hard block.
 *   - Users with no active workspace subscription: 0 calls.
 *   - Otherwise: allowance = dailyFreeAiCalls + (workspace.topUpPacks *
 *     aiTopUpCallsPerPack), summed across workspaces they belong to.
 *   - When allowance is exhausted we throw HTTP 402 Payment Required with
 *     the exact message product wants: "Daily limit reached — ask the
 *     workspace owner to buy a top-up, or wait until tomorrow."
 *
 * Day boundary is UTC. A per-user/per-day unique index on AiUsageDay
 * makes the upsert race-free.
 */
@Injectable()
export class AiQuotaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  private todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Compute the user's per-day AI allowance. AI is a paid-tier feature: the
   * user's strongest plan must have aiEnabled, and its `dailyAiCalls` is the
   * base allowance. Operator top-up packs (across the user's active-sub
   * workspaces) stack on top. Suspended users always get 0.
   */
  private async computeAllowance(userId: string): Promise<{ allowance: number; reason?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { suspendedAt: true },
    });
    if (!user) return { allowance: 0, reason: 'user-not-found' };
    if (user.suspendedAt) return { allowance: 0, reason: 'suspended' };

    // Effective plan across every workspace the user belongs to / owns.
    const plan = await this.plans.forUser(userId);
    if (!plan.aiEnabled || plan.dailyAiCalls <= 0) {
      return { allowance: 0, reason: 'plan-no-ai' };
    }

    const settings = await this.prisma.billingSettings.findUnique({
      where: { id: 'singleton' },
      select: { aiTopUpCallsPerPack: true },
    });
    const perPack = settings?.aiTopUpCallsPerPack ?? 10;

    // Top-up packs stack across every workspace they're a member of that has
    // an active subscription.
    const activeSubs = await this.prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        workspace: { members: { some: { userId } } },
      },
      select: { aiTopUpPacks: true },
    });
    const packsTotal = activeSubs.reduce((n, s) => n + s.aiTopUpPacks, 0);
    return { allowance: plan.dailyAiCalls + packsTotal * perPack };
  }

  /**
   * Consume one AI call or throw 402. Upserts the per-day counter and
   * only succeeds if the increment stays under the allowance.
   */
  async consume(userId: string): Promise<{ used: number; allowance: number }> {
    const { allowance, reason } = await this.computeAllowance(userId);
    if (allowance === 0) {
      throw new HttpException(
        reason === 'suspended'
          ? 'Your account is suspended. Contact support to restore access.'
          : reason === 'plan-no-ai'
            ? 'The AI assistant is available on the Pro and Team plans. Upgrade your plan to use it.'
            : 'AI is not available for this account.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const day = this.todayUtc();
    const current = await this.prisma.aiUsageDay.findUnique({
      where: { userId_day: { userId, day } },
      select: { callsUsed: true },
    });
    const used = current?.callsUsed ?? 0;
    if (used >= allowance) {
      throw new HttpException(
        'Daily limit reached — ask the workspace owner to buy a top-up, or wait until tomorrow.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    // Atomic increment: upsert with `increment` means two concurrent calls
    // can't both squeeze past allowance-1.
    const after = await this.prisma.aiUsageDay.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day, callsUsed: 1 },
      update: { callsUsed: { increment: 1 } },
      select: { callsUsed: true },
    });
    // Re-check post-increment in case the pre-check was stale under heavy
    // concurrency. Roll back the bump if we went over.
    if (after.callsUsed > allowance) {
      await this.prisma.aiUsageDay.update({
        where: { userId_day: { userId, day } },
        data: { callsUsed: { decrement: 1 } },
      });
      throw new HttpException(
        'Daily limit reached — ask the workspace owner to buy a top-up, or wait until tomorrow.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return { used: after.callsUsed, allowance };
  }

  /** Read-only view for showing quota in the UI. */
  async status(userId: string) {
    const { allowance } = await this.computeAllowance(userId);
    const day = this.todayUtc();
    const row = await this.prisma.aiUsageDay.findUnique({
      where: { userId_day: { userId, day } },
      select: { callsUsed: true },
    });
    return { used: row?.callsUsed ?? 0, allowance, day };
  }
}
