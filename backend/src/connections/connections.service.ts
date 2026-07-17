import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { DriverFactory } from '../drivers/driver.factory';
import { SshTunnelService, OpenTunnel } from '../drivers/ssh-tunnel.service';
import { AgentTunnelService } from '../agent-tunnel/agent-tunnel.service';
import { AuditService } from '../audit/audit.service';
import { ConnectionCredentials, IDatabaseDriver } from '../drivers/driver.interface';
import { CreateConnectionDto, UpdateConnectionDto } from './connections.dto';
import { QuotaService } from '../common/quota.service';
import { SsrfGuardService } from '../common/ssrf-guard.service';
import { buildRows } from './sample-data.util';

const PURPOSE = (id: string) => `conn:${id}`;

// How long a cached driver can sit idle before we close it.
const IDLE_EVICT_MS = 10 * 60_000; // 10 minutes
// Sweep cadence.
const SWEEP_INTERVAL_MS = 60_000;

interface CachedDriver {
  driver: IDatabaseDriver;
  lastUsed: number;
  /** Track in-flight operations so the sweeper never closes an active driver. */
  inUse: number;
  /** SSH tunnel held open for this driver's lifetime, if any. */
  tunnel?: OpenTunnel;
}

/** Wraps a cached driver so callers can still call .close() without evicting it. */
function makeLeasedDriver(
  raw: IDatabaseDriver,
  onRelease: () => void,
): IDatabaseDriver {
  const proxy: IDatabaseDriver = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'close') {
        // Soft release — the real pool lives on until idle-evicted.
        return async () => onRelease();
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return proxy;
}

