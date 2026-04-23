import {
  BadRequestException, Body, Controller, ForbiddenException, HttpCode, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { AuditService } from '../audit/audit.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { SqlClassifierService } from './sql-classifier.service';
import { ExplainService, ExplainMode } from './explain.service';
import { SlowQueryService } from '../slow-query/slow-query.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class RunQueryDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsOptional() @IsArray() params?: unknown[];
  @IsOptional() @IsBoolean() confirmDestructive?: boolean;
}

class ExplainQueryDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsOptional() @IsIn(['plan', 'analyze']) mode?: ExplainMode;
}

function meta(req: Request) { return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined }; }

@Controller('connections/:id/query')
@UseGuards(RbacGuard)
export class QueryController {
  constructor(
    private readonly svc: ConnectionsService,
    private readonly audit: AuditService,
    private readonly classifier: SqlClassifierService,
    private readonly explain: ExplainService,
    private readonly slow: SlowQueryService,
  ) {}

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post('explain') @HttpCode(200) @RequireRole('VIEWER')
  async explainQuery(
    @Param('id') id: string,
    @Body() dto: ExplainQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.explain.explain(user.id, id, dto.sql, dto.mode ?? 'plan');
  }

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post() @HttpCode(200) @RequireRole('VIEWER')
  async run(
    @Param('id') id: string,
    @Body() dto: RunQueryDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const conn = await this.svc.get(id);
    const role = (req as any).connectionRole as Role;
    const cls = this.classifier.classify(dto.sql, conn.dialect);

    if (cls.kind !== 'SELECT' && role === Role.VIEWER) {
      throw new ForbiddenException('Viewer role may only run SELECT statements');
    }
    if (cls.kind === 'DESTRUCTIVE' && !dto.confirmDestructive) {
      throw new BadRequestException({
        message: 'Destructive statement requires confirmDestructive: true',
        classification: cls,
      });
    }
    if (conn.readOnly && cls.kind !== 'SELECT') {
      throw new ForbiddenException('Connection is read-only');
    }

    const drv = await this.svc.buildDriverForRole(id, role);
    const started = Date.now();
    try {
      const res = await drv.runRawQuery(dto.sql, dto.params);
      const durationMs = Date.now() - started;
      await this.audit.log({
        userId: user.id, connectionId: id,
        action: cls.kind === 'DDL' || cls.kind === 'DESTRUCTIVE' ? 'SCHEMA_CHANGE' : 'QUERY_RUN',
        sqlText: dto.sql, affectedRows: res.rowCount, ...meta(req),
        metadata: { classification: { ...cls }, durationMs },
      });
      this.slow.record({
        connectionId: id,
        userId: user.id,
        sql: dto.sql,
        durationMs,
        rowCount: res.rows?.length ?? null,
        rowsAffected: res.rowCount ?? null,
      });
      return { ...res, classification: cls };
    } catch (err) {
      const durationMs = Date.now() - started;
      // Record failures too — useful for "this query always times out" patterns.
      this.slow.record({
        connectionId: id,
        userId: user.id,
        sql: dto.sql,
        durationMs,
        errored: true,
        errorMessage: (err as Error).message,
      });
      throw err;
    } finally {
      await drv.close().catch(() => {});
    }
  }
}
