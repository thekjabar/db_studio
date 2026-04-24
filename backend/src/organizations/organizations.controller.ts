import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { OrganizationsService } from './organizations.service';

class CreateOrgDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(1, 40) slug!: string;
  @IsOptional() @IsEmail() billingEmail?: string;
}

class UpdateOrgDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() billingEmail?: string | null;
  @IsOptional() @IsBoolean() enforceSso?: boolean;
  @IsOptional() @IsInt() @Min(1) seatLimit?: number | null;
}

class AddMemberDto {
  @IsEmail() email!: string;
  @IsEnum(Role) role!: Role;
}

class AttachWorkspaceDto {
  @IsString() workspaceId!: string;
}

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly svc: OrganizationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrgDto) {
    return this.svc.create(user.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateOrgDto,
  ) {
    return this.svc.update(user.id, id, dto);
  }

  @Post(':id/members')
  @HttpCode(200)
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.svc.addMember(user.id, id, dto);
  }

  @Delete(':id/members/:memberUserId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('memberUserId') memberUserId: string,
  ) {
    return this.svc.removeMember(user.id, id, memberUserId);
  }

  @Post(':id/workspaces')
  @HttpCode(200)
  attachWorkspace(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AttachWorkspaceDto,
  ) {
    return this.svc.attachWorkspace(user.id, id, dto.workspaceId);
  }

  @Delete(':id/workspaces/:workspaceId')
  detachWorkspace(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.svc.detachWorkspace(user.id, id, workspaceId);
  }
}
