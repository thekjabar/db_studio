import { Injectable } from '@nestjs/common';
import { ExplainService, type PlanNode } from './explain.service';

export interface QueryCostEstimate {
  /** Rough row-scan estimate summed over the plan nodes. */
  estimatedRowsScanned: number;
  /** Planner's cost number (dialect-specific units). */
  plannerCost: number | null;
  /** Human-readable duration estimate. */
  estimatedDurationMs: number;
  /** UX-facing verdict: fast / moderate / slow / dangerous. */
  verdict: 'fast' | 'moderate' | 'slow' | 'dangerous';
  /** Warnings to show alongside the estimate. */
  warnings: string[];
}

const MS_PER_ROW_SCANNED = 0.0001; // 10M rows/sec guesstimate
const DANGEROUS_ROWS = 50_000_000;
const SLOW_ROWS = 5_000_000;
const MODERATE_ROWS = 500_000;

@Injectable()
export class QueryCostService {
  constructor(private readonly explain: ExplainService) {}

  async estimate(
    userId: string,
    connectionId: string,
    sql: string,
  ): Promise<QueryCostEstimate> {
    const plan = await this.explain.explain(userId, connectionId, sql, 'plan');
    const rowsScanned = plan.nodes.reduce(
      (acc: number, n: PlanNode) => acc + (n.planRows ?? 0),
      0,
    );
    const plannerCost = plan.totalCost ?? null;

    const warnings: string[] = [];
    if (rowsScanned > DANGEROUS_ROWS) {
      warnings.push('Query may scan tens of millions of rows — consider an index or a LIMIT.');
    } else if (rowsScanned > SLOW_ROWS) {
      warnings.push(`Query will scan ~${fmt(rowsScanned)} rows. That's a lot — expect slow response.`);
    }
    for (const node of plan.nodes) {
      if (/seq\s?scan|full scan|table scan/i.test(node.nodeType) && (node.planRows ?? 0) > 10_000) {
        warnings.push(
          `Sequential scan on ${node.relation ?? 'a table'} with ~${fmt(node.planRows ?? 0)} rows.`,
        );
        break; // one warning is enough
      }
    }

    const verdict: QueryCostEstimate['verdict'] =
      rowsScanned > DANGEROUS_ROWS
        ? 'dangerous'
        : rowsScanned > SLOW_ROWS
          ? 'slow'
          : rowsScanned > MODERATE_ROWS
            ? 'moderate'
            : 'fast';

    return {
      estimatedRowsScanned: rowsScanned,
      plannerCost,
      estimatedDurationMs: Math.round(rowsScanned * MS_PER_ROW_SCANNED),
      verdict,
      warnings,
    };
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
