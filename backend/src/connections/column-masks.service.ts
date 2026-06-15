import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

@Injectable()
export class ColumnMasksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Columns masked for `userId` on (connectionId, schema, table). */
  async maskedColumns(
    userId: string,
    connectionId: string,
    schemaName: string,
    tableName: string,
  ): Promise<Set<string>> {
    const rows = await this.prisma.columnMask.findMany({
      where: { connectionId, userId, schemaName, tableName },
      select: { columnName: true },
    });
    return new Set(rows.map((r) => r.columnName));
  }

  /** Null out masked column values on a row array. Mutates the input. */
  applyMasks<T extends Record<string, unknown>>(rows: T[], masked: Set<string>): T[] {
    if (masked.size === 0) return rows;
    for (const row of rows) {
      for (const col of masked) {
        if (col in row) (row as Record<string, unknown>)[col] = null;
      }
    }
    return rows;
  }

  // ---- Admin ----

  private async assertOwner(connectionId: string, actorUserId: string) {
    const conn = await this.prisma.connection.findUnique({
      where: { id: connectionId },
      select: { ownerId: true },
    });
    if (!conn) throw new NotFoundException();
    if (conn.ownerId !== actorUserId) {
      throw new ForbiddenException('Only the connection owner can manage column masks');
    }
  }

  async list(connectionId: string) {
    const rows = await this.prisma.columnMask.findMany({
      where: { connectionId },
      include: { user: { select: { email: true, displayName: true } } },
      orderBy: [{ schemaName: 'asc' }, { tableName: 'asc' }, { columnName: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      email: r.user.email,
      displayName: r.user.displayName,
      schemaName: r.schemaName,
      tableName: r.tableName,
      columnName: r.columnName,
      createdAt: r.createdAt,
    }));
  }

  async create(
    connectionId: string,
    actorUserId: string,
    input: { email: string; schemaName: string; tableName: string; columnName: string },
  ) {
    await this.assertOwner(connectionId, actorUserId);
    if (![input.schemaName, input.tableName, input.columnName].every((s) => IDENT_RE.test(s))) {
      throw new BadRequestException('Invalid identifier');
    }
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
      throw new BadRequestException('Cannot mask columns from the connection owner');
    }

    const row = await this.prisma.columnMask.upsert({
      where: {
        connectionId_userId_schemaName_tableName_columnName: {
          connectionId,
          userId: user.id,
          schemaName: input.schemaName,
          tableName: input.tableName,
          columnName: input.columnName,
        },
      },
      create: {
        connectionId,
        userId: user.id,
        schemaName: input.schemaName,
        tableName: input.tableName,
        columnName: input.columnName,
      },
      update: {},
    });
    return {
      id: row.id,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      schemaName: row.schemaName,
      tableName: row.tableName,
      columnName: row.columnName,
      createdAt: row.createdAt,
    };
  }

  async remove(connectionId: string, actorUserId: string, id: string) {
    await this.assertOwner(connectionId, actorUserId);
    const existing = await this.prisma.columnMask.findFirst({
      where: { id, connectionId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException();
    await this.prisma.columnMask.delete({ where: { id } });
  }
}
