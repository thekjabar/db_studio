import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Role } from '@prisma/client';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeysService } from './api-keys.service';
import { ConnectionsService } from '../connections/connections.service';
import { RbacService } from '../rbac/rbac.service';
import { SqlClassifierService } from '../query/sql-classifier.service';
import { Public } from '../auth/decorators/public.decorator';

class V1QueryDto {
  @IsString() @Length(1, 100_000) sql!: string;
  @IsOptional() @IsArray() params?: unknown[];
  @IsOptional() @IsBoolean() confirmDestructive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) maxRows?: number;
}

/**
 * Minimal public API surfaced under /v1. Bearer-auth with API keys.
 * Intentionally small — the UI's internal routes aren't stable enough to be
 * public. We expose the three things scripts actually need.
 */
@Controller('v1')
@Public() // Skip the global JWT guard — ApiKeyGuard enforces auth instead.
@UseGuards(ApiKeyGuard)
export class PublicApiController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly connections: ConnectionsService,
    private readonly rbac: RbacService,
    private readonly classifier: SqlClassifierService,
  ) {}

  @Get('connections')
  async listConnections(@Req() req: Request) {
    const user = (req as unknown as { user: { id: string } }).user;
    const apiKey = (req as unknown as { apiKey: { connectionIds: string[] } }).apiKey;
    const all = await this.connections.list(user.id);
    if (apiKey.connectionIds.length === 0) return all;
    return all.filter((c) => apiKey.connectionIds.includes(c.id));
  }

  @Get('connections/:id/tables')
  async listTables(@Req() req: Request, @Param('id') id: string, @Query('schema') schema?: string) {
    const { user, apiKey } = this.principal(req);
    this.apiKeys.assertConnectionAllowed(apiKey, id);
    await this.rbac.require(user.id, id, Role.VIEWER);
    const drv = await this.connections.buildDriverForRole(id, Role.VIEWER);
    try {
      return await drv.listTables(schema);
    } finally {
      await drv.close().catch(() => {});
    }
  }

  @Post('connections/:id/query')
  @HttpCode(200)
  async runQuery(@Req() req: Request, @Param('id') id: string, @Body() dto: V1QueryDto) {
    const { user, apiKey } = this.principal(req);
    this.apiKeys.assertConnectionAllowed(apiKey, id);
    const role = await this.rbac.require(user.id, id, Role.VIEWER);
    const conn = await this.connections.get(id);
    const cls = this.classifier.classify(dto.sql, conn.dialect);
    if (cls.kind !== 'SELECT' && role === Role.VIEWER) {
      throw new BadRequestException('Viewer role may only run SELECT statements');
    }
    if (cls.kind === 'DESTRUCTIVE' && !dto.confirmDestructive) {
      throw new BadRequestException({
        message: 'Destructive statement requires confirmDestructive: true',
        classification: cls,
      });
    }
    if (conn.readOnly && cls.kind !== 'SELECT') {
      throw new BadRequestException('Connection is read-only');
    }
    const drv = await this.connections.buildDriverForRole(id, role);
    const started = Date.now();
    try {
      const res = await drv.runRawQuery(dto.sql, dto.params);
      // Apply cap client-side by truncating on the response — keeps public API
      // semantics simple (no magic subquery wrapping).
      const cap = dto.maxRows ?? 0;
      let rows = res.rows;
      let truncated = false;
      if (cap > 0 && rows.length > cap) {
        rows = rows.slice(0, cap);
        truncated = true;
      }
      return {
        rows,
        rowCount: rows.length,
        fields: res.fields,
        command: res.command,
        durationMs: Date.now() - started,
        truncated,
        classification: cls,
      };
    } finally {
      await drv.close().catch(() => {});
    }
  }

  private principal(req: Request) {
    const user = (req as unknown as { user: { id: string } }).user;
    const apiKey = (req as unknown as { apiKey: { connectionIds: string[] } }).apiKey;
    return { user, apiKey };
  }
}
