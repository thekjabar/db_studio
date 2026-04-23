import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { Density, Theme } from '@prisma/client';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  displayName?: string;

  @IsOptional()
  @IsEnum(Density)
  density?: Density;

  @IsOptional()
  @IsEnum(Theme)
  theme?: Theme;
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.users.me(u.id);
  }

  @Patch('me')
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(u.id, dto);
  }
}
