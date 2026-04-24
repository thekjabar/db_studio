import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { IncidentSeverity, IncidentStatus, Prisma } from '@prisma/client';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';

export interface IncidentUpdate {
  at: string;
  status: IncidentStatus;
  message: string;
}

export interface PublicStatus {
  overall: 'operational' | 'degraded' | 'outage';
  asOf: string;
  components: {
    name: string;
    status: 'ok' | 'degraded' | 'down';
    detail?: string;
  }[];
  activeIncidents: {
    id: string;
    title: string;
    status: IncidentStatus;
    severity: IncidentSeverity;
    startedAt: string;
    updates: IncidentUpdate[];
  }[];
  recentIncidents: {
    id: string;
    title: string;
    severity: IncidentSeverity;
    startedAt: string;
    resolvedAt: string;
  }[];
}

@Injectable()
export class StatusService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  async publicStatus(): Promise<PublicStatus> {
    const components: PublicStatus['components'] = [];

    // DB probe — the app's own Postgres.
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const ms = Date.now() - dbStart;
      components.push({
        name: 'Database',
        status: ms > 500 ? 'degraded' : 'ok',
        detail: `${ms}ms`,
      });
    } catch {
      components.push({ name: 'Database', status: 'down', detail: 'probe failed' });
    }

    // Redis probe (optional). A down Redis means "scheduled queries +
    // realtime are degraded" — not a full outage.
    if (this.redis) {
      try {
        const p = await this.redis.ping();
        components.push({ name: 'Queue (scheduler)', status: p === 'PONG' ? 'ok' : 'degraded' });
      } catch {
        components.push({ name: 'Queue (scheduler)', status: 'down', detail: 'probe failed' });
      }
    }

    // API itself is serving this request, so mark it operational.
    components.push({ name: 'API', status: 'ok' });

    const [active, recent] = await Promise.all([
      this.prisma.incident.findMany({
        where: { resolvedAt: null },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.incident.findMany({
        where: { resolvedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: 10,
      }),
    ]);

    // Overall status is the worst of the components plus any active incident.
    let overall: PublicStatus['overall'] = 'operational';
    if (components.some((c) => c.status === 'down')) overall = 'outage';
    else if (components.some((c) => c.status === 'degraded')) overall = 'degraded';
    if (active.length > 0) {
      const highest = active.reduce<IncidentSeverity>(
        (sev, i) =>
          severityRank(i.severity) > severityRank(sev) ? i.severity : sev,
        IncidentSeverity.MINOR,
      );
      if (highest === IncidentSeverity.CRITICAL) overall = 'outage';
      else if (highest === IncidentSeverity.MAJOR && overall === 'operational')
        overall = 'degraded';
    }

    return {
      overall,
      asOf: new Date().toISOString(),
      components,
      activeIncidents: active.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        severity: i.severity,
        startedAt: i.startedAt.toISOString(),
        updates: (i.updates as unknown as IncidentUpdate[]) ?? [],
      })),
      recentIncidents: recent.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        startedAt: i.startedAt.toISOString(),
        resolvedAt: i.resolvedAt!.toISOString(),
      })),
    };
  }

  // ---- Admin ----

  async list() {
    return this.prisma.incident.findMany({
      orderBy: { startedAt: 'desc' },
      take: 100,
      include: { createdBy: { select: { email: true, displayName: true } } },
    });
  }

  async create(
    userId: string,
    input: {
      title: string;
      severity?: IncidentSeverity;
      impact?: string;
      message: string;
    },
  ) {
    if (!input.title.trim()) throw new BadRequestException('Title required');
    if (!input.message.trim()) throw new BadRequestException('Initial update message required');
    const firstUpdate: IncidentUpdate = {
      at: new Date().toISOString(),
      status: IncidentStatus.INVESTIGATING,
      message: input.message.slice(0, 2000),
    };
    return this.prisma.incident.create({
      data: {
        title: input.title.slice(0, 200),
        severity: input.severity ?? IncidentSeverity.MINOR,
        impact: input.impact?.slice(0, 500) ?? null,
        status: IncidentStatus.INVESTIGATING,
        updates: [firstUpdate] as unknown as Prisma.InputJsonValue,
        createdById: userId,
      },
    });
  }

  async addUpdate(
    id: string,
    input: { status: IncidentStatus; message: string },
  ) {
    if (!input.message.trim()) throw new BadRequestException('Message required');
    const row = await this.prisma.incident.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    const updates = [
      ...((row.updates as unknown as IncidentUpdate[]) ?? []),
      {
        at: new Date().toISOString(),
        status: input.status,
        message: input.message.slice(0, 2000),
      },
    ];
    return this.prisma.incident.update({
      where: { id },
      data: {
        status: input.status,
        updates: updates as unknown as Prisma.InputJsonValue,
        ...(input.status === IncidentStatus.RESOLVED && row.resolvedAt == null
          ? { resolvedAt: new Date() }
          : {}),
      },
    });
  }

  async remove(id: string) {
    const existing = await this.prisma.incident.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException();
    await this.prisma.incident.delete({ where: { id } });
  }
}

function severityRank(s: IncidentSeverity): number {
  switch (s) {
    case IncidentSeverity.MINOR:
      return 1;
    case IncidentSeverity.MAJOR:
      return 2;
    case IncidentSeverity.CRITICAL:
      return 3;
  }
}
