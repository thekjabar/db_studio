import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';
import { NotebooksService } from './notebooks.service';

class CreateNotebookDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsString() connectionId!: string;
}

class NotebookCellDto {
  @IsString() @Length(1, 40) id!: string;
  @IsIn(['md', 'sql']) kind!: 'md' | 'sql';
  @IsString() @Length(0, 100_000) source!: string;
  @IsOptional() @IsString() @Length(0, 200) title?: string;
}

class UpdateNotebookDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string | null;
  @IsOptional() @IsArray() cells?: NotebookCellDto[];
}

@Controller('notebooks')
@UseGuards(JwtAuthGuard)
export class NotebooksController {
  constructor(private readonly svc: NotebooksService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('connectionId') connectionId?: string) {
    return this.svc.list(user.id, connectionId || undefined);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.get(user.id, id);
  }

  @Post()
  @HttpCode(201)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateNotebookDto) {
    return this.svc.create(user.id, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateNotebookDto,
  ) {
    return this.svc.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.remove(user.id, id);
  }
}
