import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { SlowQueryService } from './slow-query.service';

@Controller('connections/:id/slow-queries')
@UseGuards(JwtAuthGuard, RbacGuard)
export class SlowQueryController {
  constructor(private readonly svc: SlowQueryService) {}

  @Get()
  @RequireRole('VIEWER')
  list(
    @Param('id') id: string,
    @Query('hours') hoursRaw?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const hours = Math.max(1, Math.min(parseInt(hoursRaw ?? '168', 10) || 168, 24 * 30));
    const limit = parseInt(limitRaw ?? '100', 10) || 100;
    return this.svc.listGroups(id, {
      sinceMs: hours * 60 * 60 * 1000,
      limit,
    });
  }

  @Get(':hash/runs')
  @RequireRole('VIEWER')
  runs(
    @Param('id') id: string,
    @Param('hash') hash: string,
    @Query('limit') limitRaw?: string,
  ) {
    return this.svc.listRunsForShape(id, hash, parseInt(limitRaw ?? '50', 10) || 50);
  }
}
