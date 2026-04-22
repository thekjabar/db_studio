import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavedQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  list(connectionId: string) {
    return this.prisma.savedQuery.findMany({
      where: { connectionId }, orderBy: { updatedAt: 'desc' },
    });
  }

  create(userId: string, connectionId: string, name: string, sqlText: string) {
    return this.prisma.savedQuery.create({ data: { userId, connectionId, name, sqlText } });
  }

  async remove(userId: string, id: string) {
    const q = await this.prisma.savedQuery.findUnique({ where: { id } });
    if (!q) throw new NotFoundException();
    if (q.userId !== userId) throw new ForbiddenException('Not your saved query');
    await this.prisma.savedQuery.delete({ where: { id } });
  }
}
