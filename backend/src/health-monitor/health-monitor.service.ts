import { Injectable } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { ConnectionsService } from '../connections/connections.service';

export interface HealthSnapshot {
  at: string;
  dialect: Dialect;
  metrics: HealthMetric[];
  errors: string[];
  longRunning: LongRunningQuery[];
}

export interface HealthMetric {
  key: string;
  label: string;
  value: number | string | null;
  unit?: string;
  severity?: 'ok' | 'warn' | 'crit';
  hint?: string;
}

export interface LongRunningQuery {
  pid: number | string | null;
  user: string | null;
  database: string | null;
  durationMs: number | null;
  state: string | null;
  query: string | null;
  waitEvent?: string | null;
}

/**
 * Per-connection database health. Queries the target DB for operational
 * metrics: connection count, long-running statements, cache hit, replication
 * lag, locks. Every probe is read-only and times out fast so a sick DB can't
 * hang the dashboard.
 *
 * Dialect coverage: Postgres has the richest instrumentation; MySQL gets
 * a slimmer set; SQLite + MSSQL get the bare minimum.
 */
@Injectable()
export class HealthMonitorService {
  constructor(private readonly connections: ConnectionsService) {}

  async snapshot(connectionId: string, userId: string): Promise<HealthSnapshot> {
    void userId;
    const conn = await this.connections.get(connectionId);
    const drv = await this.connections.buildDriverForRole(connectionId, Role.VIEWER);
    try {
      const errors: string[] = [];
      const metrics: HealthMetric[] = [];
      let longRunning: LongRunningQuery[] = [];

      if (conn.dialect === Dialect.POSTGRES) {
        const m = await pgMetrics(drv, errors);
        metrics.push(...m);
        longRunning = await pgLongRunning(drv, errors);
      } else if (conn.dialect === Dialect.MYSQL) {
        const m = await mysqlMetrics(drv, errors);
        metrics.push(...m);
        longRunning = await mysqlLongRunning(drv, errors);
      } else if (conn.dialect === Dialect.SQLITE) {
        metrics.push(...sqliteStatic());
      } else if (conn.dialect === Dialect.MSSQL) {
        const m = await mssqlMetrics(drv, errors);
        metrics.push(...m);
        longRunning = await mssqlLongRunning(drv, errors);
      }
      return {
        at: new Date().toISOString(),
        dialect: conn.dialect,
        metrics,
        errors,
        longRunning,
      };
    } finally {
      await drv.close().catch(() => {});
    }
  }
}

// Thin `any`-typed helper because each driver exposes `runRawQuery` with its
// own result shape; we only need rows[].
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSafe(drv: any, sql: string, errors: string[]): Promise<Record<string, unknown>[]> {
  try {
    const res = await drv.runRawQuery(sql);
    return (res.rows ?? []) as Record<string, unknown>[];
  } catch (err) {
    errors.push(`${sql.slice(0, 60).replace(/\s+/g, ' ')}: ${(err as Error).message.slice(0, 200)}`);
    return [];
  }
}

