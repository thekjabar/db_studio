import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AgentsService } from './agents.service';
import { CurrentUser, AuthUser } from '../auth/decorators/current-user.decorator';

class CreateAgentDto {
  @IsString() @Length(1, 80) name!: string;
}

/**
 * Workspace-scoped agent management. OWNER-only mutations. The pairing token is
 * returned exactly once on create — the operator copies it into the agent's
 * config and it's never retrievable again.
 */
@Controller('workspaces/:wsId/agents')
export class AgentsController {
  constructor(private readonly svc: AgentsService) {}

  @Get()
  async list(@Param('wsId') wsId: string, @CurrentUser() u: AuthUser) {
    await this.svc.assertOwner(wsId, u.id);
    return this.svc.list(wsId);
  }

  @Post()
  @HttpCode(201)
  async create(@Param('wsId') wsId: string, @Body() dto: CreateAgentDto, @CurrentUser() u: AuthUser) {
    await this.svc.assertOwner(wsId, u.id);
    return this.svc.create(wsId, dto.name);
  }

  @Post(':agentId/revoke')
  @HttpCode(200)
  async revoke(@Param('wsId') wsId: string, @Param('agentId') agentId: string, @CurrentUser() u: AuthUser) {
    await this.svc.assertOwner(wsId, u.id);
    return this.svc.revoke(wsId, agentId);
  }

  @Delete(':agentId')
  @HttpCode(204)
  async remove(@Param('wsId') wsId: string, @Param('agentId') agentId: string, @CurrentUser() u: AuthUser) {
    await this.svc.assertOwner(wsId, u.id);
    await this.svc.remove(wsId, agentId);
  }
}
