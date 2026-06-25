import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

/**
 * Resolves the server's OUTBOUND IP — the address a customer's database sees
 * when our API connects to it. Customers with an IP allowlist on their DB add
 * this IP to let us through.
 *
 * Resolution order:
 *   1. EGRESS_IP env override (authoritative — set this on a fixed/NAT egress).
 *   2. Auto-detect once at startup via ipify (cached for the process lifetime).
 *   3. null if detection fails (egress firewalled) — the UI then shows a
 *      "contact support for our IP" fallback instead of a wrong value.
 *
 * Cached: detection runs once on boot, not per request.
 */
@Injectable()
export class EgressIpService implements OnModuleInit {
  private readonly log = new Logger(EgressIpService.name);
  private ip: string | null = null;

  constructor(private readonly cfg: AppConfigService) {}

  async onModuleInit() {
    const override = this.cfg.egressIpOverride;
    if (override) {
      this.ip = override;
      this.log.log(`Egress IP (from EGRESS_IP): ${override}`);
      return;
    }
    await this.detect();
  }

  private async detect() {
    // Two providers for resilience; first that answers wins.
    const sources = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
    for (const url of sources) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        const text = (await res.text()).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text) || text.includes(':')) {
          this.ip = text;
          this.log.log(`Egress IP (auto-detected): ${text}`);
          return;
        }
      } catch (e) {
        this.log.debug(`egress detect via ${url} failed: ${(e as Error).message}`);
      }
    }
    this.log.warn('Could not auto-detect egress IP (egress may be firewalled). Set EGRESS_IP to show it on the connection page.');
  }

  /** The resolved egress IP, or null if unknown. */
  get(): string | null {
    return this.ip;
  }
}