// ---- Postgres ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pgMetrics(drv: any, errors: string[]): Promise<HealthMetric[]> {
  const out: HealthMetric[] = [];

  // Active connections + max_connections.
  const conn = await runSafe(
    drv,
    `SELECT
       (SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle') AS active,
       (SELECT count(*) FROM pg_stat_activity) AS total,
       current_setting('max_connections')::int AS max_conn`,
    errors,
  );
  if (conn[0]) {
    const active = Number(conn[0].active ?? 0);
    const total = Number(conn[0].total ?? 0);
    const max = Number(conn[0].max_conn ?? 0);
    const pct = max > 0 ? (total / max) * 100 : 0;
    out.push({
      key: 'connections_active',
      label: 'Active connections',
      value: active,
      hint: `${total} total, ${max} max`,
      severity: pct > 85 ? 'crit' : pct > 65 ? 'warn' : 'ok',
    });
    out.push({
      key: 'connections_capacity',
      label: 'Connection capacity',
      value: Math.round(pct),
      unit: '%',
      severity: pct > 85 ? 'crit' : pct > 65 ? 'warn' : 'ok',
    });
  }

  // Cache hit ratio (block reads vs disk reads for the database).
  const cache = await runSafe(
    drv,
    `SELECT
       sum(blks_hit) AS hit,
       sum(blks_read) AS read
     FROM pg_stat_database
     WHERE datname = current_database()`,
    errors,
  );
  if (cache[0]) {
    const hit = Number(cache[0].hit ?? 0);
    const read = Number(cache[0].read ?? 0);
    const total = hit + read;
    if (total > 0) {
      const ratio = (hit / total) * 100;
      out.push({
        key: 'cache_hit',
        label: 'Cache hit ratio',
        value: Number(ratio.toFixed(2)),
        unit: '%',
        severity: ratio < 95 ? 'warn' : 'ok',
        hint: 'Above 99% is healthy for OLTP; OLAP workloads run lower.',
      });
    }
  }

  // Replication lag — byte-distance between primary LSN and each replica's
  // write LSN. Only meaningful on a primary with connected replicas.
  const rep = await runSafe(
    drv,
    `SELECT
       application_name,
       COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0) AS bytes
     FROM pg_stat_replication`,
    errors,
  );
  if (rep.length > 0) {
    const maxBytes = Math.max(...rep.map((r) => Number(r.bytes ?? 0)));
    out.push({
      key: 'replication_lag',
      label: 'Replication lag (max)',
      value: Math.round(maxBytes / 1024),
      unit: 'KB',
      severity: maxBytes > 64 * 1024 * 1024 ? 'warn' : 'ok',
      hint: `${rep.length} replica(s) connected`,
    });
  }

  // Locks — blocked sessions right now.
  const locks = await runSafe(
    drv,
    `SELECT count(*)::int AS n FROM pg_locks WHERE granted = false`,
    errors,
  );
  if (locks[0]) {
    const n = Number(locks[0].n ?? 0);
    out.push({
      key: 'locks_waiting',
      label: 'Waiting locks',
      value: n,
      severity: n > 10 ? 'crit' : n > 0 ? 'warn' : 'ok',
    });
  }

  // Database size.
  const size = await runSafe(
    drv,
    `SELECT pg_database_size(current_database()) AS bytes`,
    errors,
  );
  if (size[0]) {
    const bytes = Number(size[0].bytes ?? 0);
    out.push({
      key: 'database_size',
      label: 'Database size',
      value: formatBytes(bytes),
    });
  }

  // Transactions / rollback ratio.
  const tx = await runSafe(
    drv,
    `SELECT xact_commit AS committed, xact_rollback AS rolled_back
     FROM pg_stat_database
     WHERE datname = current_database()`,
    errors,
  );
  if (tx[0]) {
    const committed = Number(tx[0].committed ?? 0);
    const rolledBack = Number(tx[0].rolled_back ?? 0);
    const total = committed + rolledBack;
    if (total > 0) {
      const ratio = (rolledBack / total) * 100;
      out.push({
        key: 'rollback_ratio',
        label: 'Rollback ratio (lifetime)',
        value: Number(ratio.toFixed(2)),
        unit: '%',
        severity: ratio > 5 ? 'warn' : 'ok',
      });
    }
  }

  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pgLongRunning(drv: any, errors: string[]): Promise<LongRunningQuery[]> {
  const rows = await runSafe(
    drv,
    `SELECT pid, usename, datname,
            EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms,
            state, query, wait_event
     FROM pg_stat_activity
     WHERE state <> 'idle'
       AND query NOT ILIKE '%pg_stat_activity%'
       AND query_start IS NOT NULL
       AND now() - query_start > interval '10 seconds'
     ORDER BY query_start ASC
     LIMIT 20`,
    errors,
  );
  return rows.map((r) => ({
    pid: r.pid as number | null,
    user: (r.usename as string | null) ?? null,
    database: (r.datname as string | null) ?? null,
    durationMs: r.duration_ms != null ? Math.round(Number(r.duration_ms)) : null,
    state: (r.state as string | null) ?? null,
    query: truncate(r.query as string | null, 2000),
    waitEvent: (r.wait_event as string | null) ?? null,
  }));
}

