import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { SignupDto, LoginDto, EnableTotpDto, DisableTotpDto } from './dto/auth.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

interface ReqMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly cfg: AppConfigService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private hashRefresh(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseTtlToMs(ttl: string): number {
    const m = ttl.match(/^(\d+)([smhd])$/);
    if (!m) return 7 * 24 * 60 * 60 * 1000;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's': return n * 1000;
      case 'm': return n * 60 * 1000;
      case 'h': return n * 60 * 60 * 1000;
      case 'd': return n * 24 * 60 * 60 * 1000;
      default: return n * 1000;
    }
  }

  private async issueTokens(userId: string, email: string, meta: ReqMeta): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      { secret: this.cfg.jwtAccessSecret, expiresIn: this.cfg.jwtAccessTtl },
    );
    const refreshRaw = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.parseTtlToMs(this.cfg.jwtRefreshTtl));
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashRefresh(refreshRaw),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });
    return { accessToken, refreshToken: refreshRaw, refreshExpiresAt: expiresAt };
  }

  async signup(dto: SignupDto, meta: ReqMeta): Promise<AuthTokens & { userId: string }> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash, displayName: dto.displayName },
    });

    // Every user gets a Personal workspace on signup.
    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);

    await this.audit.log({ userId: user.id, action: 'SIGNUP', ...meta });

    const tokens = await this.issueTokens(user.id, user.email, meta);
    return { userId: user.id, ...tokens };
  }

  async login(dto: LoginDto, meta: ReqMeta): Promise<AuthTokens & { userId: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { totpSecret: true },
    });
    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$abcdefghijklmnopabcdefghijklmnopabcdefghijk';
    const valid = user
      ? await argon2.verify(user.passwordHash, dto.password).catch(() => false)
      : (await argon2.verify(dummyHash, dto.password).catch(() => false), false);

    if (!user || !valid) {
      await this.audit.log({ userId: user?.id, action: 'LOGIN_FAILED', ...meta });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.totpSecret?.enabled) {
      if (!dto.totpCode) throw new UnauthorizedException('TOTP code required');
      const secret = this.crypto.decrypt(user.totpSecret.secretCt, `totp:${user.id}`);
      const ok = authenticator.check(dto.totpCode, secret);
      if (!ok) {
        await this.audit.log({ userId: user.id, action: 'LOGIN_FAILED', ...meta });
        throw new UnauthorizedException('Invalid TOTP code');
      }
    }

    // Back-compat: users that existed before workspaces shipped still need one.
    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);

    await this.audit.log({ userId: user.id, action: 'LOGIN', ...meta });
    const tokens = await this.issueTokens(user.id, user.email, meta);
    return { userId: user.id, ...tokens };
  }

  async refresh(rawToken: string, meta: ReqMeta): Promise<AuthTokens> {
    if (!rawToken) throw new UnauthorizedException('No refresh token');
    const hash = this.hashRefresh(rawToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user) throw new UnauthorizedException('User missing');

    // Rotate.
    const next = await this.issueTokens(user.id, user.email, meta);
    const newRec = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashRefresh(next.refreshToken) },
      select: { id: true },
    });
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedById: newRec?.id ?? null },
    });
    return next;
  }

  async logout(rawToken: string | undefined, userId: string, meta: ReqMeta): Promise<void> {
    if (rawToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hashRefresh(rawToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.log({ userId, action: 'LOGOUT', ...meta });
  }

  async startTotpEnrollment(userId: string): Promise<{ otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, this.cfg.totpIssuer, secret);
    const ct = this.crypto.encrypt(secret, `totp:${userId}`);
    await this.prisma.totpSecret.upsert({
      where: { userId },
      create: { userId, secretCt: ct, enabled: false },
      update: { secretCt: ct, enabled: false },
    });
    const qr = await QRCode.toDataURL(otpauth);
    return { otpauthUrl: otpauth, qrDataUrl: qr };
  }

  async confirmTotp(userId: string, dto: EnableTotpDto, meta: ReqMeta): Promise<void> {
    const rec = await this.prisma.totpSecret.findUnique({ where: { userId } });
    if (!rec) throw new BadRequestException('No pending TOTP enrollment');
    const secret = this.crypto.decrypt(rec.secretCt, `totp:${userId}`);
    if (!authenticator.check(dto.code, secret)) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.prisma.totpSecret.update({ where: { userId }, data: { enabled: true } });
    await this.audit.log({ userId, action: 'TOTP_ENABLED', ...meta });
  }

  async disableTotp(userId: string, dto: DisableTotpDto, meta: ReqMeta): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { totpSecret: true },
    });
    if (!user || !user.totpSecret?.enabled) throw new BadRequestException('TOTP not enabled');
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) throw new UnauthorizedException('Invalid password');
    const secret = this.crypto.decrypt(user.totpSecret.secretCt, `totp:${userId}`);
    if (!authenticator.check(dto.code, secret)) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.prisma.totpSecret.delete({ where: { userId } });
    await this.audit.log({ userId, action: 'TOTP_DISABLED', ...meta });
  }
}
