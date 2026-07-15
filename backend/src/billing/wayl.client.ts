import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/config.service';

/** A Wayl hosted-checkout link (returned by create + fetch). */
export interface WaylLink {
  id: string;
  referenceId: string;
  code: string;
  total: string;
  currency: 'IQD';
  status: WaylLinkStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  webhookUrl?: string;
  redirectionUrl?: string;
}

/** Wayl's link status vocabulary. Complete/Delivered = paid. */
export type WaylLinkStatus =
  | 'Created'
  | 'Pending'
  | 'Processing'
  | 'Complete'
  | 'Delivered'
  | 'Cancelled'
  | 'Rejected'
  | 'Returned';

/** Shape Wayl POSTs to our webhook. `id` == link.id == our providerRef. */
export interface WaylWebhookPayload {
  verb?: string;
  event?: string;
  referenceId: string;
  paymentMethod?: string;
  paymentStatus: string; // maps to the WaylLinkStatus terminal sets
  paymentProcessor?: string;
  total: number; // charged amount, IQD — used by the amount guard
  commission?: number;
  code?: string;
  id: string; // Wayl link id — the webhook routing key
}

export interface CreateLinkInput {
  referenceId: string;
  totalIqd: number;
  customParameter?: string;
  lineItems: { label: string; amountIqd: number; type: 'increase' | 'decrease' }[];
}

/** Thrown for any non-2xx / transport failure talking to Wayl. */
export class WaylError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'protocol' | 'http',
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'WaylError';
  }
}

/**
 * Thin typed wrapper over the Wayl REST API (https://api.thewayl.com). Money is
 * always whole-integer IQD (Iraqi Dinar has no minor unit). Every request
 * carries the merchant token in `X-WAYL-AUTHENTICATION`.
 *
 * Wayl signs each webhook with HMAC-SHA256 over the exact raw body, keyed by
 * the webhookSecret we hand it at link creation. `verifySignature` re-computes
 * it and constant-time compares — which is why the controller must receive the
 * raw request bytes, not a re-serialized JSON object.
 */
@Injectable()
export class WaylClient {
  private readonly logger = new Logger(WaylClient.name);

  constructor(private readonly cfg: AppConfigService) {}

  /** POST /api/v1/links — create a hosted-checkout link. */
  async createLink(input: CreateLinkInput): Promise<WaylLink> {
    const body = {
      env: this.cfg.waylEnv,
      referenceId: input.referenceId,
      total: input.totalIqd,
      currency: 'IQD',
      customParameter: input.customParameter ?? '',
      lineItem: input.lineItems.map((l) => ({
        label: l.label,
        amount: l.amountIqd,
        type: l.type,
      })),
      webhookUrl: this.cfg.waylWebhookUrl,
      webhookSecret: this.cfg.waylWebhookSecret,
      redirectionUrl: this.cfg.waylRedirectionUrl,
    };
    const res = await this.request('POST', '/api/v1/links', body);
    return (res?.data ?? res) as WaylLink;
  }

  /** GET /api/v1/links/{id} — fetch a link (the status source of truth). */
  async getLink(idOrReference: string): Promise<WaylLink> {
    const res = await this.request(
      'GET',
      `/api/v1/links/${encodeURIComponent(idOrReference)}`,
    );
    return (res?.data ?? res) as WaylLink;
  }

  /**
   * Verify a webhook signature: HMAC-SHA256 over the raw body, keyed with our
   * WAYL_WEBHOOK_SECRET, hex-encoded, constant-time compared against the
   * `x-wayl-signature-256` header value.
   */
  verifySignature(rawBody: Buffer, signatureHex: string | undefined): boolean {
    const secret = this.cfg.waylWebhookSecret;
    if (!secret || !signatureHex) return false;
    const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
    let expected: Buffer;
    let received: Buffer;
    try {
      expected = Buffer.from(computedHex, 'hex');
      received = Buffer.from(signatureHex.trim(), 'hex');
    } catch {
      return false;
    }
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<any> {
    const url = `${this.cfg.waylApiBase}${path}`;
    const headers: Record<string, string> = {
      'X-WAYL-AUTHENTICATION': this.cfg.waylApiToken ?? '',
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new WaylError(`Wayl request failed: ${(e as Error).message}`, 'network');
    }

    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      if (!res.ok) {
        throw new WaylError(
          `Wayl returned a non-JSON error (${res.status})`,
          'protocol',
          res.status,
          text.slice(0, 500),
        );
      }
      parsed = undefined;
    }
    if (!res.ok) {
      const msg = parsed?.message ?? `Wayl request failed (${res.status})`;
      this.logger.warn(`Wayl ${method} ${path} -> ${res.status}: ${msg}`);
      throw new WaylError(msg, 'http', res.status, parsed);
    }
    return parsed;
  }
}
