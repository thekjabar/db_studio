import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsISO8601, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AnnouncementsService } from './announcements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { Public } from '../auth/decorators/public.decorator';
import { AnnouncementSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const SEVERITIES: AnnouncementSeverity[] = ['INFO', 'WARNING', 'CRITICAL'];

class TargetingDto {
  @IsOptional() @IsArray() @IsString({ each: true }) workspaceIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) userIds?: string[];
}

class CreateAnnouncementDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 5000) body!: string;
  @IsIn(SEVERITIES) severity!: AnnouncementSeverity;
  @IsOptional() @ValidateNested() @Type(() => TargetingDto) targeting?: TargetingDto;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
}

class UpdateAnnouncementDto {
  @IsOptional() @IsString() @Length(1, 200) title?: string;
  @IsOptional() @IsString() @Length(1, 5000) body?: string;
  @IsOptional() @IsIn(SEVERITIES) severity?: AnnouncementSeverity;
  @IsOptional() @ValidateNested() @Type(() => TargetingDto) targeting?: TargetingDto;
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;
}

// Customer-side: fetch announcements to display + mark seen/dismiss.
@UseGuards(JwtAuthGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(
    private readonly svc: AnnouncementsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('active')
  async active(@CurrentUser() user: AuthUser) {
    // Pull the user's workspace IDs so workspace-scoped targeting can apply.
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id },
      select: { workspaceId: true },
    });
    const owned = await this.prisma.workspace.findMany({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const ids = [...memberships.map((m) => m.workspaceId), ...owned.map((w) => w.id)];
    return this.svc.activeFor(user.id, ids);
  }

  @Post(':id/seen')
  @HttpCode(200)
  seen(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.markSeen(user.id, id);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.dismiss(user.id, id);
  }
}

// Operator-side.
@Public()
@UseGuards(OperatorGuard)
@Controller('operator/announcements')
export class OperatorAnnouncementsController {
  constructor(private readonly svc: AnnouncementsService) {}

  @Get()
  list(@Query('limit') limitRaw = '50', @Query('offset') offsetRaw = '0') {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    return this.svc.listOperator(limit, offset);
  }

  @Post()
  create(@Body() dto: CreateAnnouncementDto, @Req() req: OperatorRequest) {
    return this.svc.createOperator({
      operatorId: req.operator!.id,
      title: dto.title,
      body: dto.body,
      severity: dto.severity,
      targeting: dto.targeting ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : new Date(),
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.svc.updateOperator(id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
      ...(dto.targeting !== undefined ? { targeting: dto.targeting } : {}),
      ...(dto.startsAt !== undefined ? { startsAt: new Date(dto.startsAt) } : {}),
      ...(dto.endsAt !== undefined ? { endsAt: dto.endsAt ? new Date(dto.endsAt) : null } : {}),
    });
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.removeOperator(id);
  }
}
