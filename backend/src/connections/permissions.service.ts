import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface MemberView {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  createdAt: Date;
}

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
  constructor(private readonly prisma: PrismaService) {}

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

  async addMember(
    connectionId: string,
    actorUserId: string,
    email: string,
    role: Role,
  ): Promise<MemberView> {
    await this.assertOwner(connectionId, actorUserId);

    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, displayName: true },
    });
    if (!user) throw new NotFoundException(`No user with email ${email}`);

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

    const row = await this.prisma.connectionMember.create({
      data: { connectionId, userId: user.id, role },
    });
    return {
      id: row.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: row.role,
      createdAt: row.createdAt,
    };
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
