import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/config.service';
import { EmailService } from '../scheduler/email.service';

// Tokens live for 24 hours — long enough to accommodate an email sitting in an
// inbox for a day, short enough that a leaked token can't be used next month.
const TTL_MS = 24 * 60 * 60_000;

function sha(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

@Injectable()
export class EmailVerificationService {
  private readonly log = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: AppConfigService,
    private readonly email: EmailService,
  ) {}

  /** Returns true when the user is allowed to log in (either already verified
   *  or this install doesn't require verification). */
  isAllowedToLogin(user: { emailVerifiedAt: Date | null }): boolean {
    if (!this.cfg.requireEmailVerification) return true;
    return !!user.emailVerifiedAt;
  }

  /** Generate a fresh token, persist its hash, and email the link. Safe to
   *  call repeatedly (old pending tokens are invalidated on each call). */
  async issueAndSend(userId: string, email: string): Promise<void> {
    // Expire any outstanding tokens first so a user clicking an old link
    // after requesting a new one doesn't hit a stale row.
    await this.prisma.emailVerification.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const raw = randomBytes(32).toString('base64url');
    await this.prisma.emailVerification.create({
      data: {
        userId,
        tokenSha: sha(raw),
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    });

    const link = `${this.cfg.appBaseUrl}/auth/verify?token=${encodeURIComponent(raw)}`;
    if (this.email.enabled) {
      try {
        await this.email.send({
          to: [email],
          subject: 'Verify your Query Schema email',
          body:
            `Click the link below to verify your email address. ` +
            `The link expires in 24 hours.\n\n${link}\n\n` +
            `If you didn't sign up for Query Schema, you can ignore this email.`,
        });
      } catch (err) {
        // Surface as a service-unavailable at the controller level. We keep
        // the token in the DB so retry still works.
        this.log.warn(`verification email failed: ${(err as Error).message}`);
        throw err;
      }
    } else {
      // Developer path: no SMTP configured. Log the link so the operator can
      // copy/paste it. Never do this in a hosted env.
      this.log.log(`[dev] verification link for ${email}: ${link}`);
    }
  }

  /** Consume a raw token and mark the user as verified. Idempotent-ish: if
   *  the token was already consumed or expired we throw, so the UI can show
   *  a clear error. */
  async verify(rawToken: string): Promise<void> {
    if (!rawToken) throw new BadRequestException('Missing token');
    const row = await this.prisma.emailVerification.findUnique({
      where: { tokenSha: sha(rawToken) },
    });
    if (!row) throw new NotFoundException('Invalid or expired verification link');
    if (row.consumedAt) throw new BadRequestException('This link has already been used');
    if (row.expiresAt < new Date()) throw new BadRequestException('This link has expired');

    await this.prisma.$transaction([
      this.prisma.emailVerification.update({
        where: { id: row.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);
  }

  /** Used by the "resend" button on the login page when the user sees an
   *  EMAIL_NOT_VERIFIED error. Always returns 200 to avoid leaking which
   *  emails have accounts. */
  async requestResend(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.emailVerifiedAt) return;
    await this.issueAndSend(user.id, user.email).catch((err) =>
      this.log.warn(`resend failed: ${(err as Error).message}`),
    );
  }
}
