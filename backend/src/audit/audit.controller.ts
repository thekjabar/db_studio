import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AuditRevertService } from './audit-revert.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

function reqMeta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@Controller('connections/:id/audit')
@UseGuards(RbacGuard)
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly revert: AuditRevertService,
  ) {}

  @Get()
  @RequireRole('VIEWER')
  async list(
    @Param('id') connectionId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.listForConnection(
      connectionId,
      limit ? parseInt(limit, 10) : 100,
      cursor,
    );
  }

  @Get(':entryId/revert-preview')
  @RequireRole('EDITOR')
  async revertPreview(
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
  ) {
    return this.revert.buildPreview(entryId, connectionId);
  }

  @Post(':entryId/revert')
  @HttpCode(200)
  @RequireRole('EDITOR')
  async doRevert(
    @Param('id') connectionId: string,
    @Param('entryId') entryId: string,
    @CurrentUser() u: AuthUser,
    @Req() req: Request,
  ) {
    return this.revert.revert(entryId, connectionId, u.id, reqMeta(req));
  }
}
