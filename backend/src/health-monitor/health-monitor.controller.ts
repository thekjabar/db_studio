import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { HealthMonitorService } from './health-monitor.service';

@Controller('connections/:id/db-health')
@UseGuards(JwtAuthGuard, RbacGuard)
export class HealthMonitorController {
  constructor(private readonly svc: HealthMonitorService) {}

  // Dashboards may poll this at 10-30s — higher limit than default so users
  // who leave a health tab open don't hit the rate limit.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  @RequireRole('VIEWER')
  snapshot(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.snapshot(id, user.id);
  }
}
