import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { ConnectionsService } from './connections.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole, RequireTableRole } from '../rbac/rbac.decorator';
import { TableDataQuery } from '../drivers/driver.interface';
import { InsertRowDto, UpdateRowDto, DeleteRowDto, BulkDeleteRowsDto, BulkUpdateRowsDto } from './connections.dto';
import { AuditService } from '../audit/audit.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { Role, WebhookEvent } from '@prisma/client';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@Controller('connections/:id')
@UseGuards(RbacGuard)
export class IntrospectionController {
  constructor(
    private readonly svc: ConnectionsService,
    private readonly audit: AuditService,
    private readonly webhooks: WebhooksService,
  ) {}

  private roleFromReq(req: Request): Role {
    return ((req as any).connectionRole as Role) ?? Role.VIEWER;
  }

  @Get('schemas') @RequireRole('VIEWER')
  async schemas(@Param('id') id: string, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.listSchemas(); } finally { await drv.close().catch(() => {}); }
  }

  @Get('tables') @RequireRole('VIEWER')
  async tables(@Param('id') id: string, @Query('schema') schema: string | undefined, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.listTables(schema); } finally { await drv.close().catch(() => {}); }
  }

  @Get('tables/:name/columns') @RequireRole('VIEWER')
  async columns(@Param('id') id: string, @Param('name') name: string, @Query('schema') schema: string, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.getTableColumns(schema, name); } finally { await drv.close().catch(() => {}); }
  }

  @Get('tables/:name/definition') @RequireRole('VIEWER')
  async definition(@Param('id') id: string, @Param('name') name: string, @Query('schema') schema: string, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      if (!drv.getTableDefinition) {
        return { sql: '', unsupported: true };
      }
      const sql = await drv.getTableDefinition(schema, name);
      return { sql };
    } finally { await drv.close().catch(() => {}); }
  }

  @Get('tables/:name/data') @RequireRole('VIEWER')
  async data(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string,
    @Query('limit') limit = '50', @Query('offset') offset = '0',
    @Query('orderBy') orderByRaw: string | undefined,
    @Query('filters') filtersRaw: string | undefined,
    @Req() req: Request,
  ) {
    const orderBy = (orderByRaw ?? '').split(',').filter(Boolean).map((s) => {
      const [c, d = 'asc'] = s.split(':');
      return { column: c, direction: (d === 'desc' ? 'desc' : 'asc') as 'asc' | 'desc' };
    });
    const filters = filtersRaw ? JSON.parse(filtersRaw) : [];
    const q: TableDataQuery = {
      schema, table: name,
      limit: Math.min(parseInt(limit, 10) || 50, 1000),
      offset: parseInt(offset, 10) || 0,
      orderBy, filters,
    };
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.getTableData(q); } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 60, ttl: 60_000 } })
  @Post('tables/:name/rows') @RequireTableRole('EDITOR')
  async insert(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string, @Body() dto: InsertRowDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      const r = await drv.insertRow(schema, name, dto.values);
      // Capture the inserted row so revert can DELETE by PK.
      await this.audit.log({
        userId: u.id, connectionId: id, action: 'ROW_INSERT', affectedRows: 1, ...meta(req),
        metadata: { table: `${schema}.${name}`, schema, tableName: name, after: r },
      });
      this.webhooks.dispatch({
        connectionId: id, schemaName: schema, tableName: name,
        event: WebhookEvent.ROW_INSERT, userId: u.id, after: r,
      });
      return r;
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 60, ttl: 60_000 } })
  @Patch('tables/:name/rows') @RequireTableRole('EDITOR')
  async update(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string, @Body() dto: UpdateRowDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      // Snapshot the row before mutation so we can diff + revert later.
      const before = drv.fetchRowByPk ? await drv.fetchRowByPk(schema, name, dto.pk).catch(() => null) : null;
      const r = await drv.updateRow(schema, name, dto.pk, dto.values);
      await this.audit.log({
        userId: u.id, connectionId: id, action: 'ROW_UPDATE', affectedRows: 1, ...meta(req),
        metadata: { table: `${schema}.${name}`, schema, tableName: name, pk: dto.pk, before, after: r },
      });
      this.webhooks.dispatch({
        connectionId: id, schemaName: schema, tableName: name,
        event: WebhookEvent.ROW_UPDATE, userId: u.id, pk: dto.pk, before, after: r,
      });
      return r;
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 60, ttl: 60_000 } })
  @Delete('tables/:name/rows') @RequireTableRole('EDITOR')
  async remove(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string, @Body() dto: DeleteRowDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      // Capture the full row before delete so revert can INSERT it back.
      const before = drv.fetchRowByPk ? await drv.fetchRowByPk(schema, name, dto.pk).catch(() => null) : null;
      const affected = await drv.deleteRow(schema, name, dto.pk);
      await this.audit.log({
        userId: u.id, connectionId: id, action: 'ROW_DELETE', affectedRows: affected, ...meta(req),
        metadata: { table: `${schema}.${name}`, schema, tableName: name, pk: dto.pk, before },
      });
      this.webhooks.dispatch({
        connectionId: id, schemaName: schema, tableName: name,
        event: WebhookEvent.ROW_DELETE, userId: u.id, pk: dto.pk, before,
      });
      return { affectedRows: affected };
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post('tables/:name/rows/bulk-delete') @RequireTableRole('EDITOR')
  async bulkRemove(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string, @Body() dto: BulkDeleteRowsDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      // Snapshot before-rows for revert support.
      const beforeRows = drv.fetchRowsByPks
        ? await drv.fetchRowsByPks(schema, name, dto.pks).catch(() => [] as Record<string, unknown>[])
        : [];
      if (!drv.deleteRows) {
        let total = 0;
        for (const pk of dto.pks) total += await drv.deleteRow(schema, name, pk);
        await this.audit.log({ userId: u.id, connectionId: id, action: 'ROW_DELETE', affectedRows: total, ...meta(req), metadata: { table: `${schema}.${name}`, schema, tableName: name, bulk: dto.pks.length, beforeRows } });
        this.webhooks.dispatch({
          connectionId: id, schemaName: schema, tableName: name,
          event: WebhookEvent.ROW_DELETE, userId: u.id, bulk: dto.pks.length,
        });
        return { affectedRows: total };
      }
      const affected = await drv.deleteRows(schema, name, dto.pks);
      await this.audit.log({ userId: u.id, connectionId: id, action: 'ROW_DELETE', affectedRows: affected, ...meta(req), metadata: { table: `${schema}.${name}`, schema, tableName: name, bulk: dto.pks.length, beforeRows } });
      this.webhooks.dispatch({
        connectionId: id, schemaName: schema, tableName: name,
        event: WebhookEvent.ROW_DELETE, userId: u.id, bulk: dto.pks.length,
      });
      return { affectedRows: affected };
    } finally { await drv.close().catch(() => {}); }
  }

  @Throttle({ heavy: { limit: 30, ttl: 60_000 } })
  @Post('tables/:name/rows/bulk-update') @RequireTableRole('EDITOR')
  async bulkUpdate(
    @Param('id') id: string, @Param('name') name: string,
    @Query('schema') schema: string, @Body() dto: BulkUpdateRowsDto,
    @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try {
      const beforeRows = drv.fetchRowsByPks
        ? await drv.fetchRowsByPks(schema, name, dto.pks).catch(() => [] as Record<string, unknown>[])
        : [];
      if (!drv.bulkUpdateRows) {
        let total = 0;
        for (const pk of dto.pks) {
          await drv.updateRow(schema, name, pk, dto.values);
          total++;
        }
        await this.audit.log({ userId: u.id, connectionId: id, action: 'ROW_UPDATE', affectedRows: total, ...meta(req), metadata: { table: `${schema}.${name}`, schema, tableName: name, bulk: dto.pks.length, beforeRows, afterValues: dto.values } });
        this.webhooks.dispatch({
          connectionId: id, schemaName: schema, tableName: name,
          event: WebhookEvent.ROW_UPDATE, userId: u.id, bulk: dto.pks.length,
        });
        return { affectedRows: total };
      }
      const affected = await drv.bulkUpdateRows(schema, name, dto.pks, dto.values);
      await this.audit.log({ userId: u.id, connectionId: id, action: 'ROW_UPDATE', affectedRows: affected, ...meta(req), metadata: { table: `${schema}.${name}`, schema, tableName: name, bulk: dto.pks.length, beforeRows, afterValues: dto.values } });
      this.webhooks.dispatch({
        connectionId: id, schemaName: schema, tableName: name,
        event: WebhookEvent.ROW_UPDATE, userId: u.id, bulk: dto.pks.length,
      });
      return { affectedRows: affected };
    } finally { await drv.close().catch(() => {}); }
  }

  @Get('er') @RequireRole('VIEWER')
  async er(@Param('id') id: string, @Query('schema') schema: string | undefined, @Req() req: Request) {
    const t0 = Date.now();
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    const tConn = Date.now();
    try {
      const er = await drv.introspectForER(schema);
      const tIntro = Date.now();
      const nodes = er.tables.map((t) => ({
        id: `${t.schema}.${t.name}`, schema: t.schema, name: t.name,
        columns: t.columns.map((c) => ({ name: c.name, type: c.dataType, pk: c.isPrimaryKey, nullable: c.nullable })),
      }));
      const edges = er.foreignKeys.map((fk) => ({
        id: fk.name, source: `${fk.schema}.${fk.table}`, target: `${fk.refSchema}.${fk.refTable}`,
        columns: fk.columns, refColumns: fk.refColumns,
      }));
      console.log(
        `[ER] connect=${tConn - t0}ms introspect=${tIntro - tConn}ms tables=${nodes.length} fks=${edges.length} total=${Date.now() - t0}ms`,
      );
      return { nodes, edges };
    } finally { await drv.close().catch(() => {}); }
  }

  @Get('functions') @RequireRole('VIEWER')
  async functions(@Param('id') id: string, @Query('schema') schema: string | undefined, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.listFunctions(schema); } finally { await drv.close().catch(() => {}); }
  }

  @Get('triggers') @RequireRole('VIEWER')
  async triggers(@Param('id') id: string, @Query('schema') schema: string | undefined, @Req() req: Request) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.listTriggers(schema); } finally { await drv.close().catch(() => {}); }
  }

  @Get('indexes') @RequireRole('VIEWER')
  async indexes(
    @Param('id') id: string,
    @Query('schema') schema: string | undefined,
    @Query('table') table: string | undefined,
    @Req() req: Request,
  ) {
    const drv = await this.svc.buildDriverForRole(id, this.roleFromReq(req));
    try { return await drv.listIndexes(schema, table); } finally { await drv.close().catch(() => {}); }
  }
}
