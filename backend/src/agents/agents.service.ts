import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { AgentRegistry } from '../agent-tunnel/agent-registry.service';

/** Pairing tokens are short-lived so a leaked one can't be replayed for long. */
const PAIRING_TTL = '15m';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly registry: AgentRegistry,
  ) {}

  /** Shape returned to the UI — includes live online status from the registry. */
  private view(a: { id: string; name: string; lastSeenAt: Date | null }) {
    return {
      id: a.id,
      name: a.name,
      online: this.registry.isOnline(a.id),
      lastSeenAt: a.lastSeenAt,
    };
  }

  async list(userId: string) {
    const rows = await this.prisma.agent.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((a) => this.view(a));
  }

  async get(id: string, userId: string) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a || a.ownerId !== userId) throw new NotFoundException();
    return this.view(a);
  }

  async create(userId: string, name: string) {
    const trimmed = (name ?? '').trim();
    if (!trimmed) throw new BadRequestException('Agent name is required.');
    const a = await this.prisma.agent.create({
      data: { name: trimmed.slice(0, 80), ownerId: userId },
    });
    return this.view(a);
  }

  async remove(id: string, userId: string) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a || a.ownerId !== userId) throw new NotFoundException();
    // Unlink any connections still pointing at this agent so they don't dangle.
    await this.prisma.connection.updateMany({
      where: { agentId: id },
      data: { agentId: null, viaAgent: false },
    });
    await this.prisma.agent.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * Mint a short-lived pairing token the user pastes into agent.exe. The token is
   * a JWT signed with the same access secret the /agent-ws gateway verifies, and
   * carries { sub: userId, agentId } so the gateway can bind the socket to this
   * agent. TTL is short; the agent then persists a long-lived refresh secret.
   */
  async createPairingToken(id: string, userId: string) {
    const a = await this.prisma.agent.findUnique({ where: { id } });
    if (!a || a.ownerId !== userId) throw new NotFoundException();
    const token = await this.jwt.signAsync(
      { sub: userId, agentId: id, kind: 'agent-pairing' },
      { secret: this.cfg.jwtAccessSecret, expiresIn: PAIRING_TTL },
    );
    // expiresAt for the UI (15 min from now).
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return { token, expiresAt };
  }
}
