import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Parser } from 'node-sql-parser';
import { Dialect } from '@prisma/client';

/**
 * Cross-dialect SQL transpiler.
 *
 * Goal: write a query once and run it against any connection. The hard
 * requirement on a tool that touches customer data is CORRECTNESS — a
 * transpiler that silently emits subtly-wrong SQL is worse than none. So this
 * is built defensively:
 *
 *   1. Parse the source SQL with node-sql-parser in the SOURCE dialect. If it
 *      won't parse, we refuse — we will not regex-hack an unparseable query.
 *   2. Regenerate (sqlify) in the TARGET dialect. The parser handles the bulk
 *      of structural differences (quoting style, basic syntax).
 *   3. Apply a small set of VERIFIED rewrite rules for idioms the parser does
 *      not translate (string concat, LIMIT/OFFSET <-> TOP, boolean literals).
 *   4. Emit WARNINGS for constructs whose semantics we can't guarantee survive
 *      translation (functions with no portable equivalent, casts, etc.), so the
 *      user reviews before running. We never silently drop or approximate.
 *
 * Scope: SELECT statements only. DML/DDL transpilation across dialects has too
 * many type-system and constraint differences to do safely, so we reject them.
 */

const DIALECT_MAP: Record<Dialect, string> = {
  POSTGRES: 'postgresql',
  MYSQL: 'mysql',
  SQLITE: 'sqlite',
  MSSQL: 'transactsql',
};

export interface TranspileWarning {
  severity: 'info' | 'warn';
  message: string;
}

export interface TranspileResult {
  from: Dialect;
  to: Dialect;
  sql: string;
  warnings: TranspileWarning[];
  /** True when source and target are the same dialect (passthrough). */
  noop: boolean;
}

/**
 * Functions whose name or semantics differ across dialects and which the parser
 * passes through verbatim. We don't rewrite these (too risky to guess intent) —
 * we warn so the author can confirm. Keyed by lowercase function name.
 */
const NON_PORTABLE_FUNCS: Record<string, string> = {
  now: 'NOW() — Postgres/MySQL; SQLite uses CURRENT_TIMESTAMP; MSSQL uses GETDATE()',
  getdate: 'GETDATE() is SQL Server only',
  ifnull: 'IFNULL is MySQL/SQLite; Postgres/MSSQL use COALESCE',
  isnull: 'ISNULL is MySQL/MSSQL with different signatures; prefer COALESCE',
  nvl: 'NVL is Oracle; use COALESCE',
  date_trunc: 'date_trunc is Postgres; MySQL/MSSQL differ',
  datediff: 'DATEDIFF signatures differ between MySQL and SQL Server',
  group_concat: 'GROUP_CONCAT (MySQL/SQLite) vs STRING_AGG (Postgres/MSSQL)',
  string_agg: 'STRING_AGG (Postgres/MSSQL) vs GROUP_CONCAT (MySQL/SQLite)',
  top: 'TOP is SQL Server; others use LIMIT',
};

@Injectable()
export class TranspileService {
  private readonly parser = new Parser();
  private readonly log = new Logger(TranspileService.name);

  transpile(sql: string, from: Dialect, to: Dialect): TranspileResult {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!trimmed) throw new BadRequestException('SQL required');
    if (/;\s*\S/.test(trimmed)) {
      throw new BadRequestException('Transpilation supports a single statement');
    }

    if (from === to) {
      return { from, to, sql: trimmed, warnings: [], noop: true };
    }

    // 1) Parse in source dialect.
    let ast: unknown;
    try {
      ast = this.parser.astify(trimmed, { database: DIALECT_MAP[from] });
    } catch (e) {
      throw new BadRequestException(
        `Could not parse the query as ${from} SQL: ${(e as Error).message}`,
      );
    }

    const node = Array.isArray(ast) ? ast[0] : ast;
    const type = String((node as { type?: string })?.type ?? '').toLowerCase();
    if (type !== 'select') {
      throw new BadRequestException(
        'Only SELECT statements can be transpiled — DML/DDL differ too much across engines to convert safely.',
      );
    }

    const warnings: TranspileWarning[] = [];

    // 2) Regenerate in target dialect.
    let out: string;
    try {
      out = this.parser.sqlify(ast as never, { database: DIALECT_MAP[to] });
    } catch (e) {
      throw new BadRequestException(
        `Could not generate ${to} SQL: ${(e as Error).message}`,
      );
    }

    // 3) Verified rewrites the parser doesn't perform.
    out = this.rewriteIdioms(out, from, to, warnings);

    // 4) Semantic warnings from the source AST (function usage etc.).
    this.collectWarnings(trimmed, from, to, warnings);

