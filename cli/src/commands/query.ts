import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { apiFetch, printCsv, printTable } from '../index.js';

interface QueryResult {
  fields: { name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
  rowCount?: number;
  durationMs?: number;
  truncated?: boolean;
}

/**
 * `--param name=value`, repeatable.
 *
 * Values are sent as JSON and BOUND by the API, never pasted into the SQL, so
 * `--param name="'; drop table users --"` is just a string to match. The
 * conversion here mirrors the editor's: a bare number is a number, true/false
 * is a boolean, `null` (or an empty value) is NULL, everything else is text.
 */
function parseParam(raw: string, acc: Record<string, unknown>): Record<string, unknown> {
  const eq = raw.indexOf('=');
  if (eq <= 0) throw new Error(`--param expects name=value (got "${raw}")`);
  const name = raw.slice(0, eq).trim();
  const value = raw.slice(eq + 1);
  const t = value.trim();
  if (t === '' || t.toLowerCase() === 'null') acc[name] = null;
  else if (t.toLowerCase() === 'true') acc[name] = true;
  else if (t.toLowerCase() === 'false') acc[name] = false;
  else if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) acc[name] = Number(t);
  else acc[name] = value;
  return acc;
}

export const query = new Command('query')
  .description('Run SQL against a connection')
  .argument('<connectionId>', 'Connection id (see `queryschema connections ls`)')
  .option('-s, --sql <sql>', 'Inline SQL statement')
  .option('-f, --file <path>', 'Read SQL from a file ("-" for stdin)')
  .option('-p, --param <name=value>', 'Value for a :named parameter (repeatable)', parseParam, {})
  .option('--max-rows <n>', 'Row cap (0 = no cap)', '1000')
  .option('--confirm-destructive', 'Allow DELETE/DROP/TRUNCATE/UPDATE without a WHERE', false)
  .option('--format <fmt>', 'Output: table | json | csv', 'table')
  .action(
    async (
      connectionId: string,
      opts: {
        sql?: string;
        file?: string;
        param: Record<string, unknown>;
        maxRows?: string;
        confirmDestructive?: boolean;
        format?: string;
      },
    ) => {
      let sql = opts.sql;
      if (!sql && opts.file) {
        sql = opts.file === '-' ? readFileSync(0, 'utf8') : readFileSync(opts.file, 'utf8');
      }
      if (!sql) throw new Error('Provide --sql or --file');

      const res = (await apiFetch('POST', `/connections/${connectionId}/query`, {
        sql,
        params: opts.param,
        maxRows: Number(opts.maxRows ?? 1000),
        confirmDestructive: !!opts.confirmDestructive,
      })) as QueryResult;

      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        return;
      }
      const cols = res.fields.length
        ? res.fields.map((f) => f.name)
        : Object.keys(res.rows[0] ?? {});
      if (opts.format === 'csv') {
        printCsv(cols, res.rows);
        return;
      }
      printTable(cols, res.rows);
      // Counts go to stderr so `> out.txt` keeps only the data.
      process.stderr.write(
        `${res.rowCount ?? res.rows.length} rows · ${res.durationMs ?? 0}ms${
          res.truncated ? ' · truncated (raise --max-rows)' : ''
        }\n`,
      );
    },
  );
