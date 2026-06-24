import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Dialect, Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { AuditService } from '../audit/audit.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { SqlClassifierService } from './sql-classifier.service';
import { ExplainService, ExplainMode } from './explain.service';
import { PerfInsightsService } from './perf-insights.service';
import { QueryCostService } from './query-cost.service';
import { PlanRegressionService } from './plan-regression.service';
import { QueryCacheService } from './query-cache.service';
import { CursorService } from './cursor.service';
import { TranspileService } from './transpile.service';
import { SlowQueryService } from '../slow-query/slow-query.service';
import { QueryReviewService } from '../query-review/query-review.service';
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
  /**
   * When set, this run consumes an APPROVED QueryReviewRequest. The SQL
   * in the request must match `sql` byte-for-byte — otherwise we'd allow
   * bypassing approval by swapping the body.
   */
  @IsOptional() @IsString() @Length(0, 200) reviewRequestId?: string;
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

class CursorOpenDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsOptional() @IsInt() @Min(1) @Max(5_000) pageSize?: number;
}

class CursorFetchDto {
  @IsOptional() @IsInt() @Min(1) @Max(5_000) pageSize?: number;
}

class TranspileDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsIn(['POSTGRES', 'MYSQL', 'SQLITE', 'MSSQL']) to!: Dialect;
  @IsOptional() @IsIn(['POSTGRES', 'MYSQL', 'SQLITE', 'MSSQL']) from?: Dialect;
}

/**
 * Best-effort: which table does a write statement target? Used to invalidate
 * exactly the cached reads that depend on it. Returns null when we can't tell
 * confidently — the caller then over-invalidates the whole connection, which
 * is always safe (just less efficient).
 *
 * Handles INSERT INTO / UPDATE / DELETE FROM / TRUNCATE / ALTER TABLE / DROP
 * TABLE with optional schema-qualification and quoting.
 */
