import { Command } from 'commander';
import { apiFetch } from '../index.js';

/** `tables` and `schemas` — the introspection a script needs before it can
 *  decide what to query. Output is one name per line so it pipes into xargs. */
export const tables = new Command('tables')
  .description('List tables in a connection')
  .argument('<connectionId>', 'Connection id')
  .option('--schema <name>', 'Schema to list', 'public')
  .option('--format <fmt>', 'Output: lines | json', 'lines')
  .action(
    async (connectionId: string, opts: { schema?: string; format?: string }) => {
      const rows = (await apiFetch(
        'GET',
        `/connections/${connectionId}/tables?schema=${encodeURIComponent(opts.schema ?? 'public')}`,
      )) as { name: string; schema: string }[];
      if (opts.format === 'json') {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
        return;
      }
      for (const r of rows) process.stdout.write(r.name + '\n');
    },
  );

tables
  .command('schemas')
  .description('List schemas in a connection')
  .argument('<connectionId>', 'Connection id')
  .action(async (connectionId: string) => {
    const names = (await apiFetch('GET', `/connections/${connectionId}/schemas`)) as string[];
    for (const n of names) process.stdout.write(n + '\n');
  });
