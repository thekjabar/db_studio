import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { EmailService } from '../scheduler/email.service';
import { renderEmail } from '../scheduler/email-layout';

// Password reset tokens are shorter-lived than email verification — one hour
// matches industry norms (Stripe, GitHub, etc.). Long enough to cover the
// "I'll grab my phone" delay, short enough to limit the window for abuse if
// an email account is compromised.
const TTL_MS = 60 * 60_000;
const MIN_PASSWORD_LEN = 8;

function sha(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

@Injectable()
export class PasswordResetService {
  private readonly log = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly email: EmailService,
  ) {}

  /** Request a reset. Always returns 200 regardless of whether the email
   *  exists — prevents enumeration attacks that probe valid accounts. */
  async requestReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    // OAuth-only users don't have a password to reset; guide them elsewhere.
    if (!user.passwordHash) {
      this.log.log(`reset requested for OAuth-only account ${email} — ignoring`);
      return;
    }

    // Invalidate outstanding reset tokens so a previously-leaked link can't
    // be used after the owner has requested a fresh one.
    await this.prisma.passwordReset.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const raw = randomBytes(32).toString('base64url');
    await this.prisma.passwordReset.create({
      data: {
        userId: user.id,
        tokenSha: sha(raw),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    const link = `${this.cfg.appBaseUrl}/auth/reset?token=${encodeURIComponent(raw)}`;
    if (this.email.enabled) {
      try {
        await this.email.send({
          to: [email],
          subject: 'Reset your Query Schema password',
          body:
            `Click the link below to reset your password. The link expires in ` +
            `1 hour and can only be used once.\n\n${link}\n\n` +
            `If you didn't request this, you can safely ignore the email.`,
          html: renderEmail({
            title: 'Reset your password',
            intro:
              "We got a request to reset your Query Schema password. Click the button below to choose a new one. This link expires in 1 hour and can only be used once.",
            button: { label: 'Reset password', url: link },
            note: "If you didn't request this, you can safely ignore this email — your password won't change.",
          }),
        });
      } catch (err) {
        this.log.warn(`reset email failed: ${(err as Error).message}`);
        // Still return 200 — the row is in the DB; retry is possible later.
      }
    } else {
      this.log.log(`[dev] reset link for ${email}: ${link}`);
    }
  }

  /** Consume a reset token and rotate the password. Also revokes all
   *  existing refresh tokens so active sessions are kicked — the user who
   *  forgot their password can't be sure no one else is logged in. */
  async completeReset(rawToken: string, newPassword: string): Promise<void> {
    if (!rawToken) throw new BadRequestException('Missing token');
    if (!newPassword || newPassword.length < MIN_PASSWORD_LEN) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
    }
    const row = await this.prisma.passwordReset.findUnique({
      where: { tokenSha: sha(rawToken) },
    });
    if (!row) throw new NotFoundException('Invalid or expired reset link');
    if (row.consumedAt) throw new BadRequestException('This link has already been used');
    if (row.expiresAt < new Date()) throw new BadRequestException('This link has expired');

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });

    await this.prisma.$transaction([
      this.prisma.passwordReset.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { passwordHash },
      }),
      // Blow away active sessions — if the user genuinely forgot, we can't
      // know someone else isn't currently logged in as them.
      this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }
}
