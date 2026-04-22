import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const RANK: Record<Role, number> = { VIEWER: 1, EDITOR: 2, OWNER: 3 };

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  async effectiveRole(userId: string, connectionId: string): Promise<Role | null> {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (!conn) return null;
    if (conn.ownerId === userId) return Role.OWNER;
    const m = await this.prisma.connectionMember.findUnique({
      where: { connectionId_userId: { connectionId, userId } },
      select: { role: true },
    });
    return m?.role ?? null;
  }

  async require(userId: string, connectionId: string, min: Role): Promise<Role> {
    const role = await this.effectiveRole(userId, connectionId);
    if (role === null) {
      const exists = await this.prisma.connection.findUnique({
        where: { id: connectionId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Connection not found');
      throw new ForbiddenException('No access to this connection');
    }
    if (RANK[role] < RANK[min]) {
      throw new ForbiddenException(`Requires ${min} role (have ${role})`);
    }
    return role;
  }
}
