import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Deterministic percentile bucketing so a user is always in or out of a
 * flag for a given percent. Crypto-hash of `${key}:${userId}` → 0..99.
 * Changing the percent moves the threshold; the hash itself is stable.
 * Allowlists win over percent, denylists win over allowlists.
 */
@Injectable()
export class FeatureFlagsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async upsert(operatorId: string, body: {
    key: string;
    description?: string | null;
    rolloutPercent: number;
    enabledUserIds?: string[];
    enabledWorkspaceIds?: string[];
    disabledUserIds?: string[];
    disabledWorkspaceIds?: string[];
  }) {
    return this.prisma.featureFlag.upsert({
      where: { key: body.key },
      create: {
        key: body.key,
        description: body.description ?? null,
        rolloutPercent: body.rolloutPercent,
        enabledUserIds: body.enabledUserIds ?? [],
        enabledWorkspaceIds: body.enabledWorkspaceIds ?? [],
        disabledUserIds: body.disabledUserIds ?? [],
        disabledWorkspaceIds: body.disabledWorkspaceIds ?? [],
        updatedByOperatorId: operatorId,
      },
      update: {
        description: body.description ?? null,
        rolloutPercent: body.rolloutPercent,
        enabledUserIds: body.enabledUserIds ?? [],
        enabledWorkspaceIds: body.enabledWorkspaceIds ?? [],
        disabledUserIds: body.disabledUserIds ?? [],
        disabledWorkspaceIds: body.disabledWorkspaceIds ?? [],
        updatedByOperatorId: operatorId,
      },
    });
  }

  async remove(key: string) {
    await this.prisma.featureFlag.delete({ where: { key } }).catch(() => null);
    return { ok: true as const };
  }

  /** Resolve every flag for a given user in a single query. */
  async evaluateForUser(userId: string, workspaceIds: string[]): Promise<Record<string, boolean>> {
    const flags = await this.prisma.featureFlag.findMany();
    const out: Record<string, boolean> = {};
    for (const f of flags) out[f.key] = this.match(f, userId, workspaceIds);
    return out;
  }

  private match(
    f: {
      key: string;
      rolloutPercent: number;
      enabledUserIds: string[];
      enabledWorkspaceIds: string[];
      disabledUserIds: string[];
      disabledWorkspaceIds: string[];
    },
    userId: string,
    workspaceIds: string[],
  ): boolean {
    if (f.disabledUserIds.includes(userId)) return false;
    if (workspaceIds.some((w) => f.disabledWorkspaceIds.includes(w))) return false;
    if (f.enabledUserIds.includes(userId)) return true;
    if (workspaceIds.some((w) => f.enabledWorkspaceIds.includes(w))) return true;
    if (f.rolloutPercent >= 100) return true;
    if (f.rolloutPercent <= 0) return false;
    const h = createHash('sha256').update(`${f.key}:${userId}`).digest();
    const bucket = h.readUInt32BE(0) % 100;
    return bucket < f.rolloutPercent;
  }

  async isEnabledForUser(key: string, userId: string, workspaceIds: string[]): Promise<boolean> {
    const f = await this.prisma.featureFlag.findUnique({ where: { key } });
    if (!f) throw new NotFoundException();
    return this.match(f, userId, workspaceIds);
  }
}
