import { Command } from 'commander';
import { apiFetch } from '../index.js';

export const connections = new Command('connections').description('List + inspect database connections');

interface ConnSummary {
  id: string;
  name: string;
  dialect: string;
  readOnly?: boolean;
}

connections
  .command('ls')
  .description('List connections')
  .option('--json', 'Emit raw JSON')
  .action(async (opts: { json?: boolean }) => {
    const rows = (await apiFetch('GET', '/connections')) as ConnSummary[];
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('(no connections)\n');
      return;
    }
    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    process.stdout.write(`${pad('ID', 26)} ${pad('DIALECT', 10)} ${pad('NAME', 40)}\n`);
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.id, 26)} ${pad(r.dialect, 10)} ${pad(r.name, 40)}\n`,
      );
    }
  });

connections
  .command('get <id>')
  .description('Show one connection')
  .action(async (id: string) => {
    const row = await apiFetch('GET', `/connections/${id}`);
    process.stdout.write(JSON.stringify(row, null, 2) + '\n');
  });
