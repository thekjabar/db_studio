import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { SqlClassifierService } from './sql-classifier.service';

export type ExplainMode = 'plan' | 'analyze';
export type WarningSeverity = 'info' | 'warn' | 'error';

export interface ExplainWarning {
  severity: WarningSeverity;
  message: string;
  /** Path in the plan tree, e.g. "Plan > Nested Loop > Seq Scan on users". */
  nodePath?: string;
}

/** A flattened plan node suitable for UI rendering. */
export interface PlanNode {
  id: string;
  parentId: string | null;
  depth: number;
  label: string;
  nodeType: string;
  relation?: string;
  totalCost?: number;
  startupCost?: number;
  planRows?: number;
  actualRows?: number;
  actualTotalMs?: number;
  warnings: ExplainWarning[];
}

export interface ExplainResult {
  dialect: Dialect;
  mode: ExplainMode;
  /** Raw plan JSON/text from the DB for users who want the original output. */
  raw: unknown;
  /** Flattened tree for the UI. Order = depth-first preorder. */
  nodes: PlanNode[];
  warnings: ExplainWarning[];
  totalCost?: number;
  totalTimeMs?: number;
  planTimeMs?: number;
  executionTimeMs?: number;
}

// Thresholds for "this query is expensive". Intentionally lenient so we only
// flag things worth a user's attention — precise tuning is DB-specific.
const HIGH_COST = 10_000;
const HIGH_ROWS = 10_000;
const WAY_OFF_ESTIMATE_RATIO = 10;

@Injectable()
export class ExplainService {
  private readonly log = new Logger(ExplainService.name);

  constructor(
    private readonly connections: ConnectionsService,
    private readonly classifier: SqlClassifierService,
  ) {}

  async explain(
    userId: string,
    connectionId: string,
    sql: string,
    mode: ExplainMode,
  ): Promise<ExplainResult> {
    if (!sql || !sql.trim()) throw new BadRequestException('SQL required');

    // The underlying runRawQuery already filters multi-statements and DDL —
    // we lean on the classifier only to decide whether ANALYZE needs a rollback.
    const drv = await this.connections.buildDriverForRole(connectionId, Role.OWNER);
    try {
      switch (drv.dialect) {
        case Dialect.POSTGRES:
          return this.explainPostgres(drv, sql, mode);
        case Dialect.MYSQL:
          return this.explainMysql(drv, sql, mode);
        case Dialect.SQLITE:
          return this.explainSqlite(drv, sql);
        case Dialect.MSSQL:
          return this.explainMssql(drv, sql, mode);
        default:
          throw new BadRequestException(`EXPLAIN not implemented for ${drv.dialect}`);
      }
    } finally {
      await drv.close().catch(() => {});
    }
  }

  // --------------- Postgres ---------------

