import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { Public } from '../auth/decorators/public.decorator';
import { FeatureFlagsService } from './feature-flags.service';
import { PrismaService } from '../prisma/prisma.service';

class UpsertFlagDto {
  @IsString() @Length(1, 128) key!: string;
  @IsOptional() @IsString() description?: string;
  @IsInt() @Min(0) @Max(100) rolloutPercent!: number;
  @IsOptional() @IsArray() @IsString({ each: true }) enabledUserIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) enabledWorkspaceIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disabledUserIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) disabledWorkspaceIds?: string[];
}

@UseGuards(JwtAuthGuard)
@Controller('flags')
export class FlagsController {
  constructor(
    private readonly svc: FeatureFlagsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('my')
  async my(@CurrentUser() user: AuthUser) {
    const [members, owned] = await Promise.all([
      this.prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } }),
      this.prisma.workspace.findMany({ where: { ownerId: user.id }, select: { id: true } }),
    ]);
    const workspaceIds = [...members.map((m) => m.workspaceId), ...owned.map((w) => w.id)];
    return this.svc.evaluateForUser(user.id, workspaceIds);
  }
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/flags')
export class OperatorFlagsController {
  constructor(private readonly svc: FeatureFlagsService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  upsert(@Body() dto: UpsertFlagDto, @Req() req: OperatorRequest) {
    return this.svc.upsert(req.operator!.id, dto);
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.svc.remove(key);
  }
}
