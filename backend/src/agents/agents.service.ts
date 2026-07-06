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
    const token = await this.signPairingToken(id, userId);
    // expiresAt for the UI (15 min from now).
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    return { token, expiresAt };
  }

  private signPairingToken(agentId: string, userId: string) {
    return this.jwt.signAsync(
      { sub: userId, agentId, kind: 'agent-pairing' },
      { secret: this.cfg.jwtAccessSecret, expiresIn: PAIRING_TTL },
    );
  }

  /**
   * Browser auto-pair (see AGENT_AUTOPAIR_PROTOCOL.md). Called by the
   * /agent/authorize page when the user clicks "Allow". Reuses an existing agent
   * with the same name for this user (so re-running the agent on the same machine
   * doesn't spawn duplicates), otherwise creates one — then mints a pairing token.
   * `state` is echoed back so the agent can match its CSRF nonce.
   */
  async authorize(userId: string, name: string, state: string) {
    const trimmed = (name ?? '').trim().slice(0, 80) || 'Local agent';
    let agent = await this.prisma.agent.findFirst({
      where: { ownerId: userId, name: trimmed },
      orderBy: { createdAt: 'desc' },
    });
    if (!agent) {
      agent = await this.prisma.agent.create({ data: { name: trimmed, ownerId: userId } });
    }
    const token = await this.signPairingToken(agent.id, userId);
    return { token, agentId: agent.id, state };
  }
}
