import { Injectable } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';
import { ExplainService, type PlanNode } from './explain.service';

export interface IndexSuggestion {
  table: string;
  columns: string[];
  reason: string;
  /** Dialect-appropriate CREATE INDEX statement. */
  sql: string;
  /** Estimated rows the index would help skip. */
  impact?: number;
}

export interface PerfInsights {
  dialect: Dialect;
  /** User-facing findings from the plan. */
  findings: {
    severity: 'info' | 'warn' | 'error';
    title: string;
    detail: string;
    nodePath?: string;
  }[];
  suggestions: IndexSuggestion[];
  plan: PlanNode[];
  totalCost?: number;
  totalTimeMs?: number;
}

const SEQ_SCAN_ROW_THRESHOLD = 1_000;

/**
 * Analyzes a query's EXPLAIN plan and produces actionable findings plus
 * (where it's safe to guess) index suggestions. Intentionally conservative:
 *
 *   - Only suggests indexes when the plan clearly identifies a selective
 *     filter column on a table being sequentially scanned.
 *   - Never claims the index will help — just presents the CREATE INDEX
 *     statement + the evidence, so the user decides.
 *
 * The findings extend the `warnings` that ExplainService already surfaces —
 * those stay the ground truth for in-editor warnings; this service turns
 * them into a dedicated insights tab with index CTAs.
 */
@Injectable()
export class PerfInsightsService {
  constructor(
    private readonly explain: ExplainService,
    private readonly connections: ConnectionsService,
  ) {}

  async analyze(userId: string, connectionId: string, sql: string): Promise<PerfInsights> {
    const conn = await this.connections.get(connectionId);
    const plan = await this.explain.explain(userId, connectionId, sql, 'plan');
    const findings: PerfInsights['findings'] = plan.warnings.map((w) => ({
      severity: w.severity,
      title: deriveTitle(w.message),
      detail: w.message,
      nodePath: w.nodePath,
    }));

    // Pull WHERE/JOIN predicates from the SQL text. A proper parser would be
    // better but sqlparser-rs / libpg_query are heavy. The heuristic catches
    // the common cases: `col = value`, `col IN (...)`, `col > value`.
    const predicates = extractPredicates(sql);

    const suggestions: IndexSuggestion[] = [];
    const seenKeys = new Set<string>();
    for (const node of plan.nodes) {
      if (!isSequentialScan(node)) continue;
      if ((node.actualRows ?? node.planRows ?? 0) < SEQ_SCAN_ROW_THRESHOLD) continue;
      if (!node.relation) continue;
      const matched = predicates.filter((p) =>
        node.relation!.toLowerCase().endsWith(p.table.toLowerCase()) ||
        p.table === '', // unqualified predicates against the only scanned table
      );
      if (matched.length === 0) continue;
      const cols = dedupe(matched.map((m) => m.column));
      if (cols.length === 0) continue;
      const key = `${node.relation}:${cols.join(',')}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      suggestions.push({
        table: node.relation,
        columns: cols,
        reason: `Sequential scan on ${node.relation} filtered by ${cols.join(', ')} — estimated ${
          node.actualRows ?? node.planRows ?? '?'
        } rows scanned.`,
        sql: renderCreateIndex(conn.dialect, node.relation, cols),
        impact: node.actualRows ?? node.planRows,
      });
    }

    return {
      dialect: conn.dialect,
      findings,
      suggestions,
      plan: plan.nodes,
      totalCost: plan.totalCost,
      totalTimeMs: plan.totalTimeMs,
    };
  }
}

function deriveTitle(msg: string): string {
  const first = msg.split(/[.—–]/)[0];
  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

function isSequentialScan(n: PlanNode): boolean {
  const t = n.nodeType.toLowerCase();
  return t.includes('seq scan') || t.includes('table scan') || t === 'full' || t === 'all';
}

interface Predicate {
  table: string;
  column: string;
}

function extractPredicates(sql: string): Predicate[] {
  // Strip line + block comments and string literals — predicates in user data
  // shouldn't be picked up by the regex.
  const cleaned = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/"(?:""|[^"])*"/g, '"?"');

  // Find WHERE and JOIN ... ON clauses. For each, capture `table.column OP ...`
  // or `column OP ...`. This won't handle every AST shape but catches the
  // common "where name = 'x'" cases.
  const results: Predicate[] = [];
  const clauseRe = /\b(?:where|on)\b([\s\S]+?)(?=\b(?:group|order|limit|having|join|union|select|$)\b|\)|\s*$)/gi;
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(cleaned))) {
    const body = m[1];
    const predRe = /\b(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(=|<>|!=|>=|<=|>|<|\bIN\b|\bLIKE\b)/gi;
    let p: RegExpExecArray | null;
    while ((p = predRe.exec(body))) {
      const table = (p[1] ?? '').toLowerCase();
      const column = p[2].toLowerCase();
      // Skip boolean keywords + aggregates.
      if (['and', 'or', 'not', 'true', 'false', 'null'].includes(column)) continue;
      results.push({ table, column });
    }
  }
  return results;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function renderCreateIndex(dialect: Dialect, relation: string, columns: string[]): string {
  // relation may be "schema.table" or just "table".
  const idxName = `idx_${relation.replace(/\./g, '_')}_${columns.join('_')}`.slice(0, 60);
  const qTable = quoteQualified(relation, dialect);
  const qCols = columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const qIdx = quoteIdent(idxName, dialect);
  if (dialect === Dialect.POSTGRES) {
    return `CREATE INDEX CONCURRENTLY ${qIdx} ON ${qTable} (${qCols});`;
  }
  return `CREATE INDEX ${qIdx} ON ${qTable} (${qCols});`;
}

function quoteIdent(name: string, dialect: Dialect): string {
  if (dialect === Dialect.MYSQL) return `\`${name.replace(/`/g, '``')}\``;
  if (dialect === Dialect.MSSQL) return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(relation: string, dialect: Dialect): string {
  if (!relation.includes('.')) return quoteIdent(relation, dialect);
  return relation
    .split('.')
    .map((p) => quoteIdent(p, dialect))
    .join('.');
}

// Silence unused-import warnings for constants we might expose later.
void Role;
