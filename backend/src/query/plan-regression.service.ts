import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExplainService, PlanNode } from './explain.service';
import { normalizeSql } from '../slow-query/slow-query.service';

/**
 * Plan regression detection.
 *
 * The "query suddenly got slow but the SQL didn't change" problem: a planner
 * silently switches strategy (Index Scan -> Seq Scan, Hash Join -> Nested Loop)
 * after a stats change, data growth, or a dropped index. The SQL text is
 * identical, so shape-based slow-query grouping shows a latency jump but not
 * *why*.
 *
 * This service captures the *structure* of an EXPLAIN plan for a query shape,
 * fingerprints it, and compares against the previous snapshot of the same
 * shape. A structural change — especially a scan downgrade or a large cost
 * jump — is flagged as a regression with a human-readable note.
 *
 * Capture is read-only (EXPLAIN without ANALYZE by default) and fail-open: if
 * anything goes wrong we log and move on; this never blocks a query.
 */

/** Scan strategies ranked best -> worst. A drop in rank is a regression signal. */
const SCAN_RANK: Record<string, number> = {
  'Index Only Scan': 0,
  'Index Scan': 1,
  'Bitmap Heap Scan': 2,
  'Bitmap Index Scan': 2,
  'Tile Scan': 3,
  'Seq Scan': 4,
  // MySQL access types, mapped onto the same ladder.
  const: 0,
  eq_ref: 0,
  ref: 1,
  range: 2,
  index: 3,
  ALL: 4,
};

/** Join strategies — a Nested Loop over many rows is the classic foot-gun. */
const JOIN_TYPES = new Set(['Nested Loop', 'Hash Join', 'Merge Join']);

/** Cost jump (ratio vs previous snapshot) that counts as a regression on its own. */
const COST_REGRESSION_RATIO = 4;

export interface PlanScan {
  nodeType: string;
  relation: string | null;
}

export interface PlanRegressionSnapshot {
  id: string;
  shapeHash: string;
  normalizedSql: string;
  exampleSql: string;
  planHash: string;
  planSummary: string;
  totalCost: number | null;
  totalTimeMs: number | null;
  scans: PlanScan[];
  nodes: PlanNode[];
  regressed: boolean;
  regressionNote: string | null;
  createdAt: Date;
}

@Injectable()
export class PlanRegressionService {
  private readonly log = new Logger(PlanRegressionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly explain: ExplainService,
  ) {}

  /** Extract the ordered scan operations from a flattened plan. */
  private extractScans(nodes: PlanNode[]): PlanScan[] {
    return nodes
      .filter((n) => /scan/i.test(n.nodeType) || JOIN_TYPES.has(n.nodeType))
      .map((n) => ({ nodeType: n.nodeType, relation: n.relation ?? null }));
  }

  /** Stable structural fingerprint: the sequence of (nodeType, relation) pairs.
   *  Costs and row counts are deliberately excluded — they drift constantly;
   *  it's the *strategy* changing that we care about. */
  private fingerprint(scans: PlanScan[]): string {
    const sig = scans.map((s) => `${s.nodeType}@${s.relation ?? '*'}`).join('|');
    return createHash('sha1').update(sig).digest('hex').slice(0, 24);
  }

  private summarize(scans: PlanScan[]): string {
    if (scans.length === 0) return '(no scans)';
    return scans
      .map((s) => (s.relation ? `${s.nodeType} on ${s.relation}` : s.nodeType))
      .join('; ')
      .slice(0, 500);
  }

  /**
   * Compare a new plan against the previous snapshot for the same shape.
   * Returns a regression note if the structure degraded, else null.
   */
  private detectRegression(
    prev: { scans: PlanScan[]; totalCost: number | null } | null,
    nextScans: PlanScan[],
    nextCost: number | null,
  ): string | null {
    if (!prev) return null;

    const reasons: string[] = [];

    // 1) Scan strategy downgrade on a relation present in both plans.
    const prevByRel = new Map<string, string>();
    for (const s of prev.scans) {
      if (s.relation) prevByRel.set(s.relation, s.nodeType);
    }
    for (const s of nextScans) {
      if (!s.relation) continue;
      const before = prevByRel.get(s.relation);
      if (!before || before === s.nodeType) continue;
      const beforeRank = SCAN_RANK[before];
      const afterRank = SCAN_RANK[s.nodeType];
      if (beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank) {
        reasons.push(`${s.relation}: ${before} → ${s.nodeType}`);
      }
    }

    // 2) Join strategy change to Nested Loop (often the regression culprit).
    const prevJoins = prev.scans.filter((s) => JOIN_TYPES.has(s.nodeType)).map((s) => s.nodeType);
    const nextJoins = nextScans.filter((s) => JOIN_TYPES.has(s.nodeType)).map((s) => s.nodeType);
    if (
      nextJoins.includes('Nested Loop') &&
      !prevJoins.includes('Nested Loop') &&
      prevJoins.length > 0
    ) {
      reasons.push(`join switched to Nested Loop (was ${prevJoins.join(', ')})`);
    }

    // 3) Large planner-cost jump even if structure looks similar.
    if (
      prev.totalCost !== null &&
      nextCost !== null &&
      prev.totalCost > 0 &&
      nextCost / prev.totalCost >= COST_REGRESSION_RATIO
    ) {
      reasons.push(
        `planner cost rose ${(nextCost / prev.totalCost).toFixed(1)}× (${prev.totalCost.toFixed(0)} → ${nextCost.toFixed(0)})`,
      );
    }

    return reasons.length ? reasons.join('; ') : null;
  }

