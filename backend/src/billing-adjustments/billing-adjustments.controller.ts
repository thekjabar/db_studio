import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsISO8601, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { BillingAdjustmentsService } from './billing-adjustments.service';
import { OperatorAuditService } from '../operator/operator-audit.service';

class IssueDto {
  @IsInt() @Min(-1_000_000) @Max(1_000_000) amountCents!: number;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
  @IsString() @Length(1, 500) reason!: string;
  @IsOptional() @IsISO8601() periodStart?: string;
  @IsOptional() @IsISO8601() periodEnd?: string;
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/workspaces/:workspaceId/adjustments')
export class BillingAdjustmentsController {
  constructor(
    private readonly svc: BillingAdjustmentsService,
    private readonly audit: OperatorAuditService,
  ) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string) {
    return this.svc.listForWorkspace(workspaceId);
  }

  @Post()
  async issue(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: IssueDto,
    @Req() req: OperatorRequest,
  ) {
    const row = await this.svc.issue(req.operator!.id, workspaceId, {
      amountCents: dto.amountCents,
      currency: dto.currency ?? 'USD',
      reason: dto.reason,
      periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
      periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
    });
    await this.audit.log({
      operatorId: req.operator!.id,
      action: dto.amountCents < 0 ? 'BILLING_CREDIT_ISSUED' : 'BILLING_CHARGE_ISSUED',
      targetType: 'Workspace',
      targetId: workspaceId,
      reason: dto.reason,
      metadata: { amountCents: dto.amountCents, currency: dto.currency ?? 'USD' },
    });
    return row;
  }
}
