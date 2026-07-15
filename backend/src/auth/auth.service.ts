import {
  ConflictException,
  ForbiddenException,
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
import { EmailVerificationService } from './email-verification.service';
import { LoginCooldownService } from './login-cooldown.service';
import { SignupDto, LoginDto, EnableTotpDto, DisableTotpDto, ChangePasswordDto } from './dto/auth.dto';

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
    private readonly emailVerification: EmailVerificationService,
    private readonly cooldown: LoginCooldownService,
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

  async signup(
    dto: SignupDto,
    meta: ReqMeta,
  ): Promise<
    | (AuthTokens & { userId: string })
    | { userId: string; needsVerification: true }
    | { userId: string; awaitingApproval: true }
  > {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    // Invite-gate: when REQUIRE_INVITE_CODE_ON_SIGNUP is on, the signup DTO
    // must carry a valid code. Consume atomically so parallel signups don't
    // both slip through a single-use code.
    if ((this.cfg as unknown as { requireInviteCode?: boolean }).requireInviteCode) {
      const code = dto.inviteCode?.trim().toUpperCase();
      if (!code) throw new BadRequestException('Invite code required');
      const row = await this.prisma.inviteCode.findUnique({ where: { code } });
      if (!row) throw new BadRequestException('Invite code not found');
      if (row.expiresAt && row.expiresAt < new Date()) throw new BadRequestException('Invite code expired');
      if (row.assignedEmail && row.assignedEmail.toLowerCase() !== dto.email.toLowerCase()) {
        throw new BadRequestException('Invite code does not match this email');
      }
      if (row.maxUses !== 0) {
        const claim = await this.prisma.inviteCode.updateMany({
          where: { code, usesRemaining: { gt: 0 } },
          data: { usesRemaining: { decrement: 1 } },
        });
        if (claim.count === 0) throw new BadRequestException('Invite code already used');
      }
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    // If this install requires verification, leave emailVerifiedAt null so
    // login is blocked until the user clicks the link. Otherwise auto-verify
    // (single-user self-host / dev).
    const needsVerify = this.cfg.requireEmailVerification;
    // First user on a fresh install is auto-approved so the install owner can
    // actually get in. Every subsequent signup lands at `pending` and waits
    // for approval from the operator portal — the manual approval gate stays.
    //
    // IMPORTANT: signup NEVER grants the global `isAdmin` flag. Instance admin
    // lives only in the separate operator portal. A customer's "admin of their
    // own account" = OWNER of their personal workspace (set in
    // ensurePersonalWorkspace below) and is fully isolated from other tenants.
    const existingCount = await this.prisma.user.count();
    const isFirst = existingCount === 0;
    // Approval gate is opt-in (REQUIRE_SIGNUP_APPROVAL). Off by default now that
    // billing gates usage — new users are approved immediately and prompted to
    // subscribe. The first-ever user is always approved so the instance isn't
    // locked out.
    const autoApprove = isFirst || !this.cfg.requireSignupApproval;
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        displayName: dto.displayName,
        emailVerifiedAt: needsVerify ? null : new Date(),
        isAdmin: false,
        approvalStatus: autoApprove ? 'approved' : 'pending',
        approvedAt: autoApprove ? new Date() : null,
      },
    });

    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);
    await this.audit.log({ userId: user.id, action: 'SIGNUP', ...meta });

    if (needsVerify) {
      // Fire the email. If it fails (SMTP down), we still return a pending
      // state so the client can show a "resend" button — the DB row exists.
      await this.emailVerification
        .issueAndSend(user.id, user.email)
        .catch(() => null);
      return { userId: user.id, needsVerification: true };
    }

    // Only when approval is explicitly required do signups wait for an
    // operator. Otherwise they fall through and get tokens immediately.
    if (!autoApprove) {
      return { userId: user.id, awaitingApproval: true };
    }

    const tokens = await this.issueTokens(user.id, user.email, meta);
    return { userId: user.id, ...tokens };
  }

  async login(dto: LoginDto, meta: ReqMeta): Promise<AuthTokens & { userId: string }> {
    // Check cooldown BEFORE argon2 — locked emails shouldn't consume CPU.
    await this.cooldown.assertNotLocked(dto.email);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { totpSecret: true },
    });
    const dummyHash = '$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$abcdefghijklmnopabcdefghijklmnopabcdefghijk';
    const valid = user && user.passwordHash
      ? await argon2.verify(user.passwordHash, dto.password).catch(() => false)
      : (await argon2.verify(dummyHash, dto.password).catch(() => false), false);

    if (!user || !valid) {
      await this.audit.log({ userId: user?.id, action: 'LOGIN_FAILED', ...meta });
      // Increment failure counter on the email, even for unknown accounts,
      // to deter enumeration + slow down credential stuffing.
      await this.cooldown.recordFailure(dto.email);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Suspended accounts can't log in, even with correct credentials. This
    // is the operator-panel-controlled block — see OperatorUsersController.
    if (user.suspendedAt) {
      await this.audit.log({ userId: user.id, action: 'LOGIN_SUSPENDED', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: user.suspendedReason
          ? `Account suspended: ${user.suspendedReason}`
          : 'Account suspended. Contact support to restore access.',
      });
    }

    // Approval gate. Self-signups land at `pending` and an operator
    // must approve them before they can log in. Typed code so the
    // login form can show "waiting for approval" / "rejected" copy.
    if (user.approvalStatus === 'pending') {
      await this.audit.log({ userId: user.id, action: 'LOGIN_PENDING', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_PENDING',
        message:
          'Your account is awaiting admin approval. You\'ll be able to sign in once it\'s reviewed.',
      });
    }
    if (user.approvalStatus === 'rejected') {
      await this.audit.log({ userId: user.id, action: 'LOGIN_REJECTED', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_REJECTED',
        message: user.approvalNote
          ? `Account not approved: ${user.approvalNote}`
          : 'Your account was not approved. Contact support if you think this was a mistake.',
      });
    }

    if (user.totpSecret?.enabled) {
      if (!dto.totpCode) throw new UnauthorizedException('TOTP code required');
      const secret = await this.crypto.decrypt(user.totpSecret.secretCt, `totp:${user.id}`);
      const ok = authenticator.check(dto.totpCode, secret);
      if (!ok) {
        await this.audit.log({ userId: user.id, action: 'LOGIN_FAILED', ...meta });
        throw new UnauthorizedException('Invalid TOTP code');
      }
    }

    // Block unverified users from logging in on installs that require
    // verification. Distinct error code so the UI can show a "resend" prompt.
    if (!this.emailVerification.isAllowedToLogin(user)) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Verify your email address to sign in.',
      });
    }

    // Back-compat: users that existed before workspaces shipped still need one.
    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);
    await this.cooldown.recordSuccess(dto.email);

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
    const ct = await this.crypto.encrypt(secret, `totp:${userId}`);
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
    const secret = await this.crypto.decrypt(rec.secretCt, `totp:${userId}`);
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
    if (!user.passwordHash) throw new BadRequestException('Account has no password (OAuth-only)');
    const ok = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!ok) throw new UnauthorizedException('Invalid password');
    const secret = await this.crypto.decrypt(user.totpSecret.secretCt, `totp:${userId}`);
    if (!authenticator.check(dto.code, secret)) {
      throw new UnauthorizedException('Invalid TOTP code');
    }
    await this.prisma.totpSecret.delete({ where: { userId } });
    await this.audit.log({ userId, action: 'TOTP_DISABLED', ...meta });
  }

  /**
   * Change the password of an already-authenticated user. Verifies the current
   * password first (so a hijacked access token can't silently rotate it), then
   * revokes all OTHER refresh tokens — the current session stays valid so the
   * user isn't logged out of the tab they're using, but anyone else holding an
   * old session is kicked.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    meta: ReqMeta,
    currentRefreshToken?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    if (!user.passwordHash) {
      throw new BadRequestException('This account signs in with a provider and has no password to change.');
    }
    const ok = await argon2.verify(user.passwordHash, dto.currentPassword).catch(() => false);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('New password must be different from the current one');
    }

    const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
    const currentHash = currentRefreshToken ? this.hashRefresh(currentRefreshToken) : null;

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      // Revoke every active session except the one making this request.
      this.prisma.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentHash ? { tokenHash: { not: currentHash } } : {}),
        },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.audit.log({ userId, action: 'PASSWORD_CHANGED', ...meta });
  }

  /** Issue a fresh session for an already-authenticated user (SSO callback
   *  path). The caller has already verified identity out-of-band. */
  async issueSessionForUser(
    userId: string,
    email: string,
    meta: ReqMeta,
  ): Promise<AuthTokens & { userId: string }> {
    await this.audit.log({ userId, action: 'LOGIN', ...meta });
    const tokens = await this.issueTokens(userId, email, meta);
    return { userId, ...tokens };
  }

  async loginOrCreateOAuth(
    profile: { provider: 'google' | 'github'; providerId: string; email: string; displayName?: string },
    meta: ReqMeta,
  ): Promise<AuthTokens & { userId: string }> {
    // Normalize email so OAuth resolves to the same account as a
    // case/whitespace variant signed up by password.
    if (profile.email) profile = { ...profile, email: profile.email.trim().toLowerCase() };

    // 1) Exact match on (provider, providerId).
    let user = await this.prisma.user.findFirst({
      where: { oauthProvider: profile.provider, oauthId: profile.providerId },
    });

    // 2) Fall back to email match — link this OAuth identity to the existing
    //    account. The OAuth provider has vouched for this email, so we also
    //    mark the account verified (legitimate sign-in via Google proves
    //    ownership of the mailbox).
    if (!user && profile.email) {
      user = await this.prisma.user.findUnique({ where: { email: profile.email } });
      if (user) {
        user = await this.prisma.user.update({
          where: { id: user.id },
          data: {
            oauthProvider: profile.provider,
            oauthId: profile.providerId,
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          },
        });
      }
    }

    // 3) Brand-new user — OAuth accounts are verified at creation.
    // Approval lifecycle: first user bootstraps the install (approved
    // immediately so they can use it). Subsequent OAuth signups go to
    // `pending` just like password signups; the OAuth flow above
    // bounces them back to the login page where the typed error code
    // ACCOUNT_PENDING gets surfaced.
    if (!user) {
      const existingCount = await this.prisma.user.count();
      const isFirst = existingCount === 0;
      const autoApprove = isFirst || !this.cfg.requireSignupApproval;
      user = await this.prisma.user.create({
        data: {
          email: profile.email,
          passwordHash: null,
          displayName: profile.displayName,
          oauthProvider: profile.provider,
          oauthId: profile.providerId,
          emailVerifiedAt: new Date(),
          // Never grant global isAdmin at signup — instance admin lives only
          // in the separate operator portal. See password-signup note above.
          isAdmin: false,
          approvalStatus: autoApprove ? 'approved' : 'pending',
          approvedAt: autoApprove ? new Date() : null,
        },
      });
      await this.audit.log({ userId: user.id, action: 'SIGNUP', ...meta });
    }

    // Gate the OAuth login the same way the password login is gated.
    // Suspended/pending/rejected accounts cannot ride OAuth past the
    // approval check.
    if (user.suspendedAt) {
      await this.audit.log({ userId: user.id, action: 'LOGIN_SUSPENDED', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: user.suspendedReason
          ? `Account suspended: ${user.suspendedReason}`
          : 'Account suspended. Contact support to restore access.',
      });
    }
    if (user.approvalStatus === 'pending') {
      await this.audit.log({ userId: user.id, action: 'LOGIN_PENDING', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_PENDING',
        message:
          'Your account is awaiting admin approval. You\'ll be able to sign in once it\'s reviewed.',
      });
    }
    if (user.approvalStatus === 'rejected') {
      await this.audit.log({ userId: user.id, action: 'LOGIN_REJECTED', ...meta });
      throw new ForbiddenException({
        code: 'ACCOUNT_REJECTED',
        message: user.approvalNote
          ? `Account not approved: ${user.approvalNote}`
          : 'Your account was not approved. Contact support if you think this was a mistake.',
      });
    }

    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);
    await this.audit.log({ userId: user.id, action: 'LOGIN', ...meta });
    const tokens = await this.issueTokens(user.id, user.email, meta);
    return { userId: user.id, ...tokens };
  }
}
