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
      select: { ownerId: true, workspaceId: true },
    });
    if (!conn) return null;
    if (conn.ownerId === userId) return Role.OWNER;
    // Direct grant on the connection wins over workspace-level.
    const direct = await this.prisma.connectionMember.findUnique({
      where: { connectionId_userId: { connectionId, userId } },
      select: { role: true },
    });
    if (direct) return direct.role;
    // Fall back to workspace membership.
    if (conn.workspaceId) {
      const ws = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: conn.workspaceId, userId } },
        select: { role: true },
      });
      if (ws) return ws.role;
    }
    return null;
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

  /**
   * Effective role for a specific table. A table-level grant overrides the
   * connection-level role entirely (upgrade or downgrade). Owner of the
   * connection always retains OWNER — table grants cannot lock the owner out.
   */
  async effectiveTableRole(
    userId: string,
    connectionId: string,
    schemaName: string,
    tableName: string,
  ): Promise<Role | null> {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (!conn) return null;
    if (conn.ownerId === userId) return Role.OWNER;

    const grant = await this.prisma.tableGrant.findUnique({
      where: {
        connectionId_userId_schemaName_tableName: {
          connectionId,
          userId,
          schemaName,
          tableName,
        },
      },
      select: { role: true },
    });
    if (grant) return grant.role;

    return this.effectiveRole(userId, connectionId);
  }

  async requireTable(
    userId: string,
    connectionId: string,
    schemaName: string,
    tableName: string,
    min: Role,
  ): Promise<Role> {
    const role = await this.effectiveTableRole(userId, connectionId, schemaName, tableName);
    if (role === null) {
      const exists = await this.prisma.connection.findUnique({
        where: { id: connectionId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Connection not found');
      throw new ForbiddenException('No access to this connection');
    }
    if (RANK[role] < RANK[min]) {
      throw new ForbiddenException(`Requires ${min} role on ${schemaName}.${tableName} (have ${role})`);
    }
    return role;
  }
}
