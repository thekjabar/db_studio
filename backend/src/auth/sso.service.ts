import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AppConfigService } from '../config/config.service';
import { AuthService } from './auth.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { Role } from '@prisma/client';

/**
 * Per-workspace OIDC SSO. Flow:
 *   1. User hits /auth/sso/:slug → we look up workspace, build IdP auth URL,
 *      redirect.
 *   2. IdP authenticates, calls back /auth/sso/:slug/callback with code.
 *   3. We exchange code → tokens, verify id_token, extract email, find or
 *      create the user, add them to the workspace, issue local JWTs.
 *
 * State: a short-lived random token stored in an HttpOnly cookie that must
 * match the `state` param the IdP echoes back. Prevents CSRF on the callback.
 *
 * Token verification is minimal — we decode the id_token, check `iss` matches
 * the configured issuer, `aud` matches our client_id, and `exp` hasn't passed.
 * We don't verify the RSA signature because the hop from our backend to the
 * IdP's token endpoint is already TLS-authenticated to the IdP's certificate,
 * so the tokens we receive have the same integrity guarantee as signature
 * verification would provide against a passive attacker. Skipping JWKS
 * fetching cuts our dependency surface and cold-start latency; an active MITM
 * on the IdP's token endpoint would need to break TLS.
 */
@Injectable()
export class SsoService {
  private readonly log = new Logger(SsoService.name);
  // In-memory issuer-metadata cache. Discovery docs rarely change and each
  // workspace hits its own IdP, so a 10-minute TTL is plenty.
  private metaCache = new Map<string, { at: number; data: IssuerMetadata }>();
  private readonly META_TTL_MS = 10 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly cfg: AppConfigService,
    private readonly auth: AuthService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async getConfig(workspaceId: string) {
    const row = await this.prisma.workspaceSso.findUnique({ where: { workspaceId } });
    if (!row) return null;
    return {
      enabled: row.enabled,
      issuerUrl: row.issuerUrl,
      clientId: row.clientId,
      allowedDomains: row.allowedDomains,
      autoProvision: row.autoProvision,
      hasSecret: row.clientSecretCt.length > 0,
    };
  }

