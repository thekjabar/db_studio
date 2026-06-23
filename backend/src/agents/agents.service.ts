import { ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Network agent pairing + lifecycle. Mirrors ApiKeysService's token scheme:
 * a one-time secret shown at creation, stored as sha256 (fast unique lookup)
 * + argon2id (verified on connect). The agent presents this token when it
 * opens its outbound WebSocket to the cloud relay.
 */

const TOKEN_PREFIX = 'agt_live_';

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Authorize the caller as an OWNER of the workspace before agent mutations. */
  async assertOwner(workspaceId: string, userId: string) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this workspace');
    if (m.role !== 'OWNER') throw new ForbiddenException('Requires OWNER role');
  }

  /** Create an agent for a workspace. Returns the one-time pairing token. */
  async create(workspaceId: string, name: string) {
    const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const tokenSha = sha256(raw);
    const tokenHash = await argon2.hash(raw, { type: argon2.argon2id });
    const tokenPrefix = raw.slice(0, TOKEN_PREFIX.length + 6) + '…';

    const agent = await this.prisma.workspaceAgent.create({
      data: { workspaceId, name, tokenSha, tokenHash, tokenPrefix },
    });
    return { ...this.sanitize(agent), token: raw };
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.workspaceAgent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.sanitize(r));
  }

  async revoke(workspaceId: string, agentId: string) {
    const row = await this.prisma.workspaceAgent.findUnique({ where: { id: agentId } });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException();
    if (row.revokedAt) return this.sanitize(row);
    const updated = await this.prisma.workspaceAgent.update({
      where: { id: agentId },
      data: { revokedAt: new Date(), status: 'offline' },
    });
    return this.sanitize(updated);
  }

  async remove(workspaceId: string, agentId: string) {
    const row = await this.prisma.workspaceAgent.findUnique({ where: { id: agentId } });
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException();
    await this.prisma.workspaceAgent.delete({ where: { id: agentId } });
  }

  /**
   * Resolve a pairing token presented by a connecting agent. Two-step verify:
   * sha256 unique-index lookup, then argon2 confirm. Returns the agent record
   * (id + workspaceId) or throws / returns null.
   */
  async resolveToken(rawToken: string): Promise<{ agentId: string; workspaceId: string } | null> {
    if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) return null;
    const row = await this.prisma.workspaceAgent.findUnique({ where: { tokenSha: sha256(rawToken) } });
    if (!row) return null;
    if (row.revokedAt) throw new UnauthorizedException('Agent revoked');
    const ok = await argon2.verify(row.tokenHash, rawToken).catch(() => false);
    if (!ok) throw new UnauthorizedException('Agent token invalid');
    return { agentId: row.id, workspaceId: row.workspaceId };
  }

  /** Mark an agent online/offline + bump lastSeenAt. Called by the gateway. */
  async setStatus(agentId: string, status: 'online' | 'offline', agentVersion?: string) {
    await this.prisma.workspaceAgent
      .update({
        where: { id: agentId },
        data: {
          status,
          lastSeenAt: new Date(),
          ...(agentVersion ? { agentVersion } : {}),
        },
      })
      .catch((err) => this.log.warn(`agent status update failed: ${(err as Error).message}`));
  }

  /** Touch lastSeenAt on heartbeat without flipping status. */
  async heartbeat(agentId: string) {
    await this.prisma.workspaceAgent
      .update({ where: { id: agentId }, data: { lastSeenAt: new Date() } })
      .catch(() => {});
  }

  /**
   * Assert that a connection routed through an agent has an online agent in the
   * same workspace. Returns the agentId to relay to.
   */
  async resolveConnectionAgent(connectionId: string): Promise<string> {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { connectVia: true, agentId: true, agent: { select: { id: true, status: true, revokedAt: true } } },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    if (conn.connectVia !== 'agent' || !conn.agent) {
      throw new ForbiddenException('Connection is not routed through an agent');
    }
    if (conn.agent.revokedAt) throw new ForbiddenException('The agent for this connection is revoked');
    return conn.agent.id;
  }

  private sanitize(a: {
    id: string;
    workspaceId: string;
    name: string;
    tokenPrefix: string;
    status: string;
    lastSeenAt: Date | null;
    agentVersion: string | null;
    revokedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: a.id,
      workspaceId: a.workspaceId,
      name: a.name,
      tokenPrefix: a.tokenPrefix,
      status: a.status,
      lastSeenAt: a.lastSeenAt,
      agentVersion: a.agentVersion,
      revokedAt: a.revokedAt,
      createdAt: a.createdAt,
    };
  }
}
