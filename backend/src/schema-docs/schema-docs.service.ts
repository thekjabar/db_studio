import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface UpsertDocInput {
  schemaName: string;
  tableName: string;
  columnName?: string | null;
  description?: string | null;
  tags?: string | null;
  ownerEmail?: string | null;
}

@Injectable()
export class SchemaDocsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /** List all docs on a connection (paginated by schema/table usually). */
  async list(
    userId: string,
    connectionId: string,
    schemaName?: string,
    tableName?: string,
  ) {
    await this.rbac.require(userId, connectionId, Role.VIEWER);
    return this.prisma.schemaDoc.findMany({
      where: {
        connectionId,
        ...(schemaName ? { schemaName } : {}),
        ...(tableName ? { tableName } : {}),
      },
      orderBy: [{ schemaName: 'asc' }, { tableName: 'asc' }, { columnName: 'asc' }],
      include: {
        updatedBy: { select: { email: true, displayName: true } },
      },
    });
  }

  async upsert(userId: string, connectionId: string, input: UpsertDocInput) {
    // EDITOR to document — same level as the data being documented.
    await this.rbac.require(userId, connectionId, Role.EDITOR);
    if (!IDENT_RE.test(input.schemaName) || !IDENT_RE.test(input.tableName)) {
      throw new BadRequestException('Invalid schema/table identifier');
    }
    if (input.columnName != null && input.columnName !== '' && !IDENT_RE.test(input.columnName)) {
      throw new BadRequestException('Invalid column identifier');
    }
    const columnName = input.columnName || null;

    return this.prisma.schemaDoc.upsert({
      where: {
        connectionId_schemaName_tableName_columnName: {
          connectionId,
          schemaName: input.schemaName,
          tableName: input.tableName,
          columnName: columnName ?? '',
        },
      },
      create: {
        connectionId,
        schemaName: input.schemaName,
        tableName: input.tableName,
        columnName: columnName ?? '',
        description: input.description?.slice(0, 10_000) ?? null,
        tags: sanitizeTags(input.tags),
        ownerEmail: input.ownerEmail?.trim().toLowerCase() || null,
        updatedById: userId,
      },
      update: {
        description: input.description?.slice(0, 10_000) ?? null,
        tags: sanitizeTags(input.tags),
        ownerEmail: input.ownerEmail?.trim().toLowerCase() || null,
        updatedById: userId,
      },
    });
  }

  async remove(userId: string, connectionId: string, id: string) {
    await this.rbac.require(userId, connectionId, Role.EDITOR);
    const row = await this.prisma.schemaDoc.findFirst({ where: { id, connectionId } });
    if (!row) throw new BadRequestException('Doc not found');
    await this.prisma.schemaDoc.delete({ where: { id } });
    return { ok: true as const };
  }
}

function sanitizeTags(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Split on comma, trim, lowercase, keep unique order-preserving.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (!/^[a-z0-9_-]{1,40}$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 16) break;
  }
  return out.length ? out.join(',') : null;
}