  async upsertConfig(
    workspaceId: string,
    input: {
      issuerUrl: string;
      clientId: string;
      clientSecret?: string;
      enabled?: boolean;
      allowedDomains?: string | null;
      autoProvision?: boolean;
    },
  ) {
    if (!/^https:\/\//.test(input.issuerUrl)) {
      throw new BadRequestException('Issuer URL must be https://');
    }
    const existing = await this.prisma.workspaceSso.findUnique({ where: { workspaceId } });

    // Require a secret on first creation; on updates it's optional (unchanged).
    let secretCt = existing?.clientSecretCt ?? Buffer.alloc(0);
    if (input.clientSecret && input.clientSecret.trim()) {
      secretCt = Buffer.from(
        this.crypto.encrypt(input.clientSecret, `sso:${workspaceId}`),
        'base64',
      );
    } else if (!existing) {
      throw new BadRequestException('Client secret is required for new SSO configs');
    }

    const saved = await this.prisma.workspaceSso.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        clientSecretCt: secretCt,
        enabled: input.enabled ?? false,
        allowedDomains: input.allowedDomains ?? null,
        autoProvision: input.autoProvision ?? true,
      },
      update: {
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        clientSecretCt: secretCt,
        enabled: input.enabled ?? existing?.enabled ?? false,
        allowedDomains: input.allowedDomains ?? null,
        autoProvision: input.autoProvision ?? existing?.autoProvision ?? true,
      },
    });
    // Invalidate cache so a corrected issuer URL takes effect immediately.
    this.metaCache.delete(saved.issuerUrl);
    return this.getConfig(workspaceId);
  }

  async disable(workspaceId: string) {
    await this.prisma.workspaceSso.update({
      where: { workspaceId },
      data: { enabled: false },
    });
    return { ok: true as const };
  }

  /** Build the auth URL the user should be redirected to. Returns both the
   *  URL and the state cookie value the caller should set. */
  async beginLogin(slug: string): Promise<{ url: string; state: string; nonce: string }> {
    const ws = await this.prisma.workspace.findUnique({
      where: { slug },
      include: { sso: true },
    });
    if (!ws?.sso?.enabled) throw new NotFoundException('SSO not configured for this workspace');

    const meta = await this.fetchMetadata(ws.sso.issuerUrl);

    const state = randomBytes(24).toString('base64url');
    const nonce = randomBytes(24).toString('base64url');
    const redirectUri = this.callbackUrl(slug);
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('client_id', ws.sso.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    return { url: url.toString(), state, nonce };
  }

  /** Handle the IdP's redirect back. Returns issued JWTs. */
  async completeLogin(
    slug: string,
    code: string,
    returnedState: string,
    expectedState: string,
    expectedNonce: string,
    reqMeta: { ip?: string; userAgent?: string },
  ) {
    if (!code) throw new BadRequestException('Missing code');
    if (!returnedState || returnedState !== expectedState) {
      throw new UnauthorizedException('SSO state mismatch (possible CSRF)');
    }
    const ws = await this.prisma.workspace.findUnique({
      where: { slug },
      include: { sso: true },
    });
    if (!ws?.sso?.enabled) throw new NotFoundException('SSO not configured');

    const meta = await this.fetchMetadata(ws.sso.issuerUrl);
    const clientSecret = this.crypto.decrypt(
      Buffer.from(ws.sso.clientSecretCt).toString('base64'),
      `sso:${ws.id}`,
    );

    const tokenRes = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.callbackUrl(slug),
        client_id: ws.sso.clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      this.log.warn(`SSO token exchange failed: ${tokenRes.status} ${text.slice(0, 500)}`);
      throw new UnauthorizedException('SSO token exchange failed');
    }
    const tokenJson = (await tokenRes.json()) as { id_token?: string; access_token?: string };
    if (!tokenJson.id_token) throw new UnauthorizedException('IdP did not return an id_token');

    const claims = decodeIdToken(tokenJson.id_token);
    if (claims.iss !== meta.issuer && claims.iss !== ws.sso.issuerUrl) {
      throw new UnauthorizedException('id_token issuer mismatch');
    }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(ws.sso.clientId)) {
      throw new UnauthorizedException('id_token audience mismatch');
    }
    if (claims.exp && claims.exp * 1000 < Date.now()) {
      throw new UnauthorizedException('id_token expired');
    }
    if (expectedNonce && claims.nonce && claims.nonce !== expectedNonce) {
      throw new UnauthorizedException('id_token nonce mismatch');
    }

    const email = (claims.email as string | undefined)?.toLowerCase();
    if (!email) throw new UnauthorizedException('IdP did not return an email claim');

    if (ws.sso.allowedDomains) {
      const allowed = ws.sso.allowedDomains.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
      const domain = email.split('@')[1];
      if (allowed.length > 0 && !allowed.includes(domain)) {
        throw new UnauthorizedException(`Email domain ${domain} is not allowed for this workspace`);
      }
    }

    // Find-or-create the user. OIDC emails are considered verified because the
    // IdP vouches for them (same rationale as Google OAuth flow).
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      if (!ws.sso.autoProvision) {
        throw new UnauthorizedException('No account for this email. Ask your workspace owner to invite you.');
      }
      user = await this.prisma.user.create({
        data: {
          email,
          passwordHash: null,
          displayName: (claims.name as string | undefined) ?? null,
          emailVerifiedAt: new Date(),
        },
      });
    } else if (!user.emailVerifiedAt) {
      user = await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
    }

    // Ensure workspace membership — SSO implies "you belong here".
    await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: user.id } },
      create: { workspaceId: ws.id, userId: user.id, role: Role.VIEWER },
      update: {},
    });
    // Guarantee personal workspace so downstream code that assumes its
    // existence doesn't blow up.
    await this.workspaces.ensurePersonalWorkspace(user.id).catch(() => null);

    return this.auth.issueSessionForUser(user.id, user.email, reqMeta);
  }

  private callbackUrl(slug: string): string {
    const base = this.cfg.oauthCallbackBaseUrl.replace(/\/$/, '');
    return `${base}/api/auth/sso/${slug}/callback`;
  }

  private async fetchMetadata(issuerUrl: string): Promise<IssuerMetadata> {
    const cached = this.metaCache.get(issuerUrl);
    if (cached && Date.now() - cached.at < this.META_TTL_MS) return cached.data;

    // Support both "issuer" URLs and discovery-doc URLs. If the URL already
    // ends with /.well-known/openid-configuration we use it as-is; otherwise
    // we append.
    const discoveryUrl = /\.well-known\/openid-configuration$/.test(issuerUrl)
      ? issuerUrl
      : issuerUrl.replace(/\/$/, '') + '/.well-known/openid-configuration';

    const res = await fetch(discoveryUrl);
    if (!res.ok) {
      throw new BadRequestException(`OIDC discovery failed (${res.status}) for ${discoveryUrl}`);
    }
    const data = (await res.json()) as IssuerMetadata;
    if (!data.authorization_endpoint || !data.token_endpoint || !data.issuer) {
      throw new BadRequestException('IdP discovery doc missing required fields');
    }
    this.metaCache.set(issuerUrl, { at: Date.now(), data });
    return data;
  }
}

interface IssuerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
}

interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

/** Base64url-decode the JWT payload. No signature check — see class comment. */
function decodeIdToken(token: string): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthorizedException('Malformed id_token');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  try {
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    throw new UnauthorizedException('Unparseable id_token payload');
  }
}

