import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { OperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/audit')
export class OperatorAuditController {
  constructor(private readonly svc: OperatorAuditService) {}

  @Get()
  async list(
    @Query('limit') limitRaw = '50',
    @Query('offset') offsetRaw = '0',
    @Query('action') action?: string,
    @Query('operatorId') operatorId?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    return this.svc.list({ limit, offset, action, operatorId });
  }
}