  /**
   * Capture a plan snapshot for the given SQL. Fail-open: returns null on any
   * error. Call this fire-and-forget from the query hot path, or directly from
   * the "capture now" endpoint where the caller wants the result.
   */
  async capture(
    connectionId: string,
    sql: string,
    userId?: string,
  ): Promise<PlanRegressionSnapshot | null> {
    try {
      const normalized = normalizeSql(sql).slice(0, 4_000);
      if (!normalized) return null;
      const shapeHash = createHash('sha1').update(normalized).digest('hex').slice(0, 24);

      // EXPLAIN (plan only — never ANALYZE here, capture must not run the query).
      const result = await this.explain.explain(userId ?? '', connectionId, sql, 'plan');
      const nodes = result.nodes ?? [];
      const scans = this.extractScans(nodes);
      const planHash = this.fingerprint(scans);
      const planSummary = this.summarize(scans);
      const totalCost = result.totalCost ?? null;

      // Compare against the most recent snapshot for this shape.
      const prevRow = await this.prisma.planSnapshot.findFirst({
        where: { connectionId, shapeHash },
        orderBy: { createdAt: 'desc' },
        select: { planHash: true, scans: true, totalCost: true },
      });
      const prev = prevRow
        ? { scans: (prevRow.scans as unknown as PlanScan[]) ?? [], totalCost: prevRow.totalCost }
        : null;

      // No structural change AND no big cost move → skip the write. Keeps the
      // table from growing on every identical capture; we only persist when the
      // plan is new or has actually moved.
      const structurallySame = prevRow?.planHash === planHash;
      const regressionNote = this.detectRegression(prev, scans, totalCost);
      if (structurallySame && !regressionNote) {
        return null;
      }

      // Cap stored node JSON so a pathological plan can't bloat a row.
      const cappedNodes = nodes.slice(0, 200);

      const created = await this.prisma.planSnapshot.create({
        data: {
          connectionId,
          userId: userId || null,
          shapeHash,
          normalizedSql: normalized,
          exampleSql: sql.slice(0, 8_000),
          planHash,
          planSummary,
          totalCost,
          totalTimeMs: result.executionTimeMs ?? null,
          scans: scans as unknown as object,
          nodes: cappedNodes as unknown as object,
          regressed: !!regressionNote,
          regressionNote: regressionNote ?? null,
        },
      });

      return this.toSnapshot(created);
    } catch (err) {
      this.log.debug(`plan capture failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** History of plan snapshots for one shape, newest first. */
  async listForShape(
    connectionId: string,
    shapeHash: string,
    limit = 50,
  ): Promise<PlanRegressionSnapshot[]> {
    const rows = await this.prisma.planSnapshot.findMany({
      where: { connectionId, shapeHash },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((r) => this.toSnapshot(r));
  }

  /** Recent regressions across the whole connection — the "what got slow" feed. */
  async listRegressions(
    connectionId: string,
    opts: { sinceMs?: number; limit?: number } = {},
  ): Promise<PlanRegressionSnapshot[]> {
    const since = opts.sinceMs ? new Date(Date.now() - opts.sinceMs) : undefined;
    const rows = await this.prisma.planSnapshot.findMany({
      where: {
        connectionId,
        regressed: true,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    });
    return rows.map((r) => this.toSnapshot(r));
  }

  /**
   * Structured diff between two snapshots (by id), for the UI. Either id may
   * belong to the same shape; we don't enforce it, but the diff is only
   * meaningful for the same shape.
   */
  async diff(connectionId: string, fromId: string, toId: string) {
    const [from, to] = await Promise.all([
      this.prisma.planSnapshot.findFirst({ where: { id: fromId, connectionId } }),
      this.prisma.planSnapshot.findFirst({ where: { id: toId, connectionId } }),
    ]);
    if (!from || !to) throw new BadRequestException('Snapshot not found');

    const fromScans = (from.scans as unknown as PlanScan[]) ?? [];
    const toScans = (to.scans as unknown as PlanScan[]) ?? [];
    const note = this.detectRegression(
      { scans: fromScans, totalCost: from.totalCost },
      toScans,
      to.totalCost,
    );

    return {
      from: this.toSnapshot(from),
      to: this.toSnapshot(to),
      changed: from.planHash !== to.planHash,
      costDeltaRatio:
        from.totalCost && to.totalCost && from.totalCost > 0
          ? to.totalCost / from.totalCost
          : null,
      regressionNote: note,
    };
  }

  private toSnapshot(r: {
    id: string;
    shapeHash: string;
    normalizedSql: string;
    exampleSql: string;
    planHash: string;
    planSummary: string;
    totalCost: number | null;
    totalTimeMs: number | null;
    scans: unknown;
    nodes: unknown;
    regressed: boolean;
    regressionNote: string | null;
    createdAt: Date;
  }): PlanRegressionSnapshot {
    return {
      id: r.id,
      shapeHash: r.shapeHash,
      normalizedSql: r.normalizedSql,
      exampleSql: r.exampleSql,
      planHash: r.planHash,
      planSummary: r.planSummary,
      totalCost: r.totalCost,
      totalTimeMs: r.totalTimeMs,
      scans: (r.scans as PlanScan[]) ?? [],
      nodes: (r.nodes as PlanNode[]) ?? [],
      regressed: r.regressed,
      regressionNote: r.regressionNote,
      createdAt: r.createdAt,
    };
  }
}
