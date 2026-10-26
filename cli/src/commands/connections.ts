import { Command } from 'commander';
import { apiFetch, printCsv, printTable } from '../index.js';

interface Conn {
  id: string;
  name: string;
  dialect: string;
  readOnly?: boolean;
  viaAgent?: boolean;
}

export const connections = new Command('connections')
  .alias('conn')
  .description('List the connections this API key can use');

connections
  .command('ls', { isDefault: true })
  .description('List connections')
  .option('--format <fmt>', 'Output: table | json | csv', 'table')
  .action(async (opts: { format?: string }) => {
    const rows = (await apiFetch('GET', '/connections')) as Conn[];
    if (opts.format === 'json') {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    const cols = ['id', 'name', 'dialect', 'readOnly', 'viaAgent'];
    const data = rows.map((r) => ({ ...r, readOnly: !!r.readOnly, viaAgent: !!r.viaAgent }));
    if (opts.format === 'csv') printCsv(cols, data as unknown as Record<string, unknown>[]);
    else printTable(cols, data as unknown as Record<string, unknown>[]);
  });
