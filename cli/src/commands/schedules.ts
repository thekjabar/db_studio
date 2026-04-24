import { Command } from 'commander';
import { apiFetch } from '../index.js';

interface Schedule {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  lastStatus?: string | null;
}

export const schedules = new Command('schedules').description('Manage scheduled queries');

schedules
  .command('ls')
  .description('List schedules')
  .action(async () => {
    const rows = (await apiFetch('GET', '/schedules')) as Schedule[];
    if (rows.length === 0) {
      process.stdout.write('(no schedules)\n');
      return;
    }
    const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
    process.stdout.write(
      `${pad('ID', 26)} ${pad('CRON', 15)} ${pad('STATUS', 12)} NAME\n`,
    );
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.id, 26)} ${pad(r.cron, 15)} ${pad(r.enabled ? r.lastStatus ?? 'enabled' : 'disabled', 12)} ${r.name}\n`,
      );
    }
  });

schedules
  .command('run <id>')
  .description('Fire a schedule immediately (queue a run)')
  .action(async (id: string) => {
    const res = await apiFetch('POST', `/schedules/${id}/run`);
    process.stdout.write(JSON.stringify(res) + '\n');
  });