function extractWriteTarget(
  sql: string,
  defaultSchema: string,
): { schema: string; table: string } | null {
  const cleaned = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const re =
    /^(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|alter\s+table|drop\s+table(?:\s+if\s+exists)?)\s+("?[A-Za-z_][\w$]*"?(?:\s*\.\s*"?[A-Za-z_][\w$]*"?)?)/i;
  const m = re.exec(cleaned);
  if (!m) return null;
  const raw = m[1].replace(/"/g, '').replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes('.')) {
    const [schema, table] = raw.split('.');
    return { schema, table };
  }
  return { schema: defaultSchema, table: raw };
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
    private readonly perf: PerfInsightsService,
    private readonly cost: QueryCostService,
    private readonly planRegression: PlanRegressionService,
    private readonly queryCache: QueryCacheService,
    private readonly cursor: CursorService,
    private readonly transpiler: TranspileService,
    private readonly slow: SlowQueryService,
    private readonly review: QueryReviewService,
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
  @Post('insights') @HttpCode(200) @RequireRole('VIEWER')
  async insights(
    @Param('id') id: string,
    @Body() dto: ExplainQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.perf.analyze(user.id, id, dto.sql);
  }

  @Throttle({ heavy: { limit: 60, ttl: 60_000 } })
  @Post('estimate') @HttpCode(200) @RequireRole('VIEWER')
  async estimate(
    @Param('id') id: string,
    @Body() dto: ExplainQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cost.estimate(user.id, id, dto.sql);
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

    // Review gate: when the connection requires review for destructive ops,
    // an EDITOR can't run them directly — they need an approved
    // QueryReviewRequest (submitted, approved by an OWNER, executed once).
    // OWNER bypasses the gate; VIEWER already gated above.
    const requiresReview =
      conn.requireReview === true &&
      (cls.kind === 'DESTRUCTIVE' || cls.kind === 'DDL') &&
      role !== Role.OWNER;
    if (requiresReview) {
      if (!dto.reviewRequestId) {
        throw new ForbiddenException({
          code: 'REVIEW_REQUIRED',
          message: 'This connection requires approval for this statement. Submit a review request.',
          classification: cls,
        });
      }
      const rr = await this.review.fetchRunnable(user.id, dto.reviewRequestId);
      if (rr.connectionId !== id) {
        throw new ForbiddenException('Review request belongs to a different connection');
      }
      if (rr.sqlText !== dto.sql) {
        throw new ForbiddenException('Review request SQL differs from the submitted statement');
      }
    }

    // Apply row cap only to SELECT statements that don't already cap themselves.
    const cap = dto.maxRows ?? 0;
    const shouldWrap =
      cls.kind === 'SELECT' && cap > 0 && !hasExistingLimit(dto.sql, conn.dialect);
    const sqlToRun = shouldWrap ? wrapWithLimit(dto.sql, cap, conn.dialect) : dto.sql;

    // Default schema for resolving unqualified table names in the cache's
    // dependency tracking. 'public' covers Postgres/MSSQL/SQLite; MySQL
    // unqualified names fall back to the TTL + per-connection invalidation.
    const defaultSchema = 'public';

    // Correctness-aware cache: serve a cached SELECT result only while the
    // tables it reads are unchanged (writes through DB Studio invalidate it
    // instantly; a short TTL backstops out-of-band writes). Parameterized
    // queries skip the cache — the SQL text alone wouldn't capture the params.
    const cacheEligible =
      cls.kind === 'SELECT' && !dto.params?.length && this.queryCache.enabled;
    if (cacheEligible) {
      const hit = await this.queryCache.get(id, role, sqlToRun);
      if (hit !== null) {
        await this.audit.log({
          userId: user.id, connectionId: id, action: 'QUERY_RUN',
          sqlText: dto.sql, ...meta(req),
          metadata: { classification: { ...cls }, cached: true },
        });
        return { ...(hit as object), cached: true };
      }
    }

    const drv = await this.svc.buildDriverForRole(id, role);
    const started = Date.now();
    try {
      const res = await drv.runRawQuery(sqlToRun, dto.params);
      const durationMs = Date.now() - started;

      // Detect truncation: we asked for cap+1 rows, so receiving more than cap
      // means the real result set is larger. Trim the sentinel row before
      // returning.
      let truncated = false;
      // Some statements (DDL, SET, etc.) return no row set — default to [] so
      // downstream .length / slice never hit undefined.
      let rows = res.rows ?? [];
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
      // Plan regression capture (fire-and-forget, read-only EXPLAIN). Only for
      // SELECTs — DML/DDL plans aren't worth tracking and EXPLAIN on them is
      // riskier. The service is fail-open and de-dupes structurally-identical
      // plans, so this stays cheap.
      if (cls.kind === 'SELECT') {
        void this.planRegression
          .capture(id, dto.sql, user.id)
          .catch(() => {});
      }
      if (dto.reviewRequestId && requiresReview) {
        // Consume the review request — any subsequent run attempt with the
        // same id will 400.
        await this.review.markExecuted(dto.reviewRequestId, res.rowCount ?? null);
      }

      const response = {
        ...res,
        rows,
        rowCount: rows.length,
        classification: cls,
        truncated,
        appliedLimit: shouldWrap ? cap : null,
      };

      // Populate the cache for cacheable SELECTs. We cache the post-truncation
      // response so a hit returns byte-identical output. Truncated results are
      // still cached — the cap is part of the SQL key.
      if (cacheEligible) {
        void this.queryCache
          .set(id, role, sqlToRun, defaultSchema, response)
          .catch(() => {});
      }
      // Any write through DB Studio invalidates dependent cached reads. We
      // parse the touched table from the SQL; if we can't, drop the whole
      // connection's cache (safe over-invalidation).
      if (cls.kind === 'DML' || cls.kind === 'DESTRUCTIVE' || cls.kind === 'DDL') {
        const touched = extractWriteTarget(dto.sql, defaultSchema);
        if (touched) {
          void this.queryCache.invalidateTable(id, touched.schema, touched.table).catch(() => {});
        } else {
          void this.queryCache.invalidateConnection(id).catch(() => {});
        }
      }
      return response;
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

  // ---- Plan regression detection ----

  /** Capture a plan snapshot on demand (read-only EXPLAIN). Returns the new
   *  snapshot, or null if the plan was structurally unchanged since last time. */
  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post('plan-capture') @HttpCode(200) @RequireRole('VIEWER')
  async planCapture(
    @Param('id') id: string,
    @Body() dto: ExplainQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const snap = await this.planRegression.capture(id, dto.sql, user.id);
    return { captured: !!snap, snapshot: snap };
  }

  /** Snapshot history for one query shape (newest first). */
  @Get('plan-history/:shapeHash') @RequireRole('VIEWER')
  async planHistory(
    @Param('id') id: string,
    @Param('shapeHash') shapeHash: string,
    @Query('limit') limit?: string,
  ) {
    return this.planRegression.listForShape(id, shapeHash, limit ? parseInt(limit, 10) : 50);
  }

  /** Recent plan regressions across the connection. */
  @Get('plan-regressions') @RequireRole('VIEWER')
  async planRegressions(
    @Param('id') id: string,
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
  ) {
    const h = hours ? Math.min(Math.max(parseInt(hours, 10), 1), 24 * 90) : 168;
    return this.planRegression.listRegressions(id, {
      sinceMs: h * 3_600_000,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  /** Structured diff between two snapshots of the same shape. */
  @Get('plan-diff') @RequireRole('VIEWER')
  async planDiff(
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!from || !to) throw new BadRequestException('from and to snapshot ids required');
    return this.planRegression.diff(id, from, to);
  }

  // ---- Server-side cursor streaming (Postgres) ----

  /** Open a streaming cursor over a SELECT. Returns the first page + a cursor
   *  id to fetch subsequent pages without re-running the query. */
  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post('cursor') @HttpCode(200) @RequireRole('VIEWER')
  async cursorOpen(
    @Param('id') id: string,
    @Body() dto: CursorOpenDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ) {
    const role = (req as any).connectionRole as Role;
    return this.cursor.open({
      connectionId: id,
      userId: user.id,
      role,
      sql: dto.sql,
      pageSize: dto.pageSize ?? 1000,
    });
  }

  /** Fetch the next page from an open cursor. */
  @Throttle({ heavy: { limit: 120, ttl: 60_000 } })
  @Post('cursor/:cursorId/fetch') @HttpCode(200) @RequireRole('VIEWER')
  async cursorFetch(
    @Param('cursorId') cursorId: string,
    @Body() dto: CursorFetchDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cursor.fetch(cursorId, user.id, dto.pageSize ?? 1000);
  }

  /** Close an open cursor early. */
  @Post('cursor/:cursorId/close') @HttpCode(200) @RequireRole('VIEWER')
  async cursorClose(
    @Param('cursorId') cursorId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.cursor.close(cursorId, user.id);
  }

  // ---- Cross-dialect transpilation ----

  /** Transpile a SELECT from one dialect to another. `from` defaults to this
   *  connection's dialect. Correctness-first: refuses unparseable queries and
   *  warns on constructs whose semantics may not survive translation. */
  @Throttle({ heavy: { limit: 60, ttl: 60_000 } })
  @Post('transpile') @HttpCode(200) @RequireRole('VIEWER')
  async transpile(
    @Param('id') id: string,
    @Body() dto: TranspileDto,
  ) {
    const conn = await this.svc.get(id);
    const from = dto.from ?? conn.dialect;
    return this.transpiler.transpile(dto.sql, from, dto.to);
  }
}
