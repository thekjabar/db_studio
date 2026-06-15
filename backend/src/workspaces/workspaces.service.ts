import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'ws';
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a personal workspace for a new user. Safe to call multiple times. */
  async ensurePersonalWorkspace(userId: string) {
    const existing = await this.prisma.workspace.findFirst({ where: { ownerId: userId, isPersonal: true } });
    if (existing) return existing;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    const base = slugify((user.displayName || user.email.split('@')[0]) + '-personal');
    const slug = await this.uniqueSlug(base);
    return this.prisma.workspace.create({
      data: {
        name: 'Personal',
        slug,
        isPersonal: true,
        ownerId: userId,
        members: { create: { userId, role: Role.OWNER } },
      },
    });
  }

  private async uniqueSlug(base: string): Promise<string> {
    let slug = base;
    for (let i = 2; i < 20; i++) {
      const clash = await this.prisma.workspace.findUnique({ where: { slug } });
      if (!clash) return slug;
      slug = `${base}-${i}`;
    }
    // Really shouldn't happen; collide-then-timestamp.
    return `${base}-${Date.now()}`;
  }

  async listForUser(userId: string) {
    return this.prisma.workspace.findMany({
      where: { members: { some: { userId } } },
      orderBy: [{ isPersonal: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async get(workspaceId: string, userId: string) {
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        members: {
          include: { user: { select: { id: true, email: true, displayName: true } } },
        },
      },
    });
    if (!ws) throw new NotFoundException();
    const me = ws.members.find((m) => m.userId === userId);
    if (!me) throw new ForbiddenException('Not a member of this workspace');
    return { ...ws, myRole: me.role };
  }

  async create(userId: string, name: string) {
    if (!name.trim()) throw new BadRequestException('Name is required');
    const slug = await this.uniqueSlug(slugify(name));
    return this.prisma.workspace.create({
      data: {
        name,
        slug,
        ownerId: userId,
        isPersonal: false,
        members: { create: { userId, role: Role.OWNER } },
      },
    });
  }

  async rename(workspaceId: string, userId: string, name: string) {
    await this.assertRole(workspaceId, userId, Role.OWNER);
    if (!name.trim()) throw new BadRequestException('Name is required');
    return this.prisma.workspace.update({ where: { id: workspaceId }, data: { name } });
  }

  async remove(workspaceId: string, userId: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException();
    if (ws.ownerId !== userId) throw new ForbiddenException('Only the owner can delete a workspace');
    if (ws.isPersonal) throw new BadRequestException('Cannot delete a personal workspace');
    await this.prisma.workspace.delete({ where: { id: workspaceId } });
  }

  async addMember(workspaceId: string, addedBy: string, email: string, role: Role) {
    await this.assertRole(workspaceId, addedBy, Role.OWNER);
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException('User with that email not found');
    try {
      return await this.prisma.workspaceMember.create({
        data: { workspaceId, userId: user.id, role },
      });
    } catch {
      throw new BadRequestException('User is already a member');
    }
  }

  async updateMemberRole(workspaceId: string, updatedBy: string, memberId: string, role: Role) {
    await this.assertRole(workspaceId, updatedBy, Role.OWNER);
    return this.prisma.workspaceMember.update({ where: { id: memberId }, data: { role } });
  }

  async removeMember(workspaceId: string, removedBy: string, memberId: string) {
    await this.assertRole(workspaceId, removedBy, Role.OWNER);
    const m = await this.prisma.workspaceMember.findUnique({ where: { id: memberId } });
    if (!m) throw new NotFoundException();
    if (m.workspaceId !== workspaceId) throw new ForbiddenException();
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws?.ownerId === m.userId) throw new BadRequestException('Cannot remove the workspace owner');
    await this.prisma.workspaceMember.delete({ where: { id: memberId } });
  }

  private async assertRole(workspaceId: string, userId: string, required: Role) {
    const m = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this workspace');
    const order = { VIEWER: 0, EDITOR: 1, OWNER: 2 } as const;
    if (order[m.role] < order[required]) {
      throw new ForbiddenException(`Requires ${required} role`);
    }
  }
}
