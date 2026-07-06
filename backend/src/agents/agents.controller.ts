import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AgentsService } from './agents.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class CreateAgentDto {
  @IsString() @Length(1, 80) name!: string;
}

class AuthorizeAgentDto {
  @IsString() @Length(1, 120) name!: string;
  // CSRF nonce the agent generated; echoed back unchanged so the agent can match it.
  @IsString() @Length(1, 200) state!: string;
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

  /** Browser auto-pair: the /agent/authorize page calls this on "Allow". */
  @Post('authorize')
  authorize(@CurrentUser() u: AuthUser, @Body() dto: AuthorizeAgentDto) {
    return this.svc.authorize(u.id, dto.name, dto.state);
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
