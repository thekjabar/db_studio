import {
  BadRequestException, Body, Controller, ForbiddenException, HttpCode, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Dialect, Role } from '@prisma/client';
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
  /**
   * Row cap for SELECT queries. 0 means "no cap" (dangerous on large tables
   * — the UI warns the user). The backend wraps the query in a subquery +
   * LIMIT only when this is > 0, the statement is a SELECT, and the user's
   * SQL has no existing LIMIT clause.
   */
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) maxRows?: number;
}

/**
 * Does the SQL already end with a LIMIT clause (ignoring trailing whitespace
 * and an optional OFFSET)? If yes, we don't re-wrap — the user asked for a
 * specific cap and we respect it.
 *
 * Heuristic: the parser would be authoritative but for a safety wrapper this
 * regex catches the common cases across dialects (Postgres, MySQL, SQLite).
 * MSSQL uses TOP which we detect separately.
 */
function hasExistingLimit(sql: string, dialect: Dialect): boolean {
  const normalized = sql.trim().replace(/;+\s*$/, '');
  if (dialect === Dialect.MSSQL) {
    // SELECT TOP (n) ...
    return /^\s*select\s+top\b/i.test(normalized);
  }
  // LIMIT n [OFFSET m] at the very end.
  return /\blimit\s+\d+(?:\s*,\s*\d+|\s+offset\s+\d+)?\s*$/i.test(normalized);
}

/**
 * Wrap a SELECT in a subquery with LIMIT cap+1 so the caller can detect that
 * the result was truncated (received cap+1 rows means there are more). Uses
 * the dialect-appropriate syntax.
 */
function wrapWithLimit(sql: string, cap: number, dialect: Dialect): string {
  const inner = sql.trim().replace(/;+\s*$/, '');
  const limit = cap + 1;
  if (dialect === Dialect.MSSQL) {
    return `SELECT TOP (${limit}) * FROM (${inner}) AS _dbdash_limited`;
  }
  return `SELECT * FROM (${inner}) AS _dbdash_limited LIMIT ${limit}`;
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

    // Apply row cap only to SELECT statements that don't already cap themselves.
    const cap = dto.maxRows ?? 0;
    const shouldWrap =
      cls.kind === 'SELECT' && cap > 0 && !hasExistingLimit(dto.sql, conn.dialect);
    const sqlToRun = shouldWrap ? wrapWithLimit(dto.sql, cap, conn.dialect) : dto.sql;

    const drv = await this.svc.buildDriverForRole(id, role);
    const started = Date.now();
    try {
      const res = await drv.runRawQuery(sqlToRun, dto.params);
      const durationMs = Date.now() - started;

      // Detect truncation: we asked for cap+1 rows, so receiving more than cap
      // means the real result set is larger. Trim the sentinel row before
      // returning.
      let truncated = false;
      let rows = res.rows;
      if (shouldWrap && rows.length > cap) {
        rows = rows.slice(0, cap);
        truncated = true;
      }

      await this.audit.log({
        userId: user.id, connectionId: id,
        action: cls.kind === 'DDL' || cls.kind === 'DESTRUCTIVE' ? 'SCHEMA_CHANGE' : 'QUERY_RUN',
        sqlText: dto.sql, affectedRows: res.rowCount, ...meta(req),
        metadata: { classification: { ...cls }, durationMs, truncated, cap: shouldWrap ? cap : null },
      });
      this.slow.record({
        connectionId: id,
        userId: user.id,
        sql: dto.sql,
        durationMs,
        rowCount: rows.length,
        rowsAffected: res.rowCount ?? null,
      });
      return {
        ...res,
        rows,
        rowCount: rows.length,
        classification: cls,
        truncated,
        appliedLimit: shouldWrap ? cap : null,
      };
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
