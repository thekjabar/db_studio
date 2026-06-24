import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { FeedbackService } from './feedback.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { OperatorGuard, OperatorRequest } from '../operator/operator.guard';
import { FeedbackCategory, FeedbackStatus } from '@prisma/client';

const CATEGORIES: FeedbackCategory[] = ['BUG', 'FEATURE', 'QUESTION', 'OTHER'];
const STATUSES: FeedbackStatus[] = ['NEW', 'TRIAGED', 'ANSWERED', 'CLOSED'];

class SubmitFeedbackDto {
  @IsString() @Length(1, 2000) message!: string;
  @IsIn(CATEGORIES) category!: FeedbackCategory;
  @IsOptional() @IsString() @Length(0, 1000) sourcePath?: string;
  /// Used when a logged-out visitor submits (e.g. public dashboard). Ignored
  /// for authenticated requests — we take the email from their account.
  @IsOptional() @IsEmail() email?: string;
}

/**
 * Customer-facing submit endpoint. Accepts logged-in (via JwtAuthGuard
 * that runs globally) and logged-out submissions — @Public lets
 * anonymous hits through; if the user happens to be logged in the
 * controller still sees their `req.user`.
 */
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly svc: FeedbackService) {}

  @Public()
  @Post()
  @HttpCode(201)
  async submit(@Body() dto: SubmitFeedbackDto, @Req() req: Request) {
    const user = (req as Request & { user?: AuthUser }).user;
    return this.svc.submit({
      userId: user?.id ?? null,
      email: user?.email ?? dto.email ?? null,
      category: dto.category,
      message: dto.message,
      sourcePath: dto.sourcePath ?? null,
    });
  }

  // A logged-in user's recent submissions (so they see them in their
  // profile). Not strictly needed v1 but cheap to add.
  @UseGuards(JwtAuthGuard)
  @Get('mine')
  async mine(@CurrentUser() user: AuthUser) {
    const { rows } = await this.svc.list({ limit: 20, offset: 0 });
    return rows.filter((r) => r.userId === user.id);
  }
}

class ReplyDto {
  @IsString() @Length(1, 5000) body!: string;
}
class NoteDto {
  @IsString() @Length(0, 5000) internalNotes!: string;
}
class StatusDto {
  @IsIn(STATUSES) status!: FeedbackStatus;
}

@Public()
@UseGuards(OperatorGuard)
@Controller('operator/feedback')
export class OperatorFeedbackController {
  constructor(private readonly svc: FeedbackService) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('limit') limitRaw = '50',
    @Query('offset') offsetRaw = '0',
  ) {
    const limit = Math.min(parseInt(limitRaw, 10) || 50, 200);
    const offset = Math.max(parseInt(offsetRaw, 10) || 0, 0);
    const statusEnum = STATUSES.includes(status as FeedbackStatus)
      ? (status as FeedbackStatus)
      : undefined;
    return this.svc.list({ status: statusEnum, limit, offset });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Patch(':id/status')
  status(@Param('id') id: string, @Body() dto: StatusDto) {
    return this.svc.setStatus(id, dto.status);
  }

  @Patch(':id/note')
  note(@Param('id') id: string, @Body() dto: NoteDto) {
    return this.svc.setNote(id, dto.internalNotes);
  }

  @Post(':id/reply')
  @HttpCode(200)
  reply(@Param('id') id: string, @Body() dto: ReplyDto, @Req() req: OperatorRequest) {
    return this.svc.reply(id, req.operator!.id, dto.body);
  }
}
