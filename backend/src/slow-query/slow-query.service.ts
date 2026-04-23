import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/**
 * Replace literal values with `?` so two runs of the same query shape — even
 * with different params — collide on the same hash. Intentionally lightweight:
 *   - '...' and "..." strings (with escaped quotes) -> ?
 *   - numbers (int + decimal + negative) -> ?
 *   - IN (…) lists collapse to IN (?)
 *   - collapse whitespace, trim trailing semicolons
 *   - uppercase SQL keywords for stable hashing? No — fingerprint doesn't need it,
 *     and preserving case makes the stored shape more readable.
 *
 * This is not a parser. It's a best-effort normalizer good enough to cluster
 * real user traffic. pg_stat_statements does a proper AST-based normalization,
 * but pulling that in as a runtime dep is heavy.
 */
export function normalizeSql(sql: string): string {
  return sql
    // Strip SQL comments — /* */ and -- rest of line.
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    // Strings: collapse to ?. Matches '...' and "..." with escaped quotes.
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/"(?:[^"]|"")*"/g, '?')
    // Numbers — including scientific notation and negatives after operators.
    .replace(/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, '?')
    // IN (…) / VALUES (…) lists — collapse many placeholders to a single one.
    .replace(/\bin\s*\(\s*(?:\?\s*,\s*)+\?\s*\)/gi, 'IN (?)')
    .replace(/\bvalues\s*(?:\(\s*(?:\?\s*,\s*)*\?\s*\)\s*,\s*)+\(\s*(?:\?\s*,\s*)*\?\s*\)/gi, 'VALUES (?)')
    // Collapse whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;+$/, '');
}

function shapeHash(normalized: string): string {
  return createHash('sha1').update(normalized).digest('hex').slice(0, 24);
}

const MAX_SQL_LEN = 8_000;
const MAX_NORMALIZED_LEN = 4_000;

export interface SlowQueryGroup {
  shapeHash: string;
  normalizedSql: string;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  lastSeen: Date;
  erroredCount: number;
  exampleSql: string;
}

@Injectable()
export class SlowQueryService {
  private readonly log = new Logger(SlowQueryService.name);
  private retentionDebounce = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
  ) {}

  /** Fire-and-forget. Never throws — the caller is a hot query path and must not fail if logging does. */
  record(entry: {
    connectionId: string;
    userId?: string;
    sql: string;
    durationMs: number;
    rowCount?: number | null;
    rowsAffected?: number | null;
    errored?: boolean;
    errorMessage?: string;
  }): void {
    if (entry.durationMs < this.cfg.slowQueryThresholdMs) return;
    const normalized = normalizeSql(entry.sql).slice(0, MAX_NORMALIZED_LEN);
    if (!normalized) return;
    const hash = shapeHash(normalized);
    const example = entry.sql.slice(0, MAX_SQL_LEN);

    // Hot path — don't await. Errors logged but not surfaced.
    this.prisma.slowQueryLog
      .create({
        data: {
          connectionId: entry.connectionId,
          userId: entry.userId ?? null,
          shapeHash: hash,
          normalizedSql: normalized,
          exampleSql: example,
          durationMs: Math.round(entry.durationMs),
          rowCount: entry.rowCount ?? null,
          rowsAffected: entry.rowsAffected ?? null,
          errored: !!entry.errored,
          errorMessage: entry.errorMessage?.slice(0, 1_000),
        },
      })
      .then(() => this.maybeTrim(entry.connectionId))
      .catch((err) => this.log.warn(`slow-query log insert failed: ${(err as Error).message}`));
  }

  /** Opportunistically delete oldest rows above the retention cap. Runs at
   *  most once per minute per connection to avoid hammering the DB. */
  private async maybeTrim(connectionId: string) {
    const now = Date.now();
    if (now - this.retentionDebounce < 60_000) return;
    this.retentionDebounce = now;
    const cap = this.cfg.slowQueryRetention;
    const total = await this.prisma.slowQueryLog.count({ where: { connectionId } });
    if (total <= cap) return;
    const toDelete = total - cap;
    // Find the cutoff id, delete anything created before it.
    const boundary = await this.prisma.slowQueryLog.findFirst({
      where: { connectionId },
      orderBy: { createdAt: 'desc' },
      skip: cap - 1,
      select: { createdAt: true },
    });
    if (!boundary) return;
    await this.prisma.slowQueryLog
      .deleteMany({
        where: { connectionId, createdAt: { lt: boundary.createdAt } },
      })
      .catch((err) => this.log.warn(`retention trim failed (${toDelete} target): ${(err as Error).message}`));
  }

  async listGroups(
    connectionId: string,
    opts: { sinceMs?: number; limit?: number } = {},
  ): Promise<SlowQueryGroup[]> {
    const since = opts.sinceMs ? new Date(Date.now() - opts.sinceMs) : undefined;
    // One aggregate query per shape. Prisma doesn't support aggregate + groupBy
    // with multiple metrics + ORDER BY, so do it in two passes.
    // Groupby first — the other two queries need the list of hashes from it.
    const rows = await this.prisma.slowQueryLog.groupBy({
      by: ['shapeHash'],
      where: {
        connectionId,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _count: { _all: true },
      _sum: { durationMs: true },
      _avg: { durationMs: true },
      _max: { durationMs: true, createdAt: true },
      orderBy: { _sum: { durationMs: 'desc' } },
      take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    });
    const hashes = rows.map((r) => r.shapeHash);

    // Examples + errored-counts are independent — fire in parallel. Cuts
    // total latency roughly in half on DBs where each Prisma call has
    // meaningful round-trip cost.
    const [examples, erroredCounts] = await Promise.all([
      this.prisma.slowQueryLog.findMany({
        where: { connectionId, shapeHash: { in: hashes } },
        orderBy: { createdAt: 'desc' },
        distinct: ['shapeHash'],
        select: { shapeHash: true, exampleSql: true, normalizedSql: true },
      }),
      this.prisma.slowQueryLog.groupBy({
        by: ['shapeHash'],
        where: {
          connectionId,
          errored: true,
          ...(since ? { createdAt: { gte: since } } : {}),
        },
        _count: { _all: true },
      }),
    ]);
    const exampleByHash = new Map(examples.map((e) => [e.shapeHash, e]));
    const erroredByHash = new Map(erroredCounts.map((e) => [e.shapeHash, e._count._all]));

    return rows.map((r) => {
      const ex = exampleByHash.get(r.shapeHash);
      return {
        shapeHash: r.shapeHash,
        normalizedSql: ex?.normalizedSql ?? '(unknown)',
        count: r._count._all,
        totalDurationMs: r._sum.durationMs ?? 0,
        avgDurationMs: Math.round(r._avg.durationMs ?? 0),
        maxDurationMs: r._max.durationMs ?? 0,
        lastSeen: r._max.createdAt ?? new Date(0),
        erroredCount: erroredByHash.get(r.shapeHash) ?? 0,
        exampleSql: ex?.exampleSql ?? '',
      };
    });
  }

  async listRunsForShape(connectionId: string, shapeHash: string, limit = 50) {
    return this.prisma.slowQueryLog.findMany({
      where: { connectionId, shapeHash },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: { user: { select: { email: true, displayName: true } } },
    });
  }
}
