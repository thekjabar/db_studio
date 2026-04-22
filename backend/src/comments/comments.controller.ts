import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { CommentsService } from './comments.service';
import { RbacGuard } from '../rbac/rbac.guard';
import { RequireRole } from '../rbac/rbac.decorator';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class CreateCommentDto {
  @IsString() @Length(1, 500) target!: string;
  @IsString() @Length(1, 5_000) body!: string;
}
class UpdateCommentDto {
  @IsString() @Length(1, 5_000) body!: string;
}

@Controller('connections/:id/comments')
@UseGuards(RbacGuard)
export class CommentsController {
  constructor(private readonly svc: CommentsService) {}

  @Get() @RequireRole('VIEWER')
  list(@Param('id') id: string, @Query('target') target?: string) {
    return this.svc.list(id, target);
  }

  @Get('counts') @RequireRole('VIEWER')
  counts(@Param('id') id: string) {
    return this.svc.counts(id);
  }

  @Post() @RequireRole('EDITOR')
  create(@Param('id') id: string, @Body() dto: CreateCommentDto, @CurrentUser() u: AuthUser) {
    return this.svc.create(id, u.id, dto.target, dto.body);
  }

  @Patch(':commentId') @RequireRole('EDITOR')
  update(@Param('commentId') cid: string, @Body() dto: UpdateCommentDto, @CurrentUser() u: AuthUser) {
    return this.svc.update(u.id, cid, dto.body);
  }

  @Delete(':commentId') @RequireRole('EDITOR') @HttpCode(204)
  async remove(@Param('commentId') cid: string, @CurrentUser() u: AuthUser) {
    await this.svc.remove(u.id, cid);
  }
}
