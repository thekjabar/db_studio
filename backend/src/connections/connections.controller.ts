import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ConnectionsService } from './connections.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { CreateConnectionDto, UpdateConnectionDto } from './connections.dto';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

@Controller('connections')
export class ConnectionsController {
  constructor(private readonly svc: ConnectionsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('workspaceId') workspaceId?: string) {
    return this.svc.list(u.id, workspaceId);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateConnectionDto, @Req() req: Request) {
    return this.svc.create(u.id, dto, meta(req));
  }

  @UseGuards(RbacGuard) @RequireRole('VIEWER')
  @Get(':id')
  get(@Param('id') id: string) { return this.svc.getSanitized(id); }

  @UseGuards(RbacGuard) @RequireRole('OWNER')
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateConnectionDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.update(id, dto, u.id, meta(req));
  }

  @UseGuards(RbacGuard) @RequireRole('OWNER')
  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    await this.svc.remove(id, u.id, meta(req));
  }

  @UseGuards(RbacGuard) @RequireRole('VIEWER')
  @Post(':id/test') @HttpCode(200)
  test(@Param('id') id: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.test(id, u.id, meta(req));
  }

  // Read-replica management — connection OWNER only.
  @UseGuards(RbacGuard) @RequireRole('OWNER')
  @Get(':id/replicas')
  listReplicas(@Param('id') id: string) {
    return this.svc.listReplicas(id);
  }

  @UseGuards(RbacGuard) @RequireRole('OWNER')
  @Post(':id/replicas') @HttpCode(200)
  setReplicas(
    @Param('id') id: string,
    @Body() body: { replicas: unknown[] | null },
    @CurrentUser() u: AuthUser,
  ) {
    // Light runtime validation; the drivers will reject bad creds at
    // connect-time via their own type guards.
    const parsed = Array.isArray(body.replicas)
      ? body.replicas.map((r) => r as any)
      : null;
    return this.svc.setReplicas(id, u.id, parsed);
  }
}
