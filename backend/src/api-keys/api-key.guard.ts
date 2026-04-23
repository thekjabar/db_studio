import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { ApiKeysService } from './api-keys.service';

/**
 * Alternative auth for programmatic clients. Accepts `Authorization: Bearer
 * dbs_live_…` and attaches `req.user` + `req.apiKey` so downstream guards
 * (RbacGuard etc.) work the same way as for JWT-authenticated requests.
 *
 * Falls through (returns true/attach-nothing isn't right — we want a hard
 * 401 if an API-key path is hit without a valid token) — so this guard is
 * only attached to the dedicated /v1/* routes.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match) throw new UnauthorizedException('Missing bearer token');
    const resolved = await this.apiKeys.resolveToken(match[1]);
    if (!resolved) throw new UnauthorizedException('Invalid API key');
    // Shape compatible with CurrentUser decorator.
    (req as unknown as { user: { id: string } }).user = { id: resolved.userId };
    (req as unknown as { apiKey: typeof resolved }).apiKey = resolved;
    return true;
  }
}
