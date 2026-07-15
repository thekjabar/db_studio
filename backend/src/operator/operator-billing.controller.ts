import { BadRequestException, Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard, OperatorRequest, SuperOperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';
import { PlanService } from '../billing/plan.service';

const PatchDto = z.object({
  pricePerSeatCents: z.number().int().min(0).max(1_000_000).optional(),
  currency: z.string().length(3).optional(),
  dailyFreeAiCalls: z.number().int().min(0).max(10_000).optional(),
  aiTopUpCallsPerPack: z.number().int().min(1).max(10_000).optional(),
  aiTopUpPriceCents: z.number().int().min(0).max(1_000_000).optional(),
  reason: z.string().min(1).max(500),
});

/** Per-tier plan pricing + limits editable by operators. Tier itself is
 *  immutable (it's the primary key); everything else is tunable. */
const PlanPatchDto = z.object({
  name: z.string().min(1).max(40).optional(),
  seatPriceIqd: z.number().int().min(0).max(100_000_000).optional(),
  maxConnections: z.number().int().min(0).max(100_000).optional(),
  aiEnabled: z.boolean().optional(),
  dailyAiCalls: z.number().int().min(0).max(1_000_000).optional(),
  maxScheduledQueries: z.number().int().min(0).max(100_000).optional(),
  maxWebhooksPerConnection: z.number().int().min(0).max(100_000).optional(),
  // null = unlimited seats.
  maxSeats: z.number().int().min(1).max(1_000_000).nullable().optional(),
  reason: z.string().min(1).max(500),
});

const PLAN_TIERS = ['FREE', 'PRO', 'TEAM'] as const;

/**
 * Read is open to any operator so support staff can see current pricing.
 * Writing requires super — price changes are audit-logged with the
 * operator's reason so changes are traceable.
 */
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/billing')
export class OperatorBillingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OperatorAuditService,
    private readonly plans: PlanService,
  ) {}

  /** All plan tiers with their current price + limits (defaults filled in). */
  @Get('plans')
  async getPlans() {
    return this.plans.all();
  }

  /** Edit one tier's price/limits. Super-only, audit-logged. */
  @Patch('plans/:tier')
  @UseGuards(SuperOperatorGuard)
  async patchPlan(
    @Param('tier') tier: string,
    @Body() body: unknown,
    @Req() req: OperatorRequest,
  ) {
    const t = tier.toUpperCase();
    if (!(PLAN_TIERS as readonly string[]).includes(t)) {
      throw new BadRequestException(`Unknown plan tier: ${tier}`);
    }
    const dto = PlanPatchDto.parse(body);
    const { reason, ...patch } = dto;
    const tierKey = t as (typeof PLAN_TIERS)[number];
    const before = await this.prisma.planConfig.findUnique({ where: { tier: tierKey } });
    const after = await this.prisma.planConfig.upsert({
      where: { tier: tierKey },
      create: {
        tier: tierKey,
        name: patch.name ?? t,
        ...patch,
        updatedByOperatorId: req.operator!.id,
      },
      update: { ...patch, updatedByOperatorId: req.operator!.id },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'BILLING_PRICE_CHANGED',
      targetType: 'PlanConfig',
      targetId: t,
      reason,
      metadata: { before, after: patch },
    });
    return after;
  }

  @Get('settings')
  async get() {
    const s = await this.prisma.billingSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton' },
      update: {},
    });
    return s;
  }

  @Patch('settings')
  @UseGuards(SuperOperatorGuard)
  async patch(@Body() body: unknown, @Req() req: OperatorRequest) {
    const dto = PatchDto.parse(body);
    const { reason, ...patch } = dto;
    const before = await this.prisma.billingSettings.findUnique({ where: { id: 'singleton' } });
    const after = await this.prisma.billingSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', ...patch, updatedByOperatorId: req.operator!.id },
      update: { ...patch, updatedByOperatorId: req.operator!.id },
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: 'BILLING_PRICE_CHANGED',
      targetType: 'BillingSettings',
      targetId: 'singleton',
      reason,
      metadata: { before, after: patch },
    });
    return after;
  }
}