@Injectable()
export class ConnectionsService implements OnModuleDestroy {
  private readonly log = new Logger(ConnectionsService.name);
  /** Cache keyed by `${connectionId}:${readOnly}` so role-based read-only gets its own pool. */
  private readonly driverCache = new Map<string, CachedDriver>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly factory: DriverFactory,
    private readonly ssh: SshTunnelService,
    private readonly agentTunnel: AgentTunnelService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
    private readonly ssrf: SsrfGuardService,
  ) {
    this.sweeper = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    // Don't keep the process alive just for this.
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    void this.evictAll();
  }

  private cacheKey(id: string, readOnly: boolean): string {
    return `${id}:${readOnly ? 'ro' : 'rw'}`;
  }

  private async evict(key: string) {
    const entry = this.driverCache.get(key);
    if (!entry) return;
    this.driverCache.delete(key);
    try {
      await entry.driver.close();
    } catch (err) {
      this.log.warn(`Driver close failed for ${key}: ${(err as Error).message}`);
    }
    if (entry.tunnel) {
      try {
        await entry.tunnel.close();
      } catch (err) {
        this.log.warn(`SSH tunnel close failed for ${key}: ${(err as Error).message}`);
      }
    }
  }

  private async evictAll() {
    const keys = [...this.driverCache.keys()];
    for (const k of keys) await this.evict(k);
  }

  /** Evict any cached drivers for a connection (both ro + rw). Call on update/delete. */
  private async invalidate(connectionId: string) {
    await this.evict(this.cacheKey(connectionId, true));
    await this.evict(this.cacheKey(connectionId, false));
  }

  private sweepIdle() {
    const cutoff = Date.now() - IDLE_EVICT_MS;
    for (const [key, entry] of this.driverCache) {
      if (entry.inUse === 0 && entry.lastUsed < cutoff) {
        void this.evict(key);
      }
    }
  }

  private sanitize(c: any) {
    return {
      id: c.id, name: c.name, dialect: c.dialect,
      readOnly: c.readOnly, statementTimeoutMs: c.statementTimeoutMs,
      slowQueryAlertMs: c.slowQueryAlertMs ?? null,
      slowQueryAlertEmail: c.slowQueryAlertEmail ?? null,
      ownerId: c.ownerId, workspaceId: c.workspaceId ?? null,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }

  async create(userId: string, dto: CreateConnectionDto, meta: { ip?: string; userAgent?: string }) {
    // Pick a workspace: use the provided one if the user has rights, else default
    // to the user's personal workspace.
    let workspaceId: string | null = null;
    if (dto.workspaceId) {
      const m = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId } },
      });
      if (!m) throw new Error('You are not a member of that workspace');
      workspaceId = dto.workspaceId;
    } else {
      const personal = await this.prisma.workspace.findFirst({
        where: { ownerId: userId, isPersonal: true },
      });
      workspaceId = personal?.id ?? null;
    }

    // Enforce per-workspace connection cap before creating.
    await this.quota.assertCanCreateConnection(workspaceId);

    // If routing via a local agent, verify the agent exists and belongs to the user.
    const viaAgent = dto.viaAgent ?? false;
    const agentId = viaAgent ? await this.assertOwnedAgent(dto.agentId, userId) : null;

    // SECURITY: when WE dial the database, the host must be a public address —
    // otherwise any user could point a connection at our own internal services
    // (redis, sibling containers, cloud metadata) and query them. Agent-routed
    // connections are exempt: those are dialed from the user's own machine.
    await this.assertDialableTarget(dto.credentials, viaAgent, userId);

    const credCt = await this.crypto.encryptJson(dto.credentials, 'conn:new');
    const created = await this.prisma.connection.create({
      data: {
        name: dto.name, dialect: dto.dialect, credentialsCt: credCt,
        readOnly: dto.readOnly ?? false,
        statementTimeoutMs: dto.statementTimeoutMs ?? 30_000,
        ownerId: userId,
        workspaceId,
        viaAgent,
        agentId,
      },
    });
    // Re-encrypt with purpose bound to id.
    const rebound = await this.crypto.encryptJson(dto.credentials, PURPOSE(created.id));
    const final = await this.prisma.connection.update({
      where: { id: created.id }, data: { credentialsCt: rebound },
    });
    await this.audit.log({ userId, connectionId: final.id, action: 'CONNECTION_CREATED', ...meta });
    return this.sanitize(final);
  }

  async list(userId: string, workspaceId?: string) {
    const rows = await this.prisma.connection.findMany({
      where: {
        AND: [
          workspaceId ? { workspaceId } : {},
          {
            OR: [
              { ownerId: userId },
              { members: { some: { userId } } },
              // User is a member of the connection's workspace.
              { workspace: { members: { some: { userId } } } },
            ],
          },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.sanitize(r));
  }

  async get(id: string) {
    const c = await this.prisma.connection.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    return c;
  }

  /** Resolve+authorize an agentId for a connection: it must exist and be owned
   *  by the requesting user. Returns the validated id. */
  /**
   * SECURITY: refuse to let the SERVER dial an internal address. Applied to the
   * database host and, when configured, the SSH bastion. Skipped for
   * agent-routed connections — the agent dials from inside the user's own
   * network, where private addresses are exactly the point.
   */
  private async assertDialableTarget(
    // Structural on purpose: this is called with both the inbound DTO (whose
    // `ssh` may be null to mean "remove the tunnel") and stored credentials.
    creds: { host?: string; ssh?: { host?: string } | null } | undefined,
    viaAgent: boolean,
    userId?: string,
  ): Promise<void> {
    if (!creds) return;
    // Instance admins are the operators of this deployment — they already have
    // server access, and on a self-hosted box pointing at an internal database
    // is the normal case. Everyone else (i.e. anyone who can sign up) is held
    // to public destinations only.
    if (userId && (await this.isInstanceAdmin(userId))) return;
    // An SSH bastion is always dialed by us, even when the DB host itself is
    // only reachable from the far side of the tunnel.
    if (creds.ssh?.host) {
      await this.ssrf.assertPublicHost(String(creds.ssh.host), 'SSH host');
    }
    // With an agent (or an SSH tunnel) the DB host is resolved on the far side,
    // not by us, so it may legitimately be private.
    if (viaAgent || creds.ssh) return;
    if (creds.host) {
      await this.ssrf.assertPublicHost(String(creds.host), 'Database host');
    }
  }

  private async isInstanceAdmin(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true },
    });
    return !!u?.isAdmin;
  }

  private async assertOwnedAgent(agentId: string | null | undefined, userId: string): Promise<string> {
    if (!agentId) {
      throw new BadRequestException('Select a local agent to route this connection through.');
    }
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.ownerId !== userId) {
      throw new BadRequestException('Unknown or inaccessible local agent.');
    }
    return agentId;
  }

  async getSanitized(id: string) {
    return this.sanitize(await this.get(id));
  }

  async update(id: string, dto: UpdateConnectionDto, userId: string, meta: { ip?: string; userAgent?: string }) {
    const existing = await this.get(id);
    const data: any = {
      name: dto.name ?? existing.name,
      readOnly: dto.readOnly ?? existing.readOnly,
      statementTimeoutMs: dto.statementTimeoutMs ?? existing.statementTimeoutMs,
      requireReview: dto.requireReview ?? existing.requireReview,
      // Slow-query alert config: undefined = keep, null = clear.
      ...(dto.slowQueryAlertMs !== undefined && { slowQueryAlertMs: dto.slowQueryAlertMs }),
      ...(dto.slowQueryAlertEmail !== undefined && { slowQueryAlertEmail: dto.slowQueryAlertEmail }),
    };
    if (dto.workspaceId !== undefined) {
      // Verify the caller is a member of the destination workspace.
      const m = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId } },
      });
      if (!m) throw new Error('You are not a member of the destination workspace');
      data.workspaceId = dto.workspaceId;
    }
    // Local-agent routing: undefined = keep as-is; false = disable + unlink;
    // true = enable with a validated, user-owned agent.
    if (dto.viaAgent !== undefined) {
      if (dto.viaAgent) {
        data.agentId = await this.assertOwnedAgent(dto.agentId ?? existing.agentId, userId);
        data.viaAgent = true;
      } else {
        data.viaAgent = false;
        data.agentId = null;
      }
    } else if (dto.agentId !== undefined && existing.viaAgent) {
      // Switching which agent an already-agent-routed connection uses.
      data.agentId = await this.assertOwnedAgent(dto.agentId, userId);
    }
    // SECURITY: re-validate the effective dial target. Two things can repoint a
    // connection at our internals: new credentials, or switching agent routing
    // OFF — which makes US dial a host that was previously reached from the
    // user's own network. Both are covered here.
    const effectiveViaAgent = (data.viaAgent as boolean | undefined) ?? existing.viaAgent;
    if (dto.credentials) {
      const current = await this.crypto.decryptJson<ConnectionCredentials>(existing.credentialsCt, PURPOSE(id));
      // Start from current, apply provided fields, then strip the tunnel if client sent ssh:null.
      const merged = { ...current, ...(dto.credentials as ConnectionCredentials) };
      if ((dto.credentials as { ssh?: unknown }).ssh === null) {
        delete merged.ssh;
      }
      await this.assertDialableTarget(merged, effectiveViaAgent, userId);
      data.credentialsCt = await this.crypto.encryptJson(merged, PURPOSE(id));
    } else if (data.viaAgent === false && existing.viaAgent) {
      const current = await this.crypto.decryptJson<ConnectionCredentials>(existing.credentialsCt, PURPOSE(id));
      await this.assertDialableTarget(current, false, userId);
    }
    const updated = await this.prisma.connection.update({ where: { id }, data });
    // Credentials, readOnly or timeout might have changed — drop cached pools.
    await this.invalidate(id);
    await this.audit.log({ userId, connectionId: id, action: 'CONNECTION_UPDATED', ...meta });
    return this.sanitize(updated);
  }

  async remove(id: string, userId: string, meta: { ip?: string; userAgent?: string }) {
    // Capture the name before we delete so the audit record is human-readable.
    const row = await this.prisma.connection.findUnique({
      where: { id },
      select: { name: true },
    });
    await this.invalidate(id);
    // Audit FIRST — once the Connection row is gone, the FK forbids writing a
    // record that references its id. We log with connectionId=null + keep the
    // original id in metadata so the trail survives the deletion.
    await this.audit.log({
      userId,
      connectionId: null,
      action: 'CONNECTION_DELETED',
      metadata: { connectionId: id, name: row?.name ?? null },
      ...meta,
    });
    await this.prisma.connection.delete({ where: { id } });
  }

  /** Set the replica credentials list. Pass `[]` or null to clear. */
  async setReplicas(
    id: string,
    userId: string,
    replicas: ConnectionCredentials[] | null,
  ) {
    await this.get(id); // verify exists
    const ct = replicas && replicas.length > 0
      ? await this.crypto.encryptJson(replicas, PURPOSE(id) + ':replicas')
      : null;
    await this.prisma.connection.update({ where: { id }, data: { replicasCt: ct } });
    // Drop cached driver entries for this connection — readOnly pools may
    // now resolve to different hosts. Cheapest: clear matches by id prefix.
    for (const key of this.driverCache.keys()) {
      if (key.startsWith(id + ':')) {
        const entry = this.driverCache.get(key);
        if (entry && entry.inUse === 0) {
          this.driverCache.delete(key);
          void entry.driver.close?.().catch(() => {});
          void entry.tunnel?.close?.().catch(() => {});
        }
      }
    }
    void userId;
    return { ok: true as const, count: replicas?.length ?? 0 };
  }

  /** Return summary info about configured replicas (host/port/label only —
   *  never the password). */
  async listReplicas(id: string): Promise<{ label?: string; host?: string; port?: number }[]> {
    const c = await this.get(id);
    if (!c.replicasCt) return [];
    try {
      const raw = await this.crypto.decryptJson<ConnectionCredentials[]>(
        c.replicasCt,
        PURPOSE(id) + ':replicas',
      );
      return raw.map((r) => ({
        host: r.host,
        port: r.port,
        // `label` isn't in ConnectionCredentials; if users store one in
        // `extra.label` we surface it.
        label: (r.extra as Record<string, unknown> | undefined)?.label as string | undefined,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Open a tunnel (if configured) and rewrite host/port to the local forwarded
   * endpoint so the DB driver connects through it. Two mutually-exclusive kinds:
   *
   *  - Local agent (`agent.viaAgent`): the DB is only reachable from the user's
   *    own network. A paired agent.exe on that network dials the DB and pipes
   *    bytes back over its WebSocket. host/port are the DB address as seen FROM
   *    the agent's machine. Takes precedence over ssh if both are somehow set.
   *  - SSH tunnel (`creds.ssh`): forward through an SSH bastion.
   *
   * Returns the effective credentials + the tunnel handle (caller closes it when
   * the driver is evicted).
   */
  private async maybeOpenTunnel(
    creds: ConnectionCredentials,
    agent?: { viaAgent: boolean; agentId: string | null },
  ): Promise<{ creds: ConnectionCredentials; tunnel?: OpenTunnel }> {
    if (agent?.viaAgent) {
      if (!agent.agentId) {
        throw new BadRequestException(
          'This connection is set to use a local agent but no agent is selected.',
        );
      }
      if (!creds.host || !creds.port) {
        throw new BadRequestException(
          'Set the database host and port — the DB address as reachable from the ' +
            'machine running the agent (e.g. 127.0.0.1:5432 or the LAN address).',
        );
      }
      const tunnel = await this.agentTunnel.open(agent.agentId, creds.host, creds.port);
      const tunneled: ConnectionCredentials = {
        ...creds,
        host: tunnel.localHost,
        port: tunnel.localPort,
        ssh: undefined,
      };
      return { creds: tunneled, tunnel };
    }
    if (!creds.ssh) return { creds };
    if (!creds.host || !creds.port) {
      throw new BadRequestException(
        'Set the database host and port. When using an SSH tunnel these are the ' +
          'database address as seen from the SSH server — usually 127.0.0.1 and the ' +
          'database port (e.g. 5432 for PostgreSQL), not the SSH host.',
      );
    }
    const tunnel = await this.ssh.open(creds.ssh, creds.host, creds.port);
    const tunneled: ConnectionCredentials = {
      ...creds,
      host: tunnel.localHost,
      port: tunnel.localPort,
      // Do not forward the ssh block into the driver — it's already consumed.
      ssh: undefined,
    };
    return { creds: tunneled, tunnel };
  }

  async buildDriver(
    id: string,
    overrides: { readOnly?: boolean; preferReplica?: boolean } = {},
  ): Promise<IDatabaseDriver> {
    const c = await this.get(id);
    const readOnly = overrides.readOnly ?? c.readOnly;
    // Replica routing only kicks in for read-only drivers (viewer role or
    // explicit read-only connection). Writes always hit the primary.
    const wantsReplica = overrides.preferReplica && readOnly && c.replicasCt;
    const replicaIdx = wantsReplica ? await this.pickReplicaIndex(c.id) : null;
    const key = this.cacheKey(id, readOnly) + (replicaIdx == null ? '' : `:r${replicaIdx}`);
    let entry = this.driverCache.get(key);
    if (!entry) {
      let raw: ConnectionCredentials;
      if (replicaIdx != null && c.replicasCt) {
        const replicas = await this.crypto.decryptJson<ConnectionCredentials[]>(
          c.replicasCt,
          PURPOSE(id) + ':replicas',
        );
        raw = replicas[replicaIdx] ?? (await this.crypto.decryptJson<ConnectionCredentials>(c.credentialsCt, PURPOSE(id)));
      } else {
        raw = await this.crypto.decryptJson<ConnectionCredentials>(c.credentialsCt, PURPOSE(id));
      }
      const { creds, tunnel } = await this.maybeOpenTunnel(raw, {
        viaAgent: c.viaAgent,
        agentId: c.agentId,
      });
      try {
        const driver = this.factory.create(c.dialect as Dialect, creds, {
          readOnly,
          statementTimeoutMs: c.statementTimeoutMs,
        });
        entry = { driver, lastUsed: Date.now(), inUse: 0, tunnel };
        this.driverCache.set(key, entry);
      } catch (err) {
        // Driver init failed — tear down the tunnel so we don't leak the SSH session.
        if (tunnel) await tunnel.close().catch(() => {});
        // If a replica failed, fall back once to the primary so one bad
        // replica doesn't take the whole read surface down.
        if (replicaIdx != null) {
          return this.buildDriver(id, { readOnly, preferReplica: false });
        }
        throw err;
      }
    }
    entry.inUse++;
    entry.lastUsed = Date.now();
    // Return a proxy that turns .close() into a release (decrement inUse).
    return makeLeasedDriver(entry.driver, () => {
      const e = this.driverCache.get(key);
      if (!e) return;
      e.inUse = Math.max(0, e.inUse - 1);
      e.lastUsed = Date.now();
    });
  }

  /** Round-robin replica selection. Reads the current creds once to count
   *  replicas, then picks `seq % len`. Simple and stateless; a smarter
   *  implementation could track per-replica error rates. */
  private replicaSeq = new Map<string, number>();
  private async pickReplicaIndex(connectionId: string): Promise<number | null> {
    const c = await this.get(connectionId);
    if (!c.replicasCt) return null;
    try {
      const replicas = await this.crypto.decryptJson<ConnectionCredentials[]>(
        c.replicasCt,
        PURPOSE(connectionId) + ':replicas',
      );
      if (!Array.isArray(replicas) || replicas.length === 0) return null;
      const next = (this.replicaSeq.get(connectionId) ?? 0) + 1;
      this.replicaSeq.set(connectionId, next);
      return next % replicas.length;
    } catch {
      return null;
    }
  }

  async buildDriverForRole(id: string, role: Role): Promise<IDatabaseDriver> {
    // Viewer -> always read-only + prefer replica, irrespective of connection setting.
    return this.buildDriver(id, {
      readOnly: role === Role.VIEWER ? true : undefined,
      preferReplica: role === Role.VIEWER,
    });
  }

  /**
   * Insert `count` realistic fake rows into `schema.table`, one type-appropriate
   * value per column. Columns the DB fills for us (identity / serial / a PK with
   * a default) are skipped so we never fight sequences or default-generated keys.
   *
   * Values are bound through the driver's parameterized `insertRow` — never
   * string-concatenated into SQL. Rows that violate a constraint (e.g. an FK on
   * a generated uuid, or a unique clash) are counted and the first error is
   * returned rather than aborting the whole batch.
   */
  async generateRows(
    id: string,
    schema: string,
    table: string,
    count: number,
    role: Role,
  ): Promise<{ inserted: number; errors?: string[] }> {
    // Never write to a read-only connection, regardless of the caller's role.
    const conn = await this.get(id);
    if (conn.readOnly) {
      throw new BadRequestException('This connection is read-only; sample data cannot be generated.');
    }
    const n = Math.max(1, Math.min(1000, Math.floor(count)));

    const drv = await this.buildDriverForRole(id, role);
    try {
      const columns = await drv.getTableColumns(schema, table);
      if (!columns.length) {
        throw new BadRequestException(`No columns found for ${schema}.${table}`);
      }

      // Best-effort: resolve enum labels for USER-DEFINED columns so we can pick
      // a valid value instead of skipping. Postgres only; failures are ignored.
      const enumLabels = await this.resolveEnumLabels(drv, conn.dialect as Dialect, schema, table, columns);

      const rows = buildRows(columns, n, { enumLabels });

      let inserted = 0;
      const errors: string[] = [];
      for (const row of rows) {
        try {
          await drv.insertRow(schema, table, row);
          inserted++;
        } catch (err) {
          if (errors.length < 3) errors.push((err as Error).message ?? String(err));
        }
      }

      return errors.length ? { inserted, errors } : { inserted };
    } finally {
      await drv.close().catch(() => {});
    }
  }

  /**
   * For Postgres USER-DEFINED (enum) columns, query pg_enum for the allowed
   * labels so generated data satisfies the type. Returns a map keyed by
   * lowercased column name. Non-Postgres dialects and any error yield an empty
   * map (the generator then skips nullable enums / best-effort fills others).
   */
  private async resolveEnumLabels(
    drv: IDatabaseDriver,
    dialect: Dialect,
    schema: string,
    table: string,
    columns: { name: string; dataType: string }[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    const enumCols = columns.filter((c) => (c.dataType || '').toLowerCase() === 'user-defined');
    if (dialect !== Dialect.POSTGRES || !enumCols.length) return out;
    try {
      const sql = `
        SELECT c.column_name AS column_name, e.enumlabel AS label
          FROM information_schema.columns c
          JOIN pg_type t ON t.typname = c.udt_name
          JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE c.table_schema = $1 AND c.table_name = $2
         ORDER BY e.enumsortorder`;
      const r = await drv.runRawQuery(sql, [schema, table]);
      for (const row of r.rows as { column_name: string; label: string }[]) {
        const key = String(row.column_name).toLowerCase();
        const arr = out.get(key) ?? [];
        arr.push(String(row.label));
        out.set(key, arr);
      }
    } catch {
      // Non-fatal — generator falls back for unknown enum types.
    }
    return out;
  }

  async test(id: string, userId: string, meta: { ip?: string; userAgent?: string }) {
    // Test bypasses the cache so we don't poison it with bad creds on a brand-new
    // or recently-updated connection. It also uses a fresh driver so the raw
    // error bubbles up (cached driver's close() is a no-op).
    const c = await this.get(id);
    const raw = await this.crypto.decryptJson<ConnectionCredentials>(c.credentialsCt, PURPOSE(id));
    const { creds, tunnel } = await this.maybeOpenTunnel(raw, {
      viaAgent: c.viaAgent,
      agentId: c.agentId,
    });
    const drv = this.factory.create(c.dialect as Dialect, creds, {
      readOnly: c.readOnly,
      statementTimeoutMs: c.statementTimeoutMs,
    });
    try {
      const r = await drv.testConnection();
      await this.audit.log({ userId, connectionId: id, action: 'CONNECTION_TESTED', ...meta, metadata: { ok: r.ok } });
      return r;
    } finally {
      await drv.close().catch(() => {});
      if (tunnel) await tunnel.close().catch(() => {});
    }
  }
}