  private async explainPostgres(
    drv: { dialect: Dialect; runRawQuery: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
    sql: string,
    mode: ExplainMode,
  ): Promise<ExplainResult> {
    const classification = this.classifier.classify(sql, Dialect.POSTGRES);
    const isMutation = classification.kind === 'DML' || classification.kind === 'DESTRUCTIVE';

    const opts: string[] = ['FORMAT JSON', 'VERBOSE FALSE', 'SETTINGS FALSE'];
    if (mode === 'analyze') {
      opts.push('ANALYZE TRUE', 'BUFFERS TRUE');
    }
    const explainSql = `EXPLAIN (${opts.join(', ')}) ${sql.replace(/;\s*$/, '')}`;

    // Mutations with ANALYZE must run inside a transaction we roll back, so the
    // query executes (produces real timings) but nothing persists.
    let rawRows: Record<string, unknown>[];
    if (mode === 'analyze' && isMutation) {
      await drv.runRawQuery('BEGIN');
      try {
        const r = await drv.runRawQuery(explainSql);
        rawRows = r.rows;
      } finally {
        await drv.runRawQuery('ROLLBACK').catch(() => {});
      }
    } else {
      const r = await drv.runRawQuery(explainSql);
      rawRows = r.rows;
    }

    // Postgres returns a single column "QUERY PLAN" whose value is a JSON array
    // with one element.
    const first = rawRows[0] ?? {};
    const planCol = (first['QUERY PLAN'] ?? first['query plan'] ?? Object.values(first)[0]) as unknown;
    const planArr = Array.isArray(planCol) ? planCol : typeof planCol === 'string' ? JSON.parse(planCol) : [planCol];
    const top = planArr[0] as Record<string, unknown>;
    const rootPlan = top?.Plan as Record<string, unknown> | undefined;

    const nodes: PlanNode[] = [];
    const warnings: ExplainWarning[] = [];
    if (rootPlan) this.walkPostgres(rootPlan, null, 0, nodes, warnings);

    const planTime = typeof top?.['Planning Time'] === 'number' ? (top['Planning Time'] as number) : undefined;
    const execTime = typeof top?.['Execution Time'] === 'number' ? (top['Execution Time'] as number) : undefined;

    return {
      dialect: Dialect.POSTGRES,
      mode,
      raw: planArr,
      nodes,
      warnings,
      totalCost: nodes[0]?.totalCost,
      planTimeMs: planTime,
      executionTimeMs: execTime,
      totalTimeMs:
        planTime !== undefined || execTime !== undefined
          ? (planTime ?? 0) + (execTime ?? 0)
          : undefined,
    };
  }

  private walkPostgres(
    plan: Record<string, unknown>,
    parentId: string | null,
    depth: number,
    out: PlanNode[],
    warnings: ExplainWarning[],
  ) {
    const id = `n${out.length}`;
    const nodeType = String(plan['Node Type'] ?? 'Unknown');
    const relation = plan['Relation Name'] ? String(plan['Relation Name']) : undefined;
    const totalCost = typeof plan['Total Cost'] === 'number' ? (plan['Total Cost'] as number) : undefined;
    const startupCost = typeof plan['Startup Cost'] === 'number' ? (plan['Startup Cost'] as number) : undefined;
    const planRows = typeof plan['Plan Rows'] === 'number' ? (plan['Plan Rows'] as number) : undefined;
    const actualRows = typeof plan['Actual Rows'] === 'number' ? (plan['Actual Rows'] as number) : undefined;
    const actualTotalMs = typeof plan['Actual Total Time'] === 'number' ? (plan['Actual Total Time'] as number) : undefined;

    const label = relation ? `${nodeType} on ${relation}` : nodeType;
    const nodeWarnings: ExplainWarning[] = [];

    // Sequential scan on something big
    if (nodeType === 'Seq Scan' && ((actualRows ?? planRows ?? 0) > HIGH_ROWS)) {
      nodeWarnings.push({
        severity: 'warn',
        message: `Sequential scan on ${relation ?? 'table'} reads ${actualRows ?? planRows} rows — consider an index`,
        nodePath: label,
      });
    }
    // Expensive node overall
    if (totalCost !== undefined && totalCost > HIGH_COST) {
      nodeWarnings.push({
        severity: 'warn',
        message: `High planner cost on ${label} (${totalCost.toFixed(0)})`,
        nodePath: label,
      });
    }
    // Plan vs actual row estimate way off (ANALYZE only)
    if (planRows !== undefined && actualRows !== undefined && actualRows > 0) {
      const ratio = Math.max(planRows, actualRows) / Math.max(1, Math.min(planRows, actualRows));
      if (ratio > WAY_OFF_ESTIMATE_RATIO && actualRows > 1000) {
        nodeWarnings.push({
          severity: 'info',
          message: `Row estimate off by ${ratio.toFixed(0)}× on ${label} (planned ${planRows}, got ${actualRows}) — ANALYZE the table?`,
          nodePath: label,
        });
      }
    }
    // Nested loop over many rows on the outer side
    if (nodeType === 'Nested Loop' && (actualRows ?? planRows ?? 0) > 100_000) {
      nodeWarnings.push({
        severity: 'warn',
        message: `Nested Loop with ${actualRows ?? planRows} rows — hash/merge join may be cheaper`,
        nodePath: label,
      });
    }

    warnings.push(...nodeWarnings);
    out.push({
      id,
      parentId,
      depth,
      label,
      nodeType,
      relation,
      totalCost,
      startupCost,
      planRows,
      actualRows,
      actualTotalMs,
      warnings: nodeWarnings,
    });

    const children = plan['Plans'] as Record<string, unknown>[] | undefined;
    if (Array.isArray(children)) {
      for (const c of children) this.walkPostgres(c, id, depth + 1, out, warnings);
    }
  }

  // --------------- MySQL ---------------

  private async explainMysql(
    drv: { dialect: Dialect; runRawQuery: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
    sql: string,
    mode: ExplainMode,
  ): Promise<ExplainResult> {
    // MySQL supports FORMAT=JSON. ANALYZE requires MySQL 8.0.18+; we prefer
    // EXPLAIN FORMAT=JSON for broad compatibility and do not run ANALYZE by
    // default (it would mutate).
    const prefix = mode === 'analyze' ? 'EXPLAIN ANALYZE FORMAT=JSON' : 'EXPLAIN FORMAT=JSON';
    const r = await drv.runRawQuery(`${prefix} ${sql.replace(/;\s*$/, '')}`);
    const first = r.rows[0] ?? {};
    const planStr = String(Object.values(first)[0] ?? '');
    let raw: unknown = planStr;
    try {
      raw = JSON.parse(planStr);
    } catch {
      /* leave as string */
    }
    // MySQL's JSON plan is a nested tree of "query_block" / "table" entries —
    // parsing that well takes a fair bit of code. For now we surface the raw
    // tree and warn only based on missing indexes heuristics we can see at the
    // top level.
    const nodes: PlanNode[] = [];
    const warnings: ExplainWarning[] = [];
    if (raw && typeof raw === 'object') {
      this.walkMysql(raw as Record<string, unknown>, null, 0, nodes, warnings);
    }
    return { dialect: Dialect.MYSQL, mode, raw, nodes, warnings };
  }

  private walkMysql(
    obj: Record<string, unknown>,
    parentId: string | null,
    depth: number,
    out: PlanNode[],
    warnings: ExplainWarning[],
  ) {
    // Heuristic walk: any "table" node is interesting; any "query_block" is a
    // grouping layer. Full MySQL plan shape is documented at
    // dev.mysql.com/doc/refman/8.0/en/explain-output.html.
    if (obj.table && typeof obj.table === 'object') {
      const t = obj.table as Record<string, unknown>;
      const id = `n${out.length}`;
      const name = String(t.table_name ?? 'table');
      const accessType = String(t.access_type ?? '');
      const rows = typeof t.rows_examined_per_scan === 'number' ? (t.rows_examined_per_scan as number) : undefined;
      const nodeWarnings: ExplainWarning[] = [];
      if (accessType === 'ALL' && (rows ?? 0) > HIGH_ROWS) {
        nodeWarnings.push({
          severity: 'warn',
          message: `Full table scan on ${name} (${rows} rows)`,
          nodePath: name,
        });
      }
      warnings.push(...nodeWarnings);
      out.push({
        id,
        parentId,
        depth,
        label: `${accessType || 'table'} on ${name}`,
        nodeType: accessType || 'table',
        relation: name,
        planRows: rows,
        warnings: nodeWarnings,
      });
      parentId = id;
      depth += 1;
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) v.forEach((x) => this.walkMysql(x as Record<string, unknown>, parentId, depth, out, warnings));
        else this.walkMysql(v as Record<string, unknown>, parentId, depth, out, warnings);
      }
    }
  }

