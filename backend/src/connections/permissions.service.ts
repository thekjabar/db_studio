import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { EmailService } from '../scheduler/email.service';
import { PlanService } from '../billing/plan.service';

export interface MemberView {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  createdAt: Date;
}

/** A pending invitation for someone who hasn't registered yet. */
export interface InviteView {
  id: string;
  email: string;
  role: Role;
  status: string;
  createdAt: Date;
}

/** addMember returns whichever happened: an added member or a sent invite. */
export type AddMemberResult =
  | { kind: 'member'; member: MemberView }
  | { kind: 'invite'; invite: InviteView; emailed: boolean };

export interface TableGrantView {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  schemaName: string;
  tableName: string;
  role: Role;
  createdAt: Date;
}

@Injectable()
export class PermissionsService {
  private readonly logger = new Logger(PermissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly email: EmailService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Enforce the owner's plan member cap. "Members" here = people who can access
   * this connection: current members + still-pending invites (the owner is
   * implicit and doesn't count). null maxSeats (Team) = unlimited.
   */
  private async assertSeatAvailable(connectionId: string, ownerId: string): Promise<void> {
    const plan = await this.plans.forUser(ownerId);
    if (plan.maxSeats == null) return;
    const [members, invites] = await Promise.all([
      this.prisma.connectionMember.count({ where: { connectionId } }),
      this.prisma.connectionInvite.count({ where: { connectionId, status: 'PENDING' } }),
    ]);
    if (members + invites >= plan.maxSeats) {
      throw new ForbiddenException(
        `Your ${plan.name} plan allows up to ${plan.maxSeats} member(s) per connection. Upgrade your plan to add more.`,
      );
    }
  }

  private async assertOwner(connectionId: string, actorUserId: string): Promise<void> {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (!conn) throw new NotFoundException('Connection not found');
    if (conn.ownerId !== actorUserId) throw new ForbiddenException('Only the connection owner can manage permissions');
  }

  // ---- Connection members ----

  async listMembers(connectionId: string): Promise<MemberView[]> {
    const rows = await this.prisma.connectionMember.findMany({
      where: { connectionId },
      include: { user: { select: { email: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.user.email,
      displayName: r.user.displayName,
      role: r.role,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Add a member by email. If the email belongs to a registered user they're
   * added immediately; otherwise a pending invitation is created and emailed,
   * and claimed automatically when that person signs up (see claimInvites).
   */
  async addMember(
    connectionId: string,
    actorUserId: string,
    email: string,
    role: Role,
  ): Promise<AddMemberResult> {
    await this.assertOwner(connectionId, actorUserId);
    const normEmail = email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { email: normEmail },
      select: { id: true, email: true, displayName: true },
    });

    // Unregistered → create/refresh a pending invite and email them.
    if (!user) {
      const invite = await this.inviteUnregistered(connectionId, actorUserId, normEmail, role);
      return invite;
    }

    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (conn?.ownerId === user.id) {
      throw new BadRequestException('Owner is already an implicit member');
    }

    const existing = await this.prisma.connectionMember.findUnique({
      where: { connectionId_userId: { connectionId, userId: user.id } },
    });
    if (existing) throw new ConflictException('User already a member');

    // New member — enforce the owner's plan member cap.
    await this.assertSeatAvailable(connectionId, conn!.ownerId);

    const row = await this.prisma.connectionMember.create({
      data: { connectionId, userId: user.id, role },
    });
    // If there was a stale pending invite for this email, it's now moot.
    await this.prisma.connectionInvite
      .deleteMany({ where: { connectionId, email: normEmail } })
      .catch(() => undefined);

    return {
      kind: 'member',
      member: {
        id: row.id,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        role: row.role,
        createdAt: row.createdAt,
      },
    };
  }

  private async inviteUnregistered(
    connectionId: string,
    actorUserId: string,
    email: string,
    role: Role,
  ): Promise<AddMemberResult> {
    // A brand-new invite consumes a seat; re-inviting an existing pending email
    // (role/token refresh) does not.
    const existingInvite = await this.prisma.connectionInvite.findUnique({
      where: { connectionId_email: { connectionId, email } },
    });
    if (!existingInvite) {
      await this.assertSeatAvailable(connectionId, actorUserId);
    }

    const token = randomBytes(24).toString('base64url');
    // Upsert so re-inviting the same email just refreshes the role/token.
    const invite = await this.prisma.connectionInvite.upsert({
      where: { connectionId_email: { connectionId, email } },
      create: { connectionId, email, role, invitedById: actorUserId, token, status: 'PENDING' },
      update: { role, status: 'PENDING', token, invitedById: actorUserId },
    });

    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { name: true },
    });
    const emailed = await this.sendInviteEmail(email, conn?.name ?? 'a database connection', token);

    return {
      kind: 'invite',
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        status: invite.status,
        createdAt: invite.createdAt,
      },
      emailed,
    };
  }

  private async sendInviteEmail(email: string, connName: string, token: string): Promise<boolean> {
    if (!this.email.enabled) return false;
    const link = `${this.cfg.appBaseUrl}/signup?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    try {
      await this.email.send({
        to: [email],
        subject: `You've been invited to collaborate on Query Schema`,
        body:
          `You've been invited to access the "${connName}" database connection on Query Schema.\n\n` +
          `Create your account with this email to get access:\n${link}\n\n` +
          `If you didn't expect this, you can ignore this email.`,
        html:
          `<p>You've been invited to access the <b>${connName}</b> database connection on Query Schema.</p>` +
          `<p>Create your account with this email to get access:</p>` +
          `<p><a href="${link}">Accept the invitation</a></p>` +
          `<p style="color:#888;font-size:12px">If you didn't expect this, you can ignore this email.</p>`,
      });
      return true;
    } catch (e) {
      this.logger.warn(`Invite email to ${email} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Pending invitations for a connection (owner view). */
  async listInvites(connectionId: string): Promise<InviteView[]> {
    const rows = await this.prisma.connectionInvite.findMany({
      where: { connectionId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: r.status,
      createdAt: r.createdAt,
    }));
  }

  async revokeInvite(connectionId: string, actorUserId: string, inviteId: string): Promise<void> {
    await this.assertOwner(connectionId, actorUserId);
    const inv = await this.prisma.connectionInvite.findFirst({
      where: { id: inviteId, connectionId },
      select: { id: true },
    });
    if (!inv) throw new NotFoundException('Invitation not found');
    await this.prisma.connectionInvite.delete({ where: { id: inviteId } });
  }

  async updateMemberRole(
    connectionId: string,
    actorUserId: string,
    memberId: string,
    role: Role,
  ): Promise<MemberView> {
    await this.assertOwner(connectionId, actorUserId);
    const existing = await this.prisma.connectionMember.findFirst({
      where: { id: memberId, connectionId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    if (!existing) throw new NotFoundException('Member not found');
    const row = await this.prisma.connectionMember.update({
      where: { id: memberId },
      data: { role },
    });
    return {
      id: row.id,
      userId: existing.userId,
      email: existing.user.email,
      displayName: existing.user.displayName,
      role: row.role,
      createdAt: row.createdAt,
    };
  }

  async removeMember(connectionId: string, actorUserId: string, memberId: string): Promise<void> {
    await this.assertOwner(connectionId, actorUserId);
    const existing = await this.prisma.connectionMember.findFirst({
      where: { id: memberId, connectionId },
      select: { userId: true },
    });
    if (!existing) throw new NotFoundException('Member not found');
    // Also clear any table grants so they don't dangle.
    await this.prisma.$transaction([
      this.prisma.tableGrant.deleteMany({ where: { connectionId, userId: existing.userId } }),
      this.prisma.connectionMember.delete({ where: { id: memberId } }),
    ]);
  }

  // ---- Per-table grants ----

  async listTableGrants(connectionId: string): Promise<TableGrantView[]> {
    const rows = await this.prisma.tableGrant.findMany({
      where: { connectionId },
      include: { user: { select: { email: true, displayName: true } } },
      orderBy: [{ schemaName: 'asc' }, { tableName: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.user.email,
      displayName: r.user.displayName,
      schemaName: r.schemaName,
      tableName: r.tableName,
      role: r.role,
      createdAt: r.createdAt,
    }));
  }

  async upsertTableGrant(
    connectionId: string,
    actorUserId: string,
    input: { email: string; schemaName: string; tableName: string; role: Role },
  ): Promise<TableGrantView> {
    await this.assertOwner(connectionId, actorUserId);
    const user = await this.prisma.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) throw new NotFoundException(`No user with email ${input.email}`);

    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (conn?.ownerId === user.id) {
      throw new BadRequestException('Cannot override role for the connection owner');
    }

    const row = await this.prisma.tableGrant.upsert({
      where: {
        connectionId_userId_schemaName_tableName: {
          connectionId,
          userId: user.id,
          schemaName: input.schemaName,
          tableName: input.tableName,
        },
      },
      create: {
        connectionId,
        userId: user.id,
        schemaName: input.schemaName,
        tableName: input.tableName,
        role: input.role,
      },
      update: { role: input.role },
    });
    return {
      id: row.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      schemaName: row.schemaName,
      tableName: row.tableName,
      role: row.role,
      createdAt: row.createdAt,
    };
  }

  async removeTableGrant(
    connectionId: string,
    actorUserId: string,
    grantId: string,
  ): Promise<void> {
    await this.assertOwner(connectionId, actorUserId);
    const existing = await this.prisma.tableGrant.findFirst({
      where: { id: grantId, connectionId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Grant not found');
    await this.prisma.tableGrant.delete({ where: { id: grantId } });
  }
}
