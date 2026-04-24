import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from '../rbac/rbac.service';

export interface NotebookCell {
  id: string;
  kind: 'md' | 'sql';
  source: string;
  title?: string;
}

@Injectable()
export class NotebooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  async list(userId: string, connectionId?: string) {
    const where = connectionId
      ? { connectionId }
      : {
          OR: [
            { ownerId: userId },
            { connection: { ownerId: userId } },
            { connection: { members: { some: { userId } } } },
            { connection: { workspace: { members: { some: { userId } } } } },
          ],
        };
    return this.prisma.notebook.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        description: true,
        connectionId: true,
        updatedAt: true,
        owner: { select: { id: true, email: true, displayName: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const nb = await this.prisma.notebook.findUnique({ where: { id } });
    if (!nb) throw new NotFoundException('Notebook not found');
    if (nb.ownerId !== userId) {
      await this.rbac.require(userId, nb.connectionId, Role.VIEWER);
    }
    return nb;
  }

  async create(
    userId: string,
    input: { name: string; description?: string; connectionId: string },
  ) {
    if (!input.name.trim()) throw new BadRequestException('Name required');
    await this.rbac.require(userId, input.connectionId, Role.EDITOR);
    return this.prisma.notebook.create({
      data: {
        name: input.name.trim().slice(0, 120),
        description: input.description?.trim().slice(0, 500) || null,
        connectionId: input.connectionId,
        ownerId: userId,
        cells: [
          {
            id: randomCellId(),
            kind: 'md',
            source: `# ${input.name.trim()}\n\n_Add SQL and markdown cells to build your runbook._`,
          },
          { id: randomCellId(), kind: 'sql', source: 'SELECT 1;' },
        ] as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async update(
    userId: string,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      cells?: NotebookCell[];
    },
  ) {
    const nb = await this.assertManage(userId, id);
    const data: Prisma.NotebookUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name.trim().slice(0, 120);
    if (patch.description !== undefined) {
      data.description = patch.description ? patch.description.trim().slice(0, 500) : null;
    }
    if (patch.cells !== undefined) {
      const sanitized = sanitizeCells(patch.cells);
      data.cells = sanitized as unknown as Prisma.InputJsonValue;
    }
    return this.prisma.notebook.update({ where: { id: nb.id }, data });
  }

  async remove(userId: string, id: string) {
    await this.assertManage(userId, id);
    await this.prisma.notebook.delete({ where: { id } });
    return { ok: true as const };
  }

  private async assertManage(userId: string, id: string) {
    const nb = await this.prisma.notebook.findUnique({
      where: { id },
      select: { id: true, ownerId: true, connectionId: true },
    });
    if (!nb) throw new NotFoundException('Notebook not found');
    if (nb.ownerId === userId) return nb;
    // Connection OWNER can manage all notebooks on that connection —
    // same policy as dashboards / scheduled queries.
    const role = await this.rbac.effectiveRole(userId, nb.connectionId);
    if (role !== Role.OWNER) {
      throw new ForbiddenException('Only the notebook owner or connection owner can modify');
    }
    return nb;
  }
}

function sanitizeCells(cells: unknown): NotebookCell[] {
  if (!Array.isArray(cells)) return [];
  const out: NotebookCell[] = [];
  for (const c of cells) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const kind = o.kind === 'md' || o.kind === 'sql' ? o.kind : null;
    if (!kind) continue;
    const id = typeof o.id === 'string' && o.id.length > 0 ? o.id.slice(0, 40) : randomCellId();
    const source = typeof o.source === 'string' ? o.source.slice(0, 100_000) : '';
    const cell: NotebookCell = { id, kind, source };
    if (typeof o.title === 'string' && o.title.length > 0) {
      cell.title = o.title.slice(0, 200);
    }
    out.push(cell);
  }
  // Cap at 200 cells — any real notebook stays well under; abuse protection.
  return out.slice(0, 200);
}

function randomCellId(): string {
  return (
    'c_' +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}
