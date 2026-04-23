import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { MigrationExportService, MigrationTarget } from './migration-export.service';

@Controller('connections/:id/migration-export')
@UseGuards(JwtAuthGuard, RbacGuard)
export class MigrationExportController {
  constructor(private readonly svc: MigrationExportService) {}

  @Get()
  @RequireRole('VIEWER')
  export(
    @Param('id') id: string,
    @Query('target') target: string | undefined,
    @Query('schema') schema: string | undefined,
  ) {
    const normalized: MigrationTarget =
      target === 'drizzle' || target === 'sql' ? target : 'prisma';
    return this.svc.export(id, normalized, schema || undefined);
  }
}
