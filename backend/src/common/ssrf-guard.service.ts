import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

/**
 * Rejects outbound destinations that point back into our own infrastructure.
 *
 * SECURITY: several endpoints take a host/URL from the user and make the SERVER
 * connect to it — connection host, SSH bastion, webhook URL, export webhook.
 * Without this, any signed-up user could aim those at loopback, link-local
 * (cloud metadata), or private ranges and reach internal services, or use the
 * connect/refuse timing as an internal port scanner.
 *
 * Two rules matter:
 *  1. Validate the RESOLVED IPs, not the hostname — `db.evil.com` can simply
 *     have an A record of 127.0.0.1, and a name-only blocklist never sees it.
 *  2. Only applies when OUR server dials. Traffic routed through a user's local
 *     agent is dialed from the user's own machine on their own network, where
 *     private addresses are the entire point — those are not checked here.
 *
 * Self-hosted installs legitimately point at private databases, so operators can
 * opt out with ALLOW_PRIVATE_HOSTS=true.
 */
@Injectable()
export class SsrfGuardService {
  private readonly logger = new Logger(SsrfGuardService.name);

  constructor(private readonly cfg: AppConfigService) {}

  /** Throws if `host` (or anything it resolves to) is not a public address. */
  async assertPublicHost(host: string, label = 'host'): Promise<void> {
    if (this.cfg.allowPrivateHosts) return;

    const cleaned = (host ?? '').trim().replace(/^\[|\]$/g, '');
    if (!cleaned) throw new BadRequestException(`${label} is required`);

    const addrs = await this.resolve(cleaned, label);
    for (const addr of addrs) {
      if (this.isBlocked(addr)) {
        this.logger.warn(`Blocked SSRF attempt: ${label}=${cleaned} -> ${addr}`);
        throw new BadRequestException(
          `${label} "${cleaned}" resolves to a private or internal address (${addr}), which isn't allowed. ` +
            `To reach a database on your own network, route the connection through a local agent instead.`,
        );
      }
    }
  }

  /** Same check for a full URL (webhooks, export targets). */
  async assertPublicUrl(rawUrl: string, label = 'URL'): Promise<void> {
    if (this.cfg.allowPrivateHosts) return;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException(`${label} is not a valid URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException(`${label} must be http(s)`);
    }
    await this.assertPublicHost(parsed.hostname, label);
  }

  private async resolve(host: string, label: string): Promise<string[]> {
    if (isIP(host)) return [host];
    try {
      const rows = await dns.lookup(host, { all: true, verbatim: true });
      if (rows.length === 0) throw new Error('no addresses');
      return rows.map((r) => r.address);
    } catch {
      // Unresolvable names are refused rather than passed through: a name that
      // resolves only inside our network (e.g. another compose service) would
      // otherwise slip past when lookup fails here but succeeds at dial time.
      throw new BadRequestException(`${label} "${host}" could not be resolved to a public address`);
    }
  }

  /** True for anything that isn't a routable public address. */
  private isBlocked(addr: string): boolean {
    const v = isIP(addr);
    if (v === 4) return this.isBlockedV4(addr);
    if (v === 6) return this.isBlockedV6(addr);
    return true;
  }

  private isBlockedV4(addr: string): boolean {
    const p = addr.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local — cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private — Docker bridges live here
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 test nets
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  private isBlockedV6(addr: string): boolean {
    const a = addr.toLowerCase().split('%')[0]; // strip zone id
    if (a === '::' || a === '::1') return true; // unspecified / loopback
    // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded v4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return this.isBlockedV4(mapped[1]);
    if (a.startsWith('fe80')) return true; // link-local
    if (/^f[cd]/.test(a)) return true; // unique-local fc00::/7
    if (a.startsWith('ff')) return true; // multicast
    return false;
  }
}
