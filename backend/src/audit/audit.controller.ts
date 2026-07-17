import { Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
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
    @CurrentUser() u: AuthUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.listForConnection(
      connectionId,
      u.id,
      limit ? parseInt(limit, 10) : 100,
      cursor,
    );
  }

  /** CSV export of this connection's audit log — for the customer's own
   *  compliance records. OWNER-only since it includes everyone's SQL. */
  @Get('export.csv')
  @RequireRole('OWNER')
  async exportCsv(@Param('id') connectionId: string, @Res() res: Response) {
    const csv = await this.audit.exportConnectionCsv(connectionId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${connectionId}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(csv);
  }

  /**
   * Team-wide query history — same underlying table as /audit, but filtered to
   * QUERY_RUN / SCHEMA_CHANGE and with user / time / search filters so the UI
   * can offer a focused "who ran what" view.
   */
  @Get('query-history')
  @RequireRole('VIEWER')
  async queryHistory(
    @Param('id') connectionId: string,
    @CurrentUser() u: AuthUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('userId') userId?: string,
    @Query('sinceMs') sinceMs?: string,
    @Query('search') search?: string,
    @Query('action') action?: 'QUERY_RUN' | 'SCHEMA_CHANGE',
  ) {
    return this.audit.listQueryHistory(connectionId, u.id, {
      limit: limit ? parseInt(limit, 10) : 50,
      cursor,
      userId: userId || undefined,
      sinceMs: sinceMs ? parseInt(sinceMs, 10) : undefined,
      search: search || undefined,
      actions: action ? [action] : undefined,
    });
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
