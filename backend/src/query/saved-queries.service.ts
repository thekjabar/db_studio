import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ChartConfig {
  type: 'line' | 'bar' | 'pie' | 'area';
  x: string;
  y: string[];
  stacked?: boolean;
  limit?: number;
}

@Injectable()
export class SavedQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  list(connectionId: string) {
    return this.prisma.savedQuery.findMany({
      where: { connectionId }, orderBy: { updatedAt: 'desc' },
    });
  }

  get(id: string) {
    return this.prisma.savedQuery.findUnique({ where: { id } });
  }

  create(
    userId: string,
    connectionId: string,
    name: string,
    sqlText: string,
    chartConfig?: ChartConfig | null,
  ) {
    return this.prisma.savedQuery.create({
      data: {
        userId,
        connectionId,
        name,
        sqlText,
        // Prisma treats `Prisma.JsonNull` as "store SQL NULL" for nullable JSON
        // columns. Plain `null`/`undefined` are rejected by the generated type.
        chartConfig: chartConfig == null ? Prisma.JsonNull : (chartConfig as unknown as Prisma.InputJsonValue),
      },
    });
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; sqlText?: string; chartConfig?: ChartConfig | null },
  ) {
    const q = await this.prisma.savedQuery.findUnique({ where: { id } });
    if (!q) throw new NotFoundException();
    if (q.userId !== userId) throw new ForbiddenException('Not your saved query');
    const data: Prisma.SavedQueryUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.sqlText !== undefined) data.sqlText = patch.sqlText;
    if (patch.chartConfig !== undefined) {
      data.chartConfig =
        patch.chartConfig == null ? Prisma.JsonNull : (patch.chartConfig as unknown as Prisma.InputJsonValue);
    }
    return this.prisma.savedQuery.update({ where: { id }, data });
  }

  async remove(userId: string, id: string) {
    const q = await this.prisma.savedQuery.findUnique({ where: { id } });
    if (!q) throw new NotFoundException();
    if (q.userId !== userId) throw new ForbiddenException('Not your saved query');
    await this.prisma.savedQuery.delete({ where: { id } });
  }
}
