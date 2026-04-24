import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorGuard, OperatorRequest, SuperOperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';

const PatchDto = z.object({
  pricePerSeatCents: z.number().int().min(0).max(1_000_000).optional(),
  currency: z.string().length(3).optional(),
  dailyFreeAiCalls: z.number().int().min(0).max(10_000).optional(),
  aiTopUpCallsPerPack: z.number().int().min(1).max(10_000).optional(),
  aiTopUpPriceCents: z.number().int().min(0).max(1_000_000).optional(),
  reason: z.string().min(1).max(500),
});

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
  ) {}

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