  // --------------- SQLite ---------------

  private async explainSqlite(
    drv: { dialect: Dialect; runRawQuery: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
    sql: string,
  ): Promise<ExplainResult> {
    const r = await drv.runRawQuery(`EXPLAIN QUERY PLAN ${sql.replace(/;\s*$/, '')}`);
    // SQLite returns rows: {id, parent, notused, detail}
    const nodes: PlanNode[] = r.rows.map((row, i) => {
      const detail = String(row.detail ?? '');
      const nodeWarnings: ExplainWarning[] = [];
      if (/SCAN TABLE/i.test(detail)) {
        nodeWarnings.push({
          severity: 'warn',
          message: `Table scan: ${detail}`,
          nodePath: detail,
        });
      }
      return {
        id: `n${i}`,
        parentId: row.parent !== undefined && Number(row.parent) > 0 ? `n${Number(row.parent) - 1}` : null,
        depth: 0,
        label: detail,
        nodeType: detail.split(' ')[0] ?? 'Step',
        warnings: nodeWarnings,
      };
    });
    const warnings = nodes.flatMap((n) => n.warnings);
    return { dialect: Dialect.SQLITE, mode: 'plan', raw: r.rows, nodes, warnings };
  }

  // --------------- MSSQL ---------------

  private async explainMssql(
    drv: { dialect: Dialect; runRawQuery: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> },
    sql: string,
    mode: ExplainMode,
  ): Promise<ExplainResult> {
    // SHOWPLAN_XML returns the plan without executing. ANALYZE-equivalent is
    // STATISTICS XML which runs the query; skip for now and return plan only.
    if (mode === 'analyze') {
      throw new BadRequestException('EXPLAIN ANALYZE is not yet implemented for SQL Server');
    }
    await drv.runRawQuery('SET SHOWPLAN_XML ON');
    try {
      const r = await drv.runRawQuery(sql);
      const planXml = String(Object.values(r.rows[0] ?? {})[0] ?? '');
      return {
        dialect: Dialect.MSSQL,
        mode: 'plan',
        raw: planXml,
        // XML plan parsing would be a separate module; surface as raw for now.
        nodes: [],
        warnings: [{
          severity: 'info',
          message: 'XML plan returned — node-level analysis for SQL Server is not yet implemented.',
        }],
      };
    } finally {
      await drv.runRawQuery('SET SHOWPLAN_XML OFF').catch(() => {});
    }
  }
}
