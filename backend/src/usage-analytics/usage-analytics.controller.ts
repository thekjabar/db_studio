import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { OperatorGuard } from '../operator/operator.guard';
import { UsageAnalyticsService } from './usage-analytics.service';

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/analytics')
export class OperatorAnalyticsController {
  constructor(private readonly svc: UsageAnalyticsService) {}

  @Get('platform')
  platform(@Query('days') daysRaw = '30') {
    const days = Math.min(Math.max(parseInt(daysRaw, 10) || 30, 1), 180);
    return this.svc.platformSeries(days);
  }

  @Get('users/:id')
  user(@Param('id') id: string, @Query('days') daysRaw = '30') {
    const days = Math.min(Math.max(parseInt(daysRaw, 10) || 30, 1), 180);
    return this.svc.userSeries(id, days);
  }

  @Get('users/:id/support')
  support(@Param('id') id: string) {
    return this.svc.supportTimeline(id);
  }
}
