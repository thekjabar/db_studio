import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Dialect, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { DriverFactory } from '../drivers/driver.factory';
import { AuditService } from '../audit/audit.service';
import { ConnectionCredentials, IDatabaseDriver } from '../drivers/driver.interface';
import { CreateConnectionDto, UpdateConnectionDto } from './connections.dto';

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
    private readonly audit: AuditService,
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
      ownerId: c.ownerId, createdAt: c.createdAt, updatedAt: c.updatedAt,
    };
  }

  async create(userId: string, dto: CreateConnectionDto, meta: { ip?: string; userAgent?: string }) {
    const credCt = this.crypto.encryptJson(dto.credentials, 'conn:new');
    const created = await this.prisma.connection.create({
      data: {
        name: dto.name, dialect: dto.dialect, credentialsCt: credCt,
        readOnly: dto.readOnly ?? false,
        statementTimeoutMs: dto.statementTimeoutMs ?? 30_000,
        ownerId: userId,
      },
    });
    // Re-encrypt with purpose bound to id.
    const rebound = this.crypto.encryptJson(dto.credentials, PURPOSE(created.id));
    const final = await this.prisma.connection.update({
      where: { id: created.id }, data: { credentialsCt: rebound },
    });
    await this.audit.log({ userId, connectionId: final.id, action: 'CONNECTION_CREATED', ...meta });
    return this.sanitize(final);
  }

  async list(userId: string) {
    const rows = await this.prisma.connection.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.sanitize(r));
  }

  async get(id: string) {
    const c = await this.prisma.connection.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    return c;
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
    };
    if (dto.credentials) {
      const current = this.crypto.decryptJson<ConnectionCredentials>(existing.credentialsCt, PURPOSE(id));
      const merged = { ...current, ...dto.credentials };
      data.credentialsCt = this.crypto.encryptJson(merged, PURPOSE(id));
    }
    const updated = await this.prisma.connection.update({ where: { id }, data });
    // Credentials, readOnly or timeout might have changed — drop cached pools.
    await this.invalidate(id);
    await this.audit.log({ userId, connectionId: id, action: 'CONNECTION_UPDATED', ...meta });
    return this.sanitize(updated);
  }

  async remove(id: string, userId: string, meta: { ip?: string; userAgent?: string }) {
    await this.invalidate(id);
    await this.prisma.connection.delete({ where: { id } });
    await this.audit.log({ userId, connectionId: id, action: 'CONNECTION_DELETED', ...meta });
  }

  async buildDriver(id: string, overrides: { readOnly?: boolean } = {}): Promise<IDatabaseDriver> {
    const c = await this.get(id);
    const readOnly = overrides.readOnly ?? c.readOnly;
    const key = this.cacheKey(id, readOnly);
    let entry = this.driverCache.get(key);
    if (!entry) {
      const creds = this.crypto.decryptJson<ConnectionCredentials>(c.credentialsCt, PURPOSE(id));
      const driver = this.factory.create(c.dialect as Dialect, creds, {
        readOnly,
        statementTimeoutMs: c.statementTimeoutMs,
      });
      entry = { driver, lastUsed: Date.now(), inUse: 0 };
      this.driverCache.set(key, entry);
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

  async buildDriverForRole(id: string, role: Role): Promise<IDatabaseDriver> {
    // Viewer -> always read-only, irrespective of connection setting.
    return this.buildDriver(id, { readOnly: role === Role.VIEWER ? true : undefined });
  }

  async test(id: string, userId: string, meta: { ip?: string; userAgent?: string }) {
    // Test bypasses the cache so we don't poison it with bad creds on a brand-new
    // or recently-updated connection. It also uses a fresh driver so the raw
    // error bubbles up (cached driver's close() is a no-op).
    const c = await this.get(id);
    const creds = this.crypto.decryptJson<ConnectionCredentials>(c.credentialsCt, PURPOSE(id));
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
    }
  }
}
