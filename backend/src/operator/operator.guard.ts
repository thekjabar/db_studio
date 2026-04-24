import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/**
 * Gate for every /api/operator/* route. Verifies:
 *   1. Authorization header or operator_access cookie present
 *   2. JWT signs with OPERATOR_JWT_SECRET (customer JWTs fail here)
 *   3. Payload has kind=operator (defense-in-depth check)
 *   4. Operator row still exists and is not disabled
 *
 * Attaches `req.operator = { id, email, isSuper }` for downstream handlers.
 */
export interface OperatorRequest extends Request {
  operator?: { id: string; email: string; isSuper: boolean };
}

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<OperatorRequest>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedException('Operator token required');
    let payload: { sub: string; email: string; kind?: string };
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.cfg.operatorJwtSecret });
    } catch {
      throw new UnauthorizedException('Operator token invalid');
    }
    if (payload.kind !== 'operator') {
      throw new UnauthorizedException('Not an operator token');
    }
    const op = await this.prisma.operator.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, isSuper: true, disabledAt: true },
    });
    if (!op) throw new UnauthorizedException('Operator not found');
    if (op.disabledAt) throw new ForbiddenException('Operator disabled');
    req.operator = { id: op.id, email: op.email, isSuper: op.isSuper };
    return true;
  }

  private extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    // Fallback to cookie so the admin SPA can use httpOnly sessions.
    const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.operator_access;
    return cookie ?? null;
  }
}

/**
 * Extra guard for super-operator actions (create/disable other operators,
 * change billing prices, delete users, run destructive ops). Use alongside
 * OperatorGuard: `@UseGuards(OperatorGuard, SuperOperatorGuard)`.
 */
@Injectable()
export class SuperOperatorGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<OperatorRequest>();
    if (!req.operator?.isSuper) {
      throw new ForbiddenException('Super operator only');
    }
    return true;
  }
}
