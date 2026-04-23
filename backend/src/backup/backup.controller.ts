import { BadRequestException, Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { BackupService, BackupFormat } from './backup.service';

@Controller('connections/:id/backup')
@UseGuards(JwtAuthGuard, RbacGuard)
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  @Get('estimate')
  @RequireRole('VIEWER')
  estimate(@Param('id') id: string, @Query('schema') schema: string | undefined) {
    return this.svc.estimateSize(id, { schema: schema || undefined });
  }

  @Throttle({ heavy: { limit: 3, ttl: 60_000 } })
  @Get()
  @RequireRole('OWNER') // Full-database dump is an owner-level op.
  async download(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @Query('schemaOnly') schemaOnly: string | undefined,
    @Query('schema') schema: string | undefined,
    @Res() res: Response,
  ) {
    const fmt: BackupFormat = format === 'custom' ? 'custom' : 'sql';
    if (schemaOnly !== undefined && schemaOnly !== 'true' && schemaOnly !== 'false' && schemaOnly !== '') {
      throw new BadRequestException('schemaOnly must be true or false');
    }
    await this.svc.streamBackup(
      id,
      { format: fmt, schemaOnly: schemaOnly === 'true', schema: schema || undefined },
      res,
    );
  }
}
