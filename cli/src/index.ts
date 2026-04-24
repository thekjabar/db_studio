#!/usr/bin/env node
/**
 * DB Studio CLI.
 *
 * Talks to a DB Studio API via an API key. Config precedence (highest wins):
 *   1. CLI flags              --url, --token
 *   2. Env vars                DBSTUDIO_URL, DBSTUDIO_TOKEN
 *   3. ~/.dbstudio/config.json { url, token }
 *
 * No TTY prompts in v1 — scripts / CI is the primary audience.
 */
import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connections } from './commands/connections.js';
import { query } from './commands/query.js';
import { schedules } from './commands/schedules.js';

const program = new Command();
program
  .name('dbstudio')
  .description('Command-line interface for DB Studio')
  .option('--url <url>', 'API base URL (e.g. https://studio.example.com/api)')
  .option('--token <token>', 'API key');

program.addCommand(connections);
program.addCommand(query);
program.addCommand(schedules);

// Default error handling — commander throws; convert to a clean one-liner.
program.exitOverride();
try {
  await program.parseAsync(process.argv);
} catch (err) {
  const e = err as Error & { code?: string };
  if (e.code === 'commander.help' || e.code === 'commander.version' || e.code === 'commander.helpDisplayed') {
    process.exit(0);
  }
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
}

// ---------------- Shared config resolution ----------------

export function resolveConfig(opts?: {
  url?: string;
  token?: string;
}): { url: string; token: string } {
  // commander hands parsed options at the root; we re-read them so every
  // subcommand sees the same values without threading globalOpts through.
  const globalOpts = program.opts<{ url?: string; token?: string }>();
  let url = opts?.url ?? globalOpts.url ?? process.env.DBSTUDIO_URL;
  let token = opts?.token ?? globalOpts.token ?? process.env.DBSTUDIO_TOKEN;

  if ((!url || !token) && existsSync(join(homedir(), '.dbstudio', 'config.json'))) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.dbstudio', 'config.json'), 'utf8'));
      url ??= cfg.url;
      token ??= cfg.token;
    } catch {
      /* ignore parse errors — explicit flags will still work */
    }
  }

  if (!url) throw new Error('API URL required (--url, DBSTUDIO_URL, or ~/.dbstudio/config.json)');
  if (!token) throw new Error('API token required (--token, DBSTUDIO_TOKEN, or ~/.dbstudio/config.json)');
  return { url: url.replace(/\/$/, ''), token };
}

export async function apiFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const { url, token } = resolveConfig();
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': body ? 'application/json' : 'text/plain',
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
    throw new Error(msg);
  }
  return text ? JSON.parse(text) : null;
}
