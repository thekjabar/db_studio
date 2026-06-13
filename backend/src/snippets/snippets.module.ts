import { Module } from '@nestjs/common';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, type AuthUser } from '../auth/decorators/current-user.decorator';

class CreateSnippetDto {
  @IsString() @Length(1, 100) name!: string;
  @IsString() @Length(1, 50_000) sqlText!: string;
  @IsOptional() @IsString() connectionId?: string;
}
class UpdateSnippetDto {
  @IsOptional() @IsString() @Length(1, 100) name?: string;
  @IsOptional() @IsString() @Length(1, 50_000) sqlText?: string;
}

/** Per-user reusable SQL snippets, surfaced in the SQL editor. */
@Injectable()
class SnippetsService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, connectionId?: string) {
    // Global snippets + ones scoped to this connection.
    return this.prisma.snippet.findMany({
      where: {
        userId,
        ...(connectionId ? { OR: [{ connectionId: null }, { connectionId }] } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }

  create(userId: string, dto: CreateSnippetDto) {
    return this.prisma.snippet.create({
      data: { userId, name: dto.name, sqlText: dto.sqlText, connectionId: dto.connectionId ?? null },
    });
  }

  async update(userId: string, id: string, dto: UpdateSnippetDto) {
    const row = await this.prisma.snippet.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    if (row.userId !== userId) throw new ForbiddenException();
    return this.prisma.snippet.update({ where: { id }, data: { ...dto } });
  }

  async remove(userId: string, id: string) {
    const row = await this.prisma.snippet.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    if (row.userId !== userId) throw new ForbiddenException();
    await this.prisma.snippet.delete({ where: { id } });
  }
}

@Controller('snippets')
@UseGuards(JwtAuthGuard)
class SnippetsController {
  constructor(private readonly svc: SnippetsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser, @Query('connectionId') connectionId?: string) {
    return this.svc.list(u.id, connectionId || undefined);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateSnippetDto) {
    return this.svc.create(u.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateSnippetDto) {
    return this.svc.update(u.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.remove(u.id, id);
  }
}

@Module({
  controllers: [SnippetsController],
  providers: [SnippetsService],
})
export class SnippetsModule {}
