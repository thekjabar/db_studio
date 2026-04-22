import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { IsEmail, IsEnum, IsString, Length } from 'class-validator';
import { Role } from '@prisma/client';
import { WorkspacesService } from './workspaces.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class CreateWorkspaceDto {
  @IsString() @Length(1, 80) name!: string;
}
class RenameWorkspaceDto {
  @IsString() @Length(1, 80) name!: string;
}
class AddMemberDto {
  @IsEmail() email!: string;
  @IsEnum(Role) role!: Role;
}
class UpdateMemberDto {
  @IsEnum(Role) role!: Role;
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly svc: WorkspacesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listForUser(u.id);
  }

  @Post()
  create(@Body() dto: CreateWorkspaceDto, @CurrentUser() u: AuthUser) {
    return this.svc.create(u.id, dto.name);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.get(id, u.id);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() dto: RenameWorkspaceDto, @CurrentUser() u: AuthUser) {
    return this.svc.rename(id, u.id, dto.name);
  }

  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    await this.svc.remove(id, u.id);
  }

  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: AddMemberDto, @CurrentUser() u: AuthUser) {
    return this.svc.addMember(id, u.id, dto.email, dto.role);
  }

  @Patch(':id/members/:memberId')
  updateMember(@Param('id') id: string, @Param('memberId') memberId: string, @Body() dto: UpdateMemberDto, @CurrentUser() u: AuthUser) {
    return this.svc.updateMemberRole(id, u.id, memberId, dto.role);
  }

  @Delete(':id/members/:memberId') @HttpCode(204)
  async removeMember(@Param('id') id: string, @Param('memberId') memberId: string, @CurrentUser() u: AuthUser) {
    await this.svc.removeMember(id, u.id, memberId);
  }
}
