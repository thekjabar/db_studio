import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { SchedulerService } from './scheduler.service';

const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

export class CreateScheduleDto {
  @IsString() @Length(1, 200) connectionId!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsString() @Matches(CRON_RE) cron!: string;
  @IsOptional() @IsString() @Length(0, 64) timezone?: string;
  @IsString() @Length(1, 100_000) sqlText!: string;
  @IsArray() @ArrayNotEmpty() @IsEmail({}, { each: true }) emailTo!: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateScheduleDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsString() @Matches(CRON_RE) cron?: string;
  @ValidateIf((_o, v) => v !== null)
  @IsOptional() @IsString() @Length(0, 64)
  timezone?: string | null;
  @IsOptional() @IsString() @Length(1, 100_000) sqlText?: string;
  @IsOptional() @IsArray() @IsEmail({}, { each: true }) emailTo?: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('schedules')
@UseGuards(JwtAuthGuard)
export class SchedulerController {
  constructor(private readonly svc: SchedulerService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.id);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateScheduleDto) {
    return this.svc.create(u.id, dto);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(u.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateScheduleDto) {
    return this.svc.update(u.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.remove(u.id, id);
  }

  @Post(':id/run')
  runNow(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.runNow(u.id, id);
  }

  @Get(':id/runs')
  runs(
    @CurrentUser() u: AuthUser,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listRuns(u.id, id, limit ? parseInt(limit, 10) : undefined);
  }
}