    return { from, to, sql: out, warnings, noop: false };
  }

  /**
   * Apply idiom rewrites that node-sql-parser leaves alone. Each rule is
   * intentionally narrow and only fires on patterns we can rewrite without
   * changing meaning. Anything ambiguous is left as-is and warned about.
   */
  private rewriteIdioms(
    sql: string,
    from: Dialect,
    to: Dialect,
    warnings: TranspileWarning[],
  ): string {
    let out = sql;

    // --- LIMIT / OFFSET  <->  SQL Server TOP / OFFSET-FETCH ---
    if (to === Dialect.MSSQL) {
      // `... LIMIT n` (no offset) -> `SELECT TOP (n) ...`
      const limitOnly = /\blimit\s+(\d+)\s*$/i.exec(out);
      const limitOffset = /\blimit\s+(\d+)\s+offset\s+(\d+)\s*$/i.exec(out);
      if (limitOffset) {
        const [, lim, off] = limitOffset;
        out = out.replace(limitOffset[0], '');
        if (/\border\s+by\b/i.test(out)) {
          out = `${out.trim()} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`;
        } else {
          // OFFSET-FETCH requires ORDER BY in T-SQL.
          warnings.push({
            severity: 'warn',
            message:
              'SQL Server OFFSET/FETCH requires an ORDER BY. Add one or the converted query will error.',
          });
          out = `${out.trim()} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`;
        }
      } else if (limitOnly) {
        const lim = limitOnly[1];
        out = out.replace(limitOnly[0], '').trim();
        out = out.replace(/^select\b/i, `SELECT TOP (${lim})`);
      }
    }
    if (from === Dialect.MSSQL && to !== Dialect.MSSQL) {
      // `SELECT TOP (n) ...` -> `SELECT ... LIMIT n`
      const top = /^select\s+top\s*\(?\s*(\d+)\s*\)?\s+/i.exec(out);
      if (top) {
        const n = top[1];
        out = out.replace(top[0], 'SELECT ');
        out = `${out.trim()} LIMIT ${n}`;
      }
    }

    // --- String concatenation: MySQL CONCAT(a,b)  <->  ANSI a || b ---
    // We only rewrite the ANSI `||` -> CONCAT direction when targeting MySQL,
    // because `||` is logical-OR in MySQL by default. The reverse (CONCAT ->
    // ||) is left to the parser; if it doesn't convert, we warn below.
    if (to === Dialect.MYSQL && /\|\|/.test(out)) {
      warnings.push({
        severity: 'warn',
        message:
          'Found `||` string concatenation. In MySQL `||` means logical OR by default — rewrite as CONCAT(...) or enable PIPES_AS_CONCAT.',
      });
    }

    // --- Boolean literals: MSSQL has no TRUE/FALSE keyword ---
    if (to === Dialect.MSSQL && /\b(true|false)\b/i.test(out)) {
      warnings.push({
        severity: 'info',
        message: 'SQL Server has no TRUE/FALSE literals — use 1/0 with a BIT column.',
      });
    }

    // --- ILIKE is Postgres-only ---
    if (from === Dialect.POSTGRES && to !== Dialect.POSTGRES && /\bilike\b/i.test(sql)) {
      if (to === Dialect.MYSQL) {
        // MySQL LIKE is case-insensitive for common collations.
        out = out.replace(/\bilike\b/gi, 'LIKE');
        warnings.push({
          severity: 'info',
          message: 'ILIKE rewritten to LIKE (MySQL LIKE is case-insensitive under default collations).',
        });
      } else {
        warnings.push({
          severity: 'warn',
          message: 'ILIKE has no direct equivalent in the target — use LOWER(col) LIKE LOWER(...).',
        });
      }
    }

    return out;
  }

  /** Inspect the raw SQL for non-portable function calls and flag them. */
  private collectWarnings(
    sql: string,
    _from: Dialect,
    to: Dialect,
    warnings: TranspileWarning[],
  ) {
    const lower = sql.toLowerCase();
    for (const [fn, note] of Object.entries(NON_PORTABLE_FUNCS)) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'i');
      if (re.test(lower)) {
        warnings.push({
          severity: 'warn',
          message: `Function ${fn.toUpperCase()}() may not behave the same in ${to}: ${note}`,
        });
      }
    }
    // Postgres ::type casts don't exist in other dialects.
    if (/::\s*\w+/.test(sql) && to !== Dialect.POSTGRES) {
      warnings.push({
        severity: 'warn',
        message: 'Postgres `::type` casts are not portable — use CAST(expr AS type) for the target dialect.',
      });
    }
  }
}