// ---- MySQL ---------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mysqlMetrics(drv: any, errors: string[]): Promise<HealthMetric[]> {
  const out: HealthMetric[] = [];

  const threads = await runSafe(
    drv,
    `SHOW STATUS WHERE Variable_name IN ('Threads_connected', 'Threads_running', 'Max_used_connections')`,
    errors,
  );
  const max = await runSafe(drv, `SHOW VARIABLES WHERE Variable_name = 'max_connections'`, errors);
  if (threads.length > 0) {
    const byName = new Map(
      threads.map((r) => [String(r.Variable_name), Number(r.Value)]),
    );
    const connected = byName.get('Threads_connected') ?? 0;
    const running = byName.get('Threads_running') ?? 0;
    const maxConn = Number(max[0]?.Value ?? 0);
    const pct = maxConn > 0 ? (connected / maxConn) * 100 : 0;
    out.push({
      key: 'connections_active',
      label: 'Running threads',
      value: running,
      hint: `${connected} connected, ${maxConn} max`,
    });
    out.push({
      key: 'connections_capacity',
      label: 'Connection capacity',
      value: Math.round(pct),
      unit: '%',
      severity: pct > 85 ? 'crit' : pct > 65 ? 'warn' : 'ok',
    });
  }

  // InnoDB buffer-pool hit ratio — a rough cache-hit proxy.
  const buf = await runSafe(
    drv,
    `SHOW STATUS WHERE Variable_name IN ('Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests')`,
    errors,
  );
  if (buf.length === 2) {
    const byName = new Map(buf.map((r) => [String(r.Variable_name), Number(r.Value)]));
    const disk = byName.get('Innodb_buffer_pool_reads') ?? 0;
    const req = byName.get('Innodb_buffer_pool_read_requests') ?? 0;
    if (req > 0) {
      const hit = (1 - disk / req) * 100;
      out.push({
        key: 'cache_hit',
        label: 'Buffer pool hit ratio',
        value: Number(hit.toFixed(2)),
        unit: '%',
        severity: hit < 95 ? 'warn' : 'ok',
      });
    }
  }

  // Replication lag in seconds. Only meaningful on a replica.
  const rep = await runSafe(drv, `SHOW SLAVE STATUS`, errors);
  if (rep.length > 0) {
    const lag = Number((rep[0] as Record<string, unknown>).Seconds_Behind_Master ?? 0);
    out.push({
      key: 'replication_lag',
      label: 'Seconds behind master',
      value: lag,
      unit: 's',
      severity: lag > 60 ? 'crit' : lag > 10 ? 'warn' : 'ok',
    });
  }

  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mysqlLongRunning(drv: any, errors: string[]): Promise<LongRunningQuery[]> {
  const rows = await runSafe(
    drv,
    `SELECT ID AS pid, USER AS user, DB AS db, TIME * 1000 AS duration_ms, STATE AS state, INFO AS query
     FROM information_schema.PROCESSLIST
     WHERE COMMAND <> 'Sleep'
       AND TIME > 10
     ORDER BY TIME DESC
     LIMIT 20`,
    errors,
  );
  return rows.map((r) => ({
    pid: r.pid as number | null,
    user: (r.user as string | null) ?? null,
    database: (r.db as string | null) ?? null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    state: (r.state as string | null) ?? null,
    query: truncate(r.query as string | null, 2000),
  }));
}

// ---- SQLite --------------------------------------------------------------

function sqliteStatic(): HealthMetric[] {
  // SQLite is file-based; no server metrics. Surface a reminder so the UI
  // has something to display instead of a blank panel.
  return [
    {
      key: 'sqlite_note',
      label: 'SQLite health',
      value: 'n/a',
      hint: "File-based engine — OS-level disk monitoring applies. 'PRAGMA integrity_check' runs manually.",
    },
  ];
}

// ---- MSSQL ---------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mssqlMetrics(drv: any, errors: string[]): Promise<HealthMetric[]> {
  const out: HealthMetric[] = [];
  const sess = await runSafe(
    drv,
    `SELECT COUNT(*) AS active
     FROM sys.dm_exec_sessions
     WHERE is_user_process = 1 AND status <> 'sleeping'`,
    errors,
  );
  if (sess[0]) {
    out.push({
      key: 'connections_active',
      label: 'Active sessions',
      value: Number(sess[0].active ?? 0),
    });
  }

  const cache = await runSafe(
    drv,
    `SELECT
       (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name LIKE 'Buffer cache hit ratio%' AND object_name LIKE '%Buffer Manager%') AS hit,
       (SELECT cntr_value FROM sys.dm_os_performance_counters
          WHERE counter_name LIKE 'Buffer cache hit ratio base%' AND object_name LIKE '%Buffer Manager%') AS base`,
    errors,
  );
  if (cache[0]) {
    const hit = Number(cache[0].hit ?? 0);
    const base = Number(cache[0].base ?? 0);
    if (base > 0) {
      const ratio = (hit / base) * 100;
      out.push({
        key: 'cache_hit',
        label: 'Buffer cache hit ratio',
        value: Number(ratio.toFixed(2)),
        unit: '%',
        severity: ratio < 95 ? 'warn' : 'ok',
      });
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mssqlLongRunning(drv: any, errors: string[]): Promise<LongRunningQuery[]> {
  const rows = await runSafe(
    drv,
    `SELECT TOP 20
       r.session_id AS pid,
       s.login_name AS [user],
       DB_NAME(r.database_id) AS [database],
       r.total_elapsed_time AS duration_ms,
       r.status AS state,
       SUBSTRING(st.text, 1, 2000) AS query,
       r.wait_type AS wait_event
     FROM sys.dm_exec_requests r
     JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
     CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st
     WHERE r.total_elapsed_time > 10000
     ORDER BY r.total_elapsed_time DESC`,
    errors,
  );
  return rows.map((r) => ({
    pid: (r.pid as number | null) ?? null,
    user: (r.user as string | null) ?? null,
    database: (r.database as string | null) ?? null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    state: (r.state as string | null) ?? null,
    query: truncate(r.query as string | null, 2000),
    waitEvent: (r.wait_event as string | null) ?? null,
  }));
}

// ---- Helpers -------------------------------------------------------------

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b < 1024 * 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(b / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}
