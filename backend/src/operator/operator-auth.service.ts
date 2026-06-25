import { Injectable, UnauthorizedException, Logger, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';

/**
 * Authentication for the operator panel. Intentionally a separate module
 * from the customer AuthService: different JWT secret, different refresh
 * tokens, different cookie scope. A bug in either can never cross the
 * boundary because the secrets don't know about each other.
 */
export interface OperatorTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface ReqMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class OperatorAuthService {
  private readonly log = new Logger(OperatorAuthService.name);
  private bootstrapRan = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
  ) {
    this.bootstrapIfEmpty().catch((e) =>
      this.log.warn(`Operator bootstrap skipped: ${e.message}`),
    );
  }

  /**
   * Seed a super-operator on a fresh install from env vars. Runs at most
   * once and only when NO operators exist — the guard makes it safe to keep
   * the env vars set after initial setup.
   */
  private async bootstrapIfEmpty() {
    if (this.bootstrapRan) return;
    this.bootstrapRan = true;
    const email = this.cfg.operatorBootstrapEmail;
    const password = this.cfg.operatorBootstrapPassword;
    if (!email || !password) return;
    const count = await this.prisma.operator.count();
    if (count > 0) return;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.prisma.operator.create({
      data: { email, passwordHash, isSuper: true, displayName: 'Bootstrap operator' },
    });
    this.log.log(`Bootstrap operator created: ${email}`);
  }

  private hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseTtlToMs(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) return 24 * 60 * 60 * 1000;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's': return n * 1000;
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
      default: return n * 1000;
    }
  }

  private async issueTokens(operatorId: string, email: string, meta: ReqMeta): Promise<OperatorTokens> {
    // The token carries `kind: 'operator'` so guards can reject customer
    // JWTs that happen to reach an operator route (different secrets make
    // this impossible, but belt-and-braces is cheap).
    const accessToken = await this.jwt.signAsync(
      { sub: operatorId, email, kind: 'operator' },
      { secret: this.cfg.operatorJwtSecret, expiresIn: this.cfg.operatorJwtTtl },
    );
    const refreshRaw = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.parseTtlToMs(this.cfg.operatorRefreshTtl));
    await this.prisma.operatorRefreshToken.create({
      data: {
        operatorId,
        tokenHash: this.hashRefresh(refreshRaw),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });
    return { accessToken, refreshToken: refreshRaw, refreshExpiresAt: expiresAt };
  }

  async login(email: string, password: string, meta: ReqMeta): Promise<OperatorTokens & { operator: { id: string; email: string; isSuper: boolean; displayName: string | null } }> {
    const op = await this.prisma.operator.findUnique({ where: { email } });
    // Same generic error regardless of cause — don't leak which field was wrong.
    if (!op) throw new UnauthorizedException('Invalid credentials');
    if (op.disabledAt) throw new ForbiddenException('Operator account disabled');
    // `.catch(() => false)` so a malformed/corrupt stored hash is treated as a
    // failed login (401) rather than throwing an unhandled 500.
    const ok = await argon2.verify(op.passwordHash, password).catch(() => false);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    await this.prisma.operator.update({
      where: { id: op.id },
      data: { lastLoginAt: new Date() },
    });
    const tokens = await this.issueTokens(op.id, op.email, meta);
    return {
      ...tokens,
      operator: { id: op.id, email: op.email, isSuper: op.isSuper, displayName: op.displayName },
    };
  }

  async refresh(refreshToken: string, meta: ReqMeta): Promise<OperatorTokens> {
    const hash = this.hashRefresh(refreshToken);
    const row = await this.prisma.operatorRefreshToken.findUnique({
      where: { tokenHash: hash },
      include: { operator: true },
    });
    if (!row || row.revokedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid');
    }
    if (row.operator.disabledAt) {
      throw new ForbiddenException('Operator account disabled');
    }
    // Rotate: revoke old, issue new. A stolen refresh token can be used at
    // most once; reuse returns 401 and the legitimate operator is bumped
    // the next time they open the app.
    await this.prisma.operatorRefreshToken.update({
      where: { id: row.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(row.operator.id, row.operator.email, meta);
  }

  async logout(refreshToken: string | undefined) {
    if (!refreshToken) return;
    await this.prisma.operatorRefreshToken
      .updateMany({
        where: { tokenHash: this.hashRefresh(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});
  }

  async me(operatorId: string) {
    const op = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      select: { id: true, email: true, displayName: true, isSuper: true, lastLoginAt: true, createdAt: true },
    });
    if (!op) throw new UnauthorizedException();
    return op;
  }
}
