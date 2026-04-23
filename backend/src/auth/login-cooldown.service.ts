import { HttpException, Inject, Injectable, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../scheduler/scheduler.constants';

const WINDOW_SEC = 15 * 60;
const MAX_FAILURES = 3;
const LOCK_SEC = 15 * 60;

/**
 * Per-email failed-login lockout. Three bad passwords on an email within a
 * 15-minute window locks that email for 15 minutes. Scoped to the email, not
 * the IP, because credential-stuffing bots rotate IPs — IP-based rate limits
 * already live in the global ThrottlerGuard.
 *
 * Redis-backed when available so multiple API pods share state. Falls back to
 * an in-process Map for single-pod dev.
 */
@Injectable()
export class LoginCooldownService {
  private readonly memory = new Map<string, { failures: number; resetAt: number; lockedUntil: number | null }>();

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null) {}

  private key(email: string, kind: 'fail' | 'lock'): string {
    // Normalize email — attackers routinely probe variations (EmailName vs
    // emailname, trailing whitespace). Store a canonical lowercase version.
    const normalized = email.trim().toLowerCase();
    return `dbs:auth:${kind}:${normalized}`;
  }

  /** Throws 429 if this email is currently locked. Safe to call before
   *  any password verification work so locked accounts don't burn CPU. */
  async assertNotLocked(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (this.redis) {
      const ttl = await this.redis.ttl(this.key(normalized, 'lock'));
      if (ttl > 0) {
        this.throw429(ttl);
      }
      return;
    }
    const entry = this.memory.get(normalized);
    if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
      this.throw429(Math.ceil((entry.lockedUntil - Date.now()) / 1000));
    }
  }

  /** Record a failed attempt. On the 3rd failure inside WINDOW_SEC the email
   *  is locked. Use after `assertNotLocked` + password check fails. */
  async recordFailure(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (this.redis) {
      const failKey = this.key(normalized, 'fail');
      const count = await this.redis.incr(failKey);
      if (count === 1) await this.redis.expire(failKey, WINDOW_SEC);
      if (count >= MAX_FAILURES) {
        await this.redis.set(this.key(normalized, 'lock'), '1', 'EX', LOCK_SEC);
        await this.redis.del(failKey);
      }
      return;
    }
    const now = Date.now();
    const entry = this.memory.get(normalized) ?? { failures: 0, resetAt: now + WINDOW_SEC * 1000, lockedUntil: null };
    if (entry.resetAt < now) {
      entry.failures = 0;
      entry.resetAt = now + WINDOW_SEC * 1000;
    }
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCK_SEC * 1000;
      entry.failures = 0;
    }
    this.memory.set(normalized, entry);
  }

  /** Clear the counter on successful login. */
  async recordSuccess(email: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (this.redis) {
      await this.redis.del(this.key(normalized, 'fail'));
      return;
    }
    this.memory.delete(normalized);
  }

  private throw429(retryAfterSec: number): never {
    throw new HttpException(
      {
        code: 'EMAIL_LOCKED',
        message: `Too many failed logins. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
        retryAfter: retryAfterSec,
      },
      429,
    );
  }
}
