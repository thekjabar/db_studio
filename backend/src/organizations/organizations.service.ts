import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.organization.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        ownerId: true,
        billingEmail: true,
        enforceSso: true,
        seatLimit: true,
        createdAt: true,
        _count: { select: { members: true, workspaces: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        members: {
          include: { user: { select: { id: true, email: true, displayName: true } } },
          orderBy: { createdAt: 'asc' },
        },
        workspaces: { select: { id: true, name: true, slug: true, isPersonal: true, createdAt: true } },
      },
    });
    if (!org) throw new NotFoundException();
    const isMember =
      org.ownerId === userId || org.members.some((m) => m.userId === userId);
    if (!isMember) throw new ForbiddenException();
    return org;
  }

  async create(userId: string, input: { name: string; slug: string; billingEmail?: string }) {
    if (!input.name.trim() || input.name.length > 120) {
      throw new BadRequestException('Name required (max 120 chars)');
    }
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException('Slug: 1-40 lowercase letters/digits/hyphens');
    }
    // Ensure slug uniqueness explicitly to give a nicer error.
    const taken = await this.prisma.organization.findUnique({ where: { slug } });
    if (taken) throw new BadRequestException('Slug is already taken');

    // Transaction: create org + seat owner as OWNER member.
    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name: input.name.trim(),
          slug,
          ownerId: userId,
          billingEmail: input.billingEmail?.trim().toLowerCase() || null,
        },
      });
      await tx.organizationMember.create({
        data: { organizationId: created.id, userId, role: Role.OWNER },
      });
      return created;
    });
    return org;
  }

  async update(
    userId: string,
    id: string,
    patch: {
      name?: string;
      billingEmail?: string | null;
      enforceSso?: boolean;
      seatLimit?: number | null;
    },
  ) {
    const org = await this.assertOwner(userId, id);
    return this.prisma.organization.update({
      where: { id: org.id },
      data: {
        ...(patch.name !== undefined && { name: patch.name.trim().slice(0, 120) }),
        ...(patch.billingEmail !== undefined && {
          billingEmail: patch.billingEmail ? patch.billingEmail.trim().toLowerCase() : null,
        }),
        ...(patch.enforceSso !== undefined && { enforceSso: patch.enforceSso }),
        ...(patch.seatLimit !== undefined && { seatLimit: patch.seatLimit }),
      },
    });
  }

  async addMember(
    actorId: string,
    id: string,
    input: { email: string; role: Role },
  ) {
    const org = await this.assertOwner(actorId, id);
    const user = await this.prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
    if (!user) throw new NotFoundException(`No user with email ${input.email}`);

    if (org.seatLimit != null) {
      const count = await this.prisma.organizationMember.count({
        where: { organizationId: org.id },
      });
      if (count >= org.seatLimit) {
        throw new BadRequestException('Seat limit reached');
      }
    }

    return this.prisma.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      create: { organizationId: org.id, userId: user.id, role: input.role },
      update: { role: input.role },
    });
  }

  async removeMember(actorId: string, id: string, memberUserId: string) {
    const org = await this.assertOwner(actorId, id);
    if (memberUserId === org.ownerId) {
      throw new BadRequestException('The org owner cannot be removed. Transfer ownership first.');
    }
    await this.prisma.organizationMember.deleteMany({
      where: { organizationId: org.id, userId: memberUserId },
    });
    return { ok: true as const };
  }

  async attachWorkspace(actorId: string, orgId: string, workspaceId: string) {
    const org = await this.assertOwner(actorId, orgId);
    // Caller must also own the workspace.
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!ws) throw new NotFoundException();
    if (ws.ownerId !== actorId) {
      throw new ForbiddenException('Only the workspace owner can attach it to an organization');
    }
    return this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { organizationId: org.id },
    });
  }

  async detachWorkspace(actorId: string, orgId: string, workspaceId: string) {
    const org = await this.assertOwner(actorId, orgId);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { organizationId: null },
    });
    void org;
    return { ok: true as const };
  }

  /** Used by AuthService to decide whether password/OAuth login is allowed. */
  async isSsoEnforcedForEmail(email: string): Promise<boolean> {
    const orgs = await this.prisma.organization.findMany({
      where: {
        enforceSso: true,
        members: { some: { user: { email } } },
      },
      select: { id: true },
    });
    return orgs.length > 0;
  }

  private async assertOwner(userId: string, id: string) {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException();
    if (org.ownerId !== userId) {
      // Allow OWNER-role members too.
      const member = await this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: id, userId } },
      });
      if (!member || member.role !== Role.OWNER) {
        throw new ForbiddenException('Organization owner access required');
      }
    }
    return org;
  }
}
