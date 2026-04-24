import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { AiChatService } from './ai-chat.service';

class SendMessageDto {
  @IsOptional() @IsString() chatId?: string;
  @IsString() connectionId!: string;
  @IsString() @Length(1, 4000) content!: string;
}

@Controller('ai/chats')
@UseGuards(JwtAuthGuard)
export class AiChatController {
  constructor(private readonly svc: AiChatService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('connectionId') connectionId: string) {
    return this.svc.list(user.id, connectionId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }

  @Post('messages')
  @HttpCode(200)
  send(@CurrentUser() user: AuthUser, @Body() dto: SendMessageDto) {
    return this.svc.sendMessage(user.id, dto);
  }
}
