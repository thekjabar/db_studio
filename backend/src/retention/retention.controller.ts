import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { RetentionService } from './retention.service';

class UpdatePolicyDto {
  @IsInt() @Min(1) @Max(3650) keepDays!: number;
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/retention')
export class OperatorRetentionController {
  constructor(private readonly svc: RetentionService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Patch(':resource')
  update(
    @Param('resource') resource: string,
    @Body() dto: UpdatePolicyDto,
    @Req() req: OperatorRequest,
  ) {
    return this.svc.update(req.operator!.id, resource, dto.keepDays);
  }

  @Post('sweep')
  @HttpCode(200)
  sweep() {
    return this.svc.sweep();
  }
}
