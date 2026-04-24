import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { ReviewStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { QueryReviewService } from './query-review.service';

class SubmitDto {
  @IsString() @Length(1, 100_000) sqlText!: string;
  @IsOptional() @IsString() @Length(0, 1000) reason?: string;
}

class ReviewActionDto {
  @IsOptional() @IsString() @Length(0, 1000) comment?: string;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class QueryReviewController {
  constructor(private readonly svc: QueryReviewService) {}

  // Connection-scoped listing + submission.
  @Post('connections/:id/review-requests')
  @HttpCode(201)
  submit(
    @Param('id') connectionId: string,
    @Body() dto: SubmitDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.submit(user.id, connectionId, dto.sqlText, dto.reason);
  }

  @Get('connections/:id/review-requests')
  list(
    @Param('id') connectionId: string,
    @Query('status') status: ReviewStatus | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.list(user.id, connectionId, status);
  }

  // User-scoped: requests the current user can review.
  @Get('review-requests/inbox')
  inbox(@CurrentUser() user: AuthUser) {
    return this.svc.pendingMine(user.id);
  }

  @Post('review-requests/:id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: ReviewActionDto, @CurrentUser() user: AuthUser) {
    return this.svc.approve(user.id, id, dto.comment);
  }

  @Post('review-requests/:id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: ReviewActionDto, @CurrentUser() user: AuthUser) {
    return this.svc.reject(user.id, id, dto.comment);
  }

  // Kept for the class-validator unused-warning quiet.
  _unused(status?: ReviewStatus) {
    void status;
  }
}

// Silence class-validator tree-shake warning on enum import.
void IsEnum;
