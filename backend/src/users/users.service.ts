import { Injectable, NotFoundException } from '@nestjs/common';
import { Density, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        density: true,
        createdAt: true,
        totpSecret: { select: { enabled: true } },
      },
    });
    if (!u) throw new NotFoundException();
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      density: u.density,
      createdAt: u.createdAt,
      totpEnabled: u.totpSecret?.enabled ?? false,
    };
  }

  async updateProfile(userId: string, patch: { displayName?: string; density?: Density }) {
    const data: Prisma.UserUpdateInput = {};
    if (patch.displayName !== undefined) data.displayName = patch.displayName || null;
    if (patch.density !== undefined) data.density = patch.density;
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, email: true, displayName: true, density: true },
    });
  }
}
