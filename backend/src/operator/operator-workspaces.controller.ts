import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard } from './operator.guard';
import { Public } from '../auth/decorators/public.decorator';

/**
 * Workspaces view for operators. Each workspace = one billing customer.
 * Shows the owner's email, seat count (= member count), current subscription
 * status, and current month-billable total. Never returns connection or
 * query content.
 */
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/workspaces')
export class OperatorWorkspacesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') limitRaw = '50',
    @Query('offset') offsetRaw = '0',
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    const where: Record<string, unknown> = {};
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { slug: { contains: q, mode: 'insensitive' } },
        { owner: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }
    if (status) {
      where.subscription = { status };
    }

    const settings = await this.prisma.billingSettings.findUnique({ where: { id: 'singleton' } });
    const seatPriceCents = settings?.pricePerSeatCents ?? 0;
    const topUpPriceCents = settings?.aiTopUpPriceCents ?? 0;

    const [rows, total] = await Promise.all([
      this.prisma.workspace.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          name: true,
          slug: true,
          isPersonal: true,
          createdAt: true,
          owner: { select: { id: true, email: true, displayName: true, suspendedAt: true } },
          _count: { select: { members: true, connections: true } },
          subscription: {
            select: { status: true, periodStart: true, periodEnd: true, aiTopUpPacks: true, manualOverrideNote: true },
          },
        },
      }),
      this.prisma.workspace.count({ where }),
    ]);
    return {
      rows: rows.map((w) => {
        const seats = w._count.members;
        const packs = w.subscription?.aiTopUpPacks ?? 0;
        const monthlyCents = seats * seatPriceCents + packs * topUpPriceCents;
        return {
          id: w.id,
          name: w.name,
          slug: w.slug,
          isPersonal: w.isPersonal,
          createdAt: w.createdAt,
          owner: w.owner,
          seats,
          connections: w._count.connections,
          subscription: w.subscription,
          monthlyCents,
        };
      }),
      total,
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const w = await this.prisma.workspace.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        isPersonal: true,
        createdAt: true,
        owner: { select: { id: true, email: true, displayName: true } },
        members: {
          select: {
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, displayName: true, suspendedAt: true } },
          },
        },
        _count: { select: { connections: true } },
        subscription: true,
      },
    });
    if (!w) throw new NotFoundException();
    return w;
  }
}
