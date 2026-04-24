import { Command } from 'commander';
import { apiFetch } from '../index.js';
import { readFileSync } from 'node:fs';

interface QueryResult {
  fields: { name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
  rowCount?: number;
  durationMs?: number;
}

export const query = new Command('query')
  .description('Run SQL against a connection')
  .argument('<connectionId>', 'Connection id (see `dbstudio connections ls`)')
  .option('-s, --sql <sql>', 'Inline SQL statement')
  .option('-f, --file <path>', 'Read SQL from a file')
  .option('--max-rows <n>', 'Row cap (0 = no cap)', '1000')
  .option('--format <fmt>', 'Output: table | json | csv', 'table')
  .action(
    async (
      connectionId: string,
      opts: { sql?: string; file?: string; maxRows?: string; format?: string },
    ) => {
      let sql = opts.sql;
      if (!sql && opts.file) sql = readFileSync(opts.file, 'utf8');
      if (!sql) throw new Error('Provide --sql or --file');

      const res = (await apiFetch('POST', `/connections/${connectionId}/query`, {
        sql,
        maxRows: Number(opts.maxRows ?? 1000),
      })) as QueryResult;

      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        return;
      }
      if (opts.format === 'csv') {
        const cols = res.fields.map((f) => f.name);
        const esc = (v: unknown) => {
          if (v === null || v === undefined) return '';
          const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        process.stdout.write(cols.join(',') + '\n');
        for (const r of res.rows) {
          process.stdout.write(cols.map((c) => esc(r[c])).join(',') + '\n');
        }
        return;
      }
      // table
      const cols = res.fields.map((f) => f.name);
      if (cols.length === 0 || res.rows.length === 0) {
        process.stdout.write(`(${res.rowCount ?? 0} rows)\n`);
        return;
      }
      const widths = cols.map((c) =>
        Math.max(
          c.length,
          ...res.rows.slice(0, 1000).map((r) => String(r[c] ?? '').length),
        ),
      );
      const line = widths.map((w) => '-'.repeat(w)).join('-+-');
      process.stdout.write(cols.map((c, i) => c.padEnd(widths[i])).join(' | ') + '\n');
      process.stdout.write(line + '\n');
      for (const r of res.rows) {
        process.stdout.write(
          cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join(' | ') + '\n',
        );
      }
      process.stdout.write(`(${res.rowCount ?? res.rows.length} rows, ${res.durationMs ?? '?'}ms)\n`);
    },
  );
