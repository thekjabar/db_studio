import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler guard for running behind Cloudflare → nginx.
 *
 * SECURITY: the base guard keys its buckets on `req.ip`, which — because every
 * request arrives through nginx on the Docker bridge — is the *gateway* address
 * for all internet traffic. That collapsed every client into ONE bucket per
 * route, so a single unauthenticated attacker sending 10 requests/min to
 * /auth/login could hold the whole platform at HTTP 429 indefinitely. Keying on
 * the real client address restores per-client limits.
 *
 * Header precedence: Cloudflare's `CF-Connecting-IP` is authoritative when
 * present (Cloudflare overwrites any client-supplied copy), then the left-most
 * X-Forwarded-For entry, then the socket peer as a last resort.
 *
 * Caveat: a request that reaches nginx *without* going through Cloudflare could
 * still spoof these headers, which would let an attacker evade their own limit
 * (it does not restore the platform-wide DoS). Closing that fully means
 * restricting nginx :443 to Cloudflare's IP ranges — tracked separately.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const header = (name: string): string | undefined => {
      const v = req?.headers?.[name];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) return v[0].trim();
      return undefined;
    };

    const cf = header('cf-connecting-ip');
    if (cf) return cf;

    const xff = header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }

    // `req.ips` is populated once Express `trust proxy` is enabled (see main.ts).
    if (Array.isArray(req?.ips) && req.ips.length > 0) return req.ips[0];
    return req?.ip ?? 'unknown';
  }

  protected async getErrorMessage(): Promise<string> {
    return 'Too many requests. Please slow down and try again in a moment.';
  }
}
