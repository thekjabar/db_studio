import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { RbacService } from './rbac.service';
import { REQUIRE_ROLE_KEY, RoleName } from './rbac.decorator';

@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private reflector: Reflector, private rbac: RbacService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<RoleName>(REQUIRE_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]) ?? 'VIEWER';

    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { id: string } | undefined;
    if (!user) return false;
    const id = req.params?.id ?? req.params?.connectionId;
    if (!id) return false;

    const role = await this.rbac.require(user.id, id, Role[required]);
    req.connectionRole = role;
    return true;
  }
}
