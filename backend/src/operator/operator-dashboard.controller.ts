import { Controller, Get, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard } from './operator.guard';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Revenue + growth numbers for the operator home screen. All values are
 * derived from counts and joins — no customer content ever leaves the DB.
 */
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/dashboard')
export class OperatorDashboardController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  async overview() {
    const settings = await this.prisma.billingSettings.findUnique({ where: { id: 'singleton' } });
    const seatPriceCents = settings?.pricePerSeatCents ?? 0;
    const topUpPriceCents = settings?.aiTopUpPriceCents ?? 0;

    // MRR = active subs: sum(seats * seatPrice + packs * packPrice).
    // Seat count is derived from WorkspaceMember live — no risk of drift.
    const activeSubs = await this.prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } },
      select: {
        status: true,
        aiTopUpPacks: true,
        workspace: { select: { _count: { select: { members: true } } } },
      },
    });
    let mrrCents = 0;
    let activeSeats = 0;
    let activeTopUpPacks = 0;
    const byStatus: Record<string, number> = {};
    for (const s of activeSubs) {
      const seats = s.workspace._count.members;
      activeSeats += seats;
      activeTopUpPacks += s.aiTopUpPacks;
      mrrCents += seats * seatPriceCents + s.aiTopUpPacks * topUpPriceCents;
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 864e5);
    const monthAgo = new Date(now.getTime() - 30 * 864e5);
    const [totalUsers, usersThisWeek, usersThisMonth, suspendedUsers, totalWorkspaces, cancelledThisMonth] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: monthAgo } } }),
      this.prisma.user.count({ where: { suspendedAt: { not: null } } }),
      this.prisma.workspace.count(),
      this.prisma.subscription.count({ where: { status: 'CANCELLED', updatedAt: { gte: monthAgo } } }),
    ]);

    const aiCallsToday = await this.prisma.aiUsageDay.aggregate({
      where: { day: new Date().toISOString().slice(0, 10) },
      _sum: { callsUsed: true },
    });

    return {
      mrrCents,
      currency: settings?.currency ?? 'USD',
      activeSubscriptions: activeSubs.length,
      activeSeats,
      activeTopUpPacks,
      byStatus,
      totalUsers,
      suspendedUsers,
      usersThisWeek,
      usersThisMonth,
      cancelledThisMonth,
      totalWorkspaces,
      aiCallsToday: aiCallsToday._sum.callsUsed ?? 0,
    };
  }
}
