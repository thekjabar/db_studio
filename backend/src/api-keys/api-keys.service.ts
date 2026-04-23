import { ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_PREFIX = 'dbs_live_';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface CreateApiKeyInput {
  name: string;
  connectionIds?: string[];
  expiresAt?: Date | null;
}

@Injectable()
export class ApiKeysService {
  private readonly log = new Logger(ApiKeysService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, input: CreateApiKeyInput) {
    const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenSha = sha256(raw);
    const tokenHash = await argon2.hash(raw, { type: argon2.argon2id });
    const tokenPrefix = raw.slice(0, TOKEN_PREFIX.length + 6) + '…';

    const key = await this.prisma.apiKey.create({
      data: {
        userId,
        name: input.name,
        tokenSha,
        tokenHash,
        tokenPrefix,
        connectionIds: input.connectionIds ?? [],
        expiresAt: input.expiresAt ?? null,
      },
    });
    return { ...this.sanitize(key), token: raw };
  }

  async list(userId: string) {
    const rows = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.sanitize(r));
  }

  async revoke(userId: string, keyId: string) {
    const row = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!row || row.userId !== userId) throw new NotFoundException();
    if (row.revokedAt) return this.sanitize(row);
    const updated = await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
    return this.sanitize(updated);
  }

  async remove(userId: string, keyId: string) {
    const row = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!row || row.userId !== userId) throw new NotFoundException();
    await this.prisma.apiKey.delete({ where: { id: keyId } });
  }

  /**
   * Resolve an incoming bearer token to the owning user. Called from the
   * custom API-key guard. Two-step verify: fast sha256 lookup (O(1) via
   * unique index), then argon2 verify as an extra safety net against any
   * future collision or index-scan attack.
   */
  async resolveToken(rawToken: string): Promise<{ userId: string; keyId: string; connectionIds: string[] } | null> {
    if (!rawToken.startsWith(TOKEN_PREFIX)) return null;
    const sha = sha256(rawToken);
    const row = await this.prisma.apiKey.findUnique({ where: { tokenSha: sha } });
    if (!row) return null;
    if (row.revokedAt) throw new UnauthorizedException('API key revoked');
    if (row.expiresAt && row.expiresAt < new Date()) throw new UnauthorizedException('API key expired');
    const ok = await argon2.verify(row.tokenHash, rawToken).catch(() => false);
    if (!ok) throw new UnauthorizedException('API key invalid');
    // Best-effort last-used update — don't block the request.
    this.prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch((err) => this.log.warn(`lastUsedAt update failed: ${(err as Error).message}`));
    return {
      userId: row.userId,
      keyId: row.id,
      connectionIds: row.connectionIds,
    };
  }

  /** Assert a resolved key is allowed to act on a given connection. */
  assertConnectionAllowed(key: { connectionIds: string[] }, connectionId: string) {
    if (key.connectionIds.length === 0) return; // unscoped key
    if (!key.connectionIds.includes(connectionId)) {
      throw new ForbiddenException('API key is not scoped to this connection');
    }
  }

  private sanitize(k: {
    id: string;
    userId: string;
    name: string;
    tokenPrefix: string;
    connectionIds: string[];
    expiresAt: Date | null;
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: k.id,
      userId: k.userId,
      name: k.name,
      tokenPrefix: k.tokenPrefix,
      connectionIds: k.connectionIds,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    };
  }
}
