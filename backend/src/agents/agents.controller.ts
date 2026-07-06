import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AgentsService } from './agents.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class CreateAgentDto {
  @IsString() @Length(1, 80) name!: string;
}

@Controller('agents')
export class AgentsController {
  constructor(private readonly svc: AgentsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.id);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: CreateAgentDto) {
    return this.svc.create(u.id, dto.name);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.get(id, u.id);
  }

  @Post(':id/pairing-token')
  pairingToken(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.createPairingToken(id, u.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() u: AuthUser) {
    return this.svc.remove(id, u.id);
  }
}
