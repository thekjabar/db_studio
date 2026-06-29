import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { DbUsersService } from './db-users.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import {
  AlterDbUserDto, CreateDbUserDto, GrantDto, MembershipDto, RevokeDto,
} from './db-users.dto';

function meta(req: Request) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined };
}

/**
 * Manage database-level users/roles on a connected Postgres server. Every
 * endpoint requires connection OWNER (these are powerful DDL operations) and is
 * audited by the service.
 */
@Controller('connections/:id/db-users')
@UseGuards(RbacGuard)
@RequireRole('OWNER')
export class DbUsersController {
  constructor(private readonly svc: DbUsersService) {}

  @Get()
  list(@Param('id') id: string) {
    return this.svc.listUsers(id);
  }

  @Get(':role/privileges')
  privileges(@Param('id') id: string, @Param('role') role: string) {
    return this.svc.getUserPrivileges(id, role);
  }

  @Post()
  create(@Param('id') id: string, @Body() dto: CreateDbUserDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.createUser(id, dto, u.id, meta(req));
  }

  @Patch(':role')
  alter(@Param('id') id: string, @Param('role') role: string, @Body() dto: AlterDbUserDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.alterUser(id, role, dto, u.id, meta(req));
  }

  @Delete(':role') @HttpCode(200)
  drop(@Param('id') id: string, @Param('role') role: string, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.dropUser(id, role, u.id, meta(req));
  }

  @Post('grant')
  grant(@Param('id') id: string, @Body() dto: GrantDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.grant(id, dto, u.id, meta(req));
  }

  @Post('revoke')
  revoke(@Param('id') id: string, @Body() dto: RevokeDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.revoke(id, dto, u.id, meta(req));
  }

  @Post('membership')
  addMembership(@Param('id') id: string, @Body() dto: MembershipDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.addMembership(id, dto, u.id, meta(req));
  }

  @Post('membership/remove')
  removeMembership(@Param('id') id: string, @Body() dto: MembershipDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.svc.removeMembership(id, dto, u.id, meta(req));
  }
}
