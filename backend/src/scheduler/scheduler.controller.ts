import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { SchedulerService } from './scheduler.service';
import type { AlertCondition, AlertOp } from './alert-evaluator';

const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;
const ALERT_OPS: AlertOp[] = [
  'gt', 'gte', 'lt', 'lte', 'eq', 'neq',
  'rows_gt', 'rows_gte', 'rows_lt', 'rows_eq',
];

/** Narrow an untyped JSON body into an AlertCondition, or null. */
function narrowAlertCondition(v: unknown): AlertCondition | null {
  if (v == null) return null;
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.op !== 'string' || !ALERT_OPS.includes(o.op as AlertOp)) return null;
  if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
  const cond: AlertCondition = { op: o.op as AlertOp, value: o.value };
  if (typeof o.column === 'string' && o.column.length > 0) cond.column = o.column;
  return cond;
}

export class CreateScheduleDto {
  @IsString() @Length(1, 200) connectionId!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsString() @Matches(CRON_RE) cron!: string;
  @IsOptional() @IsString() @Length(0, 64) timezone?: string;
  @IsString() @Length(1, 100_000) sqlText!: string;
  @IsArray() @ArrayNotEmpty() @IsEmail({}, { each: true }) emailTo!: string[];
  @IsOptional() @IsString() @Length(0, 500) slackWebhook?: string;
  // Validated in full via narrowAlertCondition inside the controller method;
  // class-validator only gets us shape-presence here because the nested
  // union `op` string is a pain to express with decorators.
  @IsOptional() @IsObject() alertCondition?: Record<string, unknown>;
  @IsOptional() @IsInt() @Min(1) @Max(1440) alertCooldownMin?: number;
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
  @IsOptional() slackWebhook?: string | null;
  @IsOptional() alertCondition?: Record<string, unknown> | null;
  @IsOptional() @IsNumber() alertCooldownMin?: number | null;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsIn(['noop']) _validator?: 'noop';
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
    return this.svc.create(u.id, {
      ...dto,
      alertCondition: dto.alertCondition ? narrowAlertCondition(dto.alertCondition) : null,
    });
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(u.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateScheduleDto) {
    const { alertCondition: raw, ...rest } = dto;
    const alertCondition =
      raw === undefined ? undefined : raw ? narrowAlertCondition(raw) : null;
    return this.svc.update(u.id, id, { ...rest, ...(alertCondition === undefined ? {} : { alertCondition }) });
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
