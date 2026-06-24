import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OperatorGuard } from './operator.guard';
import { OperatorAuditService } from './operator-audit.service';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/audit')
export class OperatorAuditController {
  constructor(
    private readonly svc: OperatorAuditService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Query('limit') limitRaw = '50',
    @Query('offset') offsetRaw = '0',
    @Query('action') action?: string,
    @Query('operatorId') operatorId?: string,
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    return this.svc.list({ limit, offset, action, operatorId });
  }

  /**
   * Streaming export for SIEM ingest. csv = analyst-friendly;
   * jsonl = log-pipeline friendly. Streamed in batches of 1000 so a
   * multi-million-row audit log doesn't OOM the process.
   */
  @Get('export')
  async export(
    @Res() res: Response,
    @Query('format') format: 'csv' | 'jsonl' = 'csv',
    @Query('from') fromIso?: string,
    @Query('to') toIso?: string,
  ) {
    const where: Record<string, unknown> = {};
    if (fromIso || toIso) {
      const range: Record<string, Date> = {};
      if (fromIso) range.gte = new Date(fromIso);
      if (toIso) range.lte = new Date(toIso);
      where.createdAt = range;
    }
    const suffix = format === 'jsonl' ? 'jsonl' : 'csv';
    res.setHeader('Content-Type', format === 'jsonl' ? 'application/x-ndjson' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.${suffix}"`);
    if (format === 'csv') {
      res.write('id,createdAt,operatorId,operatorEmail,action,targetType,targetId,reason,metadata\n');
    }
    const batchSize = 1000;
    let lastId: string | undefined;
    while (true) {
      const page = await this.prisma.operatorAuditLog.findMany({
        where,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        include: { operator: { select: { email: true } } },
      });
      if (page.length === 0) break;
      for (const r of page) {
        if (format === 'jsonl') {
          res.write(JSON.stringify({
            id: r.id,
            createdAt: r.createdAt.toISOString(),
            operatorId: r.operatorId,
            operatorEmail: r.operator.email,
            action: r.action,
            targetType: r.targetType,
            targetId: r.targetId,
            reason: r.reason,
            metadata: r.metadata,
          }) + '\n');
        } else {
          res.write([
            csvEscape(r.id),
            r.createdAt.toISOString(),
            csvEscape(r.operatorId),
            csvEscape(r.operator.email),
            csvEscape(r.action),
            csvEscape(r.targetType ?? ''),
            csvEscape(r.targetId ?? ''),
            csvEscape(r.reason ?? ''),
            csvEscape(r.metadata ? JSON.stringify(r.metadata) : ''),
          ].join(',') + '\n');
        }
      }
      lastId = page[page.length - 1].id;
      if (page.length < batchSize) break;
    }
    res.end();
  }
}

function csvEscape(v: string): string {
  if (!v) return '';
  if (v.includes('"') || v.includes(',') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
