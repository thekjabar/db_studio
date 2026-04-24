/**
 * Pure evaluator for alert conditions. Kept in its own module so it can
 * be unit-tested without Prisma / BullMQ wiring.
 *
 * Condition shapes (serialized as JSON on `ScheduledQuery.alertCondition`):
 *
 *   { op: 'rows_gt', value: 0 }              // at least one row returned
 *   { op: 'rows_gt', value: 100 }            // many rows
 *   { op: 'rows_eq', value: 0 }              // empty-set — "something I expected is missing"
 *   { column: 'count', op: 'gt', value: 5 }  // numeric comparison against a cell
 *   { column: 'failed', op: 'gte', value: 1 }
 *
 * All column comparisons use the FIRST row — alert queries are expected
 * to produce a single summary row (`SELECT count(*) FROM ...`). This
 * matches how almost every real alert rule is written.
 */

export type AlertOp =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'neq'
  | 'rows_gt'
  | 'rows_gte'
  | 'rows_lt'
  | 'rows_eq';

export interface AlertCondition {
  column?: string;
  op: AlertOp;
  value: number;
}

export interface AlertOutcome {
  triggered: boolean;
  /** Human-readable summary of why (for run history + notification body). */
  summary: string;
}

export function evaluateAlert(
  cond: AlertCondition | null | undefined,
  rows: Record<string, unknown>[],
): AlertOutcome {
  if (!cond) return { triggered: false, summary: 'no alert condition' };
  // Row-count-based operators ignore `column`.
  if (cond.op.startsWith('rows_')) {
    const count = rows.length;
    const match = compare(count, cond.op.replace(/^rows_/, '') as AlertOp, cond.value);
    return {
      triggered: match,
      summary: `rows=${count} ${operatorSymbol(cond.op)} ${cond.value}`,
    };
  }
  if (!cond.column) {
    return { triggered: false, summary: 'invalid condition: missing column' };
  }
  if (rows.length === 0) {
    return { triggered: false, summary: 'no rows returned; nothing to evaluate' };
  }
  const cell = rows[0][cond.column];
  const num = toNumber(cell);
  if (num === null) {
    return {
      triggered: false,
      summary: `column "${cond.column}" is not numeric (value=${stringify(cell)})`,
    };
  }
  const match = compare(num, cond.op, cond.value);
  return {
    triggered: match,
    summary: `${cond.column}=${num} ${operatorSymbol(cond.op)} ${cond.value}`,
  };
}

function compare(a: number, op: AlertOp, b: number): boolean {
  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'eq':
      return a === b;
    case 'neq':
      return a !== b;
    default:
      return false;
  }
}

function operatorSymbol(op: AlertOp): string {
  switch (op) {
    case 'gt':
    case 'rows_gt':
      return '>';
    case 'gte':
    case 'rows_gte':
      return '>=';
    case 'lt':
    case 'rows_lt':
      return '<';
    case 'lte':
      return '<=';
    case 'eq':
    case 'rows_eq':
      return '==';
    case 'neq':
      return '!=';
  }
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  // pg driver returns bigint / numeric as string sometimes.
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return '[object]';
    }
  }
  return String(v);
}
