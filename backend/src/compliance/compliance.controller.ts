import { Controller, Delete, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { ComplianceService } from './compliance.service';

@Controller('admin/compliance')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ComplianceController {
  constructor(private readonly svc: ComplianceService) {}

  @Post('retention/sweep')
  @HttpCode(200)
  sweep() {
    return this.svc.applyRetention();
  }

  @Get('audit/export')
  async exportAudit(
    @Query('sinceMs') sinceMs: string | undefined,
    @Res({ passthrough: false }) res: Response,
  ) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson"`,
    );
    for await (const line of this.svc.streamAuditLog(sinceMs ? Number(sinceMs) : undefined)) {
      res.write(line);
    }
    res.end();
  }

  @Get('users/:id/export')
  exportUser(@Param('id') id: string) {
    return this.svc.exportUser(id);
  }

  @Delete('users/:id')
  @HttpCode(200)
  deleteUser(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.svc.deleteUser(user.id, id);
  }
}
