import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { ConnectionsService } from '../connections/connections.service';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardsService } from './dashboards.service';

class CreateDashboardDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsString() connectionId!: string;
  @IsOptional() @IsInt() @Min(10) @Max(86400) refreshSec?: number;
}

class UpdateDashboardDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsNumber() refreshSec?: number | null;
}

class CreateTileDto {
  @IsString() savedQueryId!: string;
  @IsOptional() @IsString() @Length(0, 120) title?: string;
  @IsOptional() @IsObject() chartOverride?: unknown;
  @IsOptional() @IsInt() x?: number;
  @IsOptional() @IsInt() y?: number;
  @IsOptional() @IsInt() w?: number;
  @IsOptional() @IsInt() h?: number;
}

class UpdateTileDto {
  @IsOptional() @IsString() @Length(0, 120) title?: string | null;
  @IsOptional() @IsObject() chartOverride?: unknown;
  @IsOptional() @IsInt() x?: number;
  @IsOptional() @IsInt() y?: number;
  @IsOptional() @IsInt() w?: number;
  @IsOptional() @IsInt() h?: number;
}

class ReorderTileItem {
  @IsString() id!: string;
  @IsInt() x!: number;
  @IsInt() y!: number;
  @IsInt() w!: number;
  @IsInt() h!: number;
}

class ReorderTilesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderTileItem)
  tiles!: ReorderTileItem[];
}

class RotateShareDto {
  @IsOptional() share?: boolean;
}

/** Common helper: run a SavedQuery against the owner's connection role. */
async function runSavedQuery(
  connections: ConnectionsService,
  sql: string,
  connectionId: string,
  role: Role,
) {
  const drv = await connections.buildDriverForRole(connectionId, role);
  try {
    return await drv.runRawQuery(sql);
  } finally {
    await drv.close().catch(() => {});
  }
}

@Controller('dashboards')
@UseGuards(JwtAuthGuard)
export class DashboardsController {
  constructor(
    private readonly svc: DashboardsService,
    private readonly connections: ConnectionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('connectionId') connectionId?: string) {
    return this.svc.list(user.id, connectionId || undefined);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDashboardDto) {
    return this.svc.create(user.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getOr403(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateDashboardDto,
  ) {
    return this.svc.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }

  @Post(':id/share')
  @HttpCode(200)
  share(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RotateShareDto) {
    return this.svc.rotateShareToken(user.id, id, dto.share !== false);
  }

  @Post(':id/tiles')
  @HttpCode(201)
  addTile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: CreateTileDto) {
    return this.svc.addTile(user.id, id, dto);
  }

  @Patch(':id/tiles/:tileId')
  updateTile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('tileId') tileId: string,
    @Body() dto: UpdateTileDto,
  ) {
    return this.svc.updateTile(user.id, id, tileId, dto);
  }

  @Delete(':id/tiles/:tileId')
  removeTile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('tileId') tileId: string,
  ) {
    return this.svc.removeTile(user.id, id, tileId);
  }

  @Put(':id/tiles')
  reorder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReorderTilesDto,
  ) {
    return this.svc.reorderTiles(user.id, id, { tiles: dto.tiles });
  }

  /**
   * Run a single tile. Separate endpoint from /query so dashboards don't
   * consume the heavier throttle bucket — dashboard polls can be more
   * frequent than ad-hoc queries. Role resolves via the dashboard owner's
   * effective permission on the connection; viewers get read-only drivers.
   */
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post(':id/tiles/:tileId/run')
  @HttpCode(200)
  async runTile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('tileId') tileId: string,
  ) {
    // Access gate — same logic as GET :id. This ensures viewers on the
    // connection can still refresh tiles even if they didn't create the
    // dashboard.
    await this.svc.getOr403(user.id, id);
    const tile = await this.prisma.dashboardTile.findUnique({
      where: { id: tileId },
      include: { savedQuery: { select: { sqlText: true, connectionId: true } } },
    });
    if (!tile) throw new NotFoundException('Tile not found');
    // Dashboards always run as VIEWER — charting a destructive statement
    // on a timer would be a footgun.
    return runSavedQuery(this.connections, tile.savedQuery.sqlText, tile.savedQuery.connectionId, Role.VIEWER);
  }
}

/**
 * Public share endpoint — no JWT. Read-only view of a dashboard and its
 * tile contents for anyone with the share token. Enabled only when the
 * owner explicitly rotated a token via /:id/share.
 */
@Controller('public/dashboards')
export class PublicDashboardsController {
  constructor(
    private readonly svc: DashboardsService,
    private readonly connections: ConnectionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get(':token')
  async get(@Param('token') token: string) {
    const d = await this.svc.getByShareToken(token);
    // Strip identifying fields the public shouldn't see. We only return
    // what's needed to render: tile layouts + saved-query text + chart config.
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      refreshSec: d.refreshSec,
      tiles: d.tiles.map((t) => ({
        id: t.id,
        title: t.title ?? t.savedQuery.name,
        chartConfig: t.chartOverride ?? t.savedQuery.chartConfig,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
      })),
    };
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post(':token/tiles/:tileId/run')
  @HttpCode(200)
  async runTile(
    @Param('token') token: string,
    @Param('tileId') tileId: string,
    @Req() req: Request,
  ) {
    const d = await this.svc.getByShareToken(token);
    const tile = d.tiles.find((t) => t.id === tileId);
    if (!tile) throw new NotFoundException('Tile not found');
    void req;
    // Always VIEWER for public shares. The dashboard owner's role is irrelevant
    // here — we don't want a shared link to inherit OWNER.
    return runSavedQuery(
      this.connections,
      tile.savedQuery.sqlText,
      tile.savedQuery.connectionId,
      Role.VIEWER,
    );
  }
}
