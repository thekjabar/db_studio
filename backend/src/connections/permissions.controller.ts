import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsEmail, IsEnum, IsString, Length, Matches } from 'class-validator';
import { Role } from '@prisma/client';
import { PermissionsService } from './permissions.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// Ident-shape guard for schema/table names. Mirrors the check in drivers/quote.util.ts
// so a malformed identifier can't sneak into a grant row.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export class AddMemberDto {
  @IsEmail() email!: string;
  @IsEnum(Role) role!: Role;
}

export class UpdateMemberRoleDto {
  @IsEnum(Role) role!: Role;
}

export class UpsertTableGrantDto {
  @IsEmail() email!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) schemaName!: string;
  @IsString() @Length(1, 64) @Matches(IDENT) tableName!: string;
  @IsEnum(Role) role!: Role;
}

@Controller('connections/:id/permissions')
@UseGuards(JwtAuthGuard)
export class PermissionsController {
  constructor(private readonly svc: PermissionsService) {}

  @Get('members')
  listMembers(@Param('id') id: string) {
    return this.svc.listMembers(id);
  }

  /** Add a registered user as a member, or (if they have no account yet) send
   *  them an invitation. Returns { kind: 'member' | 'invite', ... }. */
  @Post('members')
  addMember(@Param('id') id: string, @CurrentUser() u: AuthUser, @Body() dto: AddMemberDto) {
    return this.svc.addMember(id, u.id, dto.email, dto.role);
  }

  /** Pending invitations (people invited who haven't registered yet). */
  @Get('invites')
  listInvites(@Param('id') id: string) {
    return this.svc.listInvites(id);
  }

  @Delete('invites/:inviteId')
  async revokeInvite(
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.svc.revokeInvite(id, u.id, inviteId);
  }

  @Patch('members/:memberId')
  updateMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser() u: AuthUser,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.svc.updateMemberRole(id, u.id, memberId, dto.role);
  }

  @Delete('members/:memberId')
  async removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.svc.removeMember(id, u.id, memberId);
  }

  @Get('table-grants')
  listGrants(@Param('id') id: string) {
    return this.svc.listTableGrants(id);
  }

  @Post('table-grants')
  upsertGrant(
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Body() dto: UpsertTableGrantDto,
  ) {
    return this.svc.upsertTableGrant(id, u.id, dto);
  }

  @Delete('table-grants/:grantId')
  async removeGrant(
    @Param('id') id: string,
    @Param('grantId') grantId: string,
    @CurrentUser() u: AuthUser,
  ) {
    await this.svc.removeTableGrant(id, u.id, grantId);
  }
}
