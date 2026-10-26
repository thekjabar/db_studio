/**
 * Query Schema CLI.
 *
 * Talks to the key-authenticated API (`/api/v1/*`) with an API key minted in
 * the app under API keys. Config precedence (highest wins):
 *   1. flags                  --url, --token
 *   2. env                    QUERYSCHEMA_URL, QUERYSCHEMA_TOKEN
 *                             (DBSTUDIO_URL / DBSTUDIO_TOKEN still read — the
 *                              product was called DB Studio when the first
 *                              version of this shipped)
 *   3. ~/.queryschema/config.json  { url, token }   (or the old ~/.dbstudio/)
 *
 * No prompts: CI and shell pipelines are the audience. Every command writes
 * machine-readable output on stdout and diagnostics on stderr, so
 * `queryschema query … --format csv > out.csv` is always a clean file.
 */
import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connections } from './commands/connections.js';
import { query } from './commands/query.js';
import { tables } from './commands/tables.js';

/** Where the hosted API lives when nothing says otherwise. */
const DEFAULT_URL = 'https://queryschema.com/api/v1';

const program = new Command();
program
  .name('queryschema')
  .description('Command-line interface for Query Schema')
  .version('1.0.0')
  .option('--url <url>', `API base URL (default ${DEFAULT_URL})`)
  .option('--token <token>', 'API key (dbs_live_…)');

program.addCommand(connections);
program.addCommand(tables);
program.addCommand(query);

program.exitOverride();

// Not top-level await: the published build is a single CommonJS file (the one
// format Node runs from any path, with or without an extension, and the one
// commander — which is CJS — bundles into cleanly), and CJS has no top-level
// await.
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const e = err as Error & { code?: string };
    if (
      e.code === 'commander.help' ||
      e.code === 'commander.version' ||
      e.code === 'commander.helpDisplayed'
    ) {
      process.exit(0);
    }
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}

void main();

// ---------------- Shared config resolution ----------------

function readConfigFile(): { url?: string; token?: string } {
  for (const dir of ['.queryschema', '.dbstudio']) {
    const path = join(homedir(), dir, 'config.json');
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // A malformed file must not mask an otherwise-valid flag or env var.
    }
  }
  return {};
}

export function resolveConfig(opts?: { url?: string; token?: string }): {
  url: string;
  token: string;
} {
  const globalOpts = program.opts<{ url?: string; token?: string }>();
  const file = readConfigFile();
  const url =
    opts?.url ??
    globalOpts.url ??
    process.env.QUERYSCHEMA_URL ??
    process.env.DBSTUDIO_URL ??
    file.url ??
    DEFAULT_URL;
  const token =
    opts?.token ??
    globalOpts.token ??
    process.env.QUERYSCHEMA_TOKEN ??
    process.env.DBSTUDIO_TOKEN ??
    file.token;

  if (!token) {
    throw new Error(
      'API key required. Create one in Query Schema → API keys, then set QUERYSCHEMA_TOKEN, pass --token, or write ~/.queryschema/config.json',
    );
  }
  return { url: url.replace(/\/$/, ''), token };
}

export async function apiFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const { url, token } = resolveConfig();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      msg += `: ${parsed.message ?? text}`;
    } catch {
      msg += text ? `: ${text.slice(0, 200)}` : '';
    }
    // 429 carries the retry hint in the message already; surface it as-is.
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}

/** Render rows as an aligned text table — the default, human-facing output. */
export function printTable(columns: string[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    process.stdout.write('(no rows)\n');
    return;
  }
  const cell = (v: unknown) =>
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length)),
  );
  const line = (cells: string[]) =>
    cells.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd() + '\n';
  process.stdout.write(line(columns));
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const r of rows) process.stdout.write(line(columns.map((c) => cell(r[c]))));
}

/** CSV with the quoting rules every spreadsheet agrees on. */
export function printCsv(columns: string[], rows: Record<string, unknown>[]): void {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  process.stdout.write(columns.join(',') + '\n');
  for (const r of rows) process.stdout.write(columns.map((c) => esc(r[c])).join(',') + '\n');
}
