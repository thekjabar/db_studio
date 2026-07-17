import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

// The committed dev default for OPERATOR_JWT_SECRET. Refused in production (see
// the constructor) — a deploy running on this value is trivially forgeable.
const DEV_OPERATOR_SECRET = 'dev-operator-secret-change-me-0000000000000000';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >=32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >=32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  ENCRYPTION_KEY: z.string().min(1, 'ENCRYPTION_KEY is required'),
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  DEFAULT_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  RATE_LIMIT_TTL_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  TOTP_ISSUER: z.string().default('Dbdash'),
  // Empty strings (from `docker compose ${FOO:-}`) are normalized to undefined
  // so `??` fallbacks kick in downstream.
  ANTHROPIC_API_KEY: z.string().transform((v) => v || undefined).optional(),
  ANTHROPIC_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  // Provider switch. 'auto' (default) picks the first provider with a key
  // configured: Anthropic → Gemini → OpenAI → Groq → OpenRouter → Ollama.
  // Pin explicitly when you want to guarantee a specific backend.
  AI_PROVIDER: z
    .enum(['auto', 'anthropic', 'gemini', 'openai', 'groq', 'openrouter', 'ollama'])
    .default('auto'),
  // Override the model per provider. When unset, each provider uses its own
  // cheap-but-capable default (e.g. haiku-4.5, gemini-2.0-flash, gpt-4o-mini).
  AI_MODEL: z.string().transform((v) => v || undefined).optional(),
  GEMINI_API_KEY: z.string().transform((v) => v || undefined).optional(),
  OPENAI_API_KEY: z.string().transform((v) => v || undefined).optional(),
  GROQ_API_KEY: z.string().transform((v) => v || undefined).optional(),
  OPENROUTER_API_KEY: z.string().transform((v) => v || undefined).optional(),
  // Ollama runs locally; we only need its base URL.
  OLLAMA_BASE_URL: z.string().transform((v) => v || undefined).optional(),
  GOOGLE_CLIENT_ID: z.string().transform((v) => v || undefined).optional(),
  GOOGLE_CLIENT_SECRET: z.string().transform((v) => v || undefined).optional(),
  GITHUB_CLIENT_ID: z.string().transform((v) => v || undefined).optional(),
  GITHUB_CLIENT_SECRET: z.string().transform((v) => v || undefined).optional(),
  OAUTH_CALLBACK_BASE_URL: z.string().transform((v) => v || undefined).optional(),
  OAUTH_SUCCESS_REDIRECT: z.string().default('/auth/callback'),
  REDIS_URL: z.string().transform((v) => v || undefined).optional(),
  SCHEDULER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  SCHEDULER_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  SMTP_URL: z.string().transform((v) => v || undefined).optional(),
  SMTP_FROM: z.string().transform((v) => v || undefined).optional(),
  // Resend native HTTP API — preferred over SMTP when set. RESEND_FROM falls
  // back to SMTP_FROM if not provided. The from-address domain must be
  // verified in Resend.
  RESEND_API_KEY: z.string().transform((v) => v || undefined).optional(),
  RESEND_FROM: z.string().transform((v) => v || undefined).optional(),
  SLOW_QUERY_THRESHOLD_MS: z.coerce.number().int().positive().default(1000),
  SLOW_QUERY_RETENTION: z.coerce.number().int().positive().default(10_000),
  // Correctness-aware query cache. 0 disables it. Short by design — in-band
  // writes invalidate instantly; this only bounds staleness from out-of-band
  // writes (psql etc.).
  QUERY_CACHE_TTL_SEC: z.coerce.number().int().min(0).default(60),
  // Outbound IP customers add to their DB allowlist. Optional: if set, it's
  // shown verbatim (override). If unset, the server auto-detects its egress IP
  // at startup (via ipify) and serves that.
  EGRESS_IP: z.string().transform((v) => v || undefined).optional(),
  SENTRY_DSN: z.string().transform((v) => v || undefined).optional(),
  SENTRY_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.2),
  API_KEY_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  MAX_CONNECTIONS_PER_WORKSPACE: z.coerce.number().int().positive().default(50),
  MAX_SCHEDULED_QUERIES_PER_WORKSPACE: z.coerce.number().int().positive().default(50),
  MAX_WEBHOOKS_PER_CONNECTION: z.coerce.number().int().positive().default(20),
  // Where the user ends up after clicking a verification / password-reset
  // link. Must be a real browser origin (no trailing slash). Defaults to the
  // first allowed frontend origin.
  APP_BASE_URL: z.string().transform((v) => v || undefined).optional(),
  // When unset AND SMTP is unconfigured, signups auto-verify — otherwise the
  // operator would be locked out of their own self-hosted instance. Set to
  // `true` to force verification even without SMTP (useful for preview envs
  // where an operator will flip the DB flag manually).
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // `pretty` is human-friendly for local dev; `json` emits one JSON object
  // per log line so Logtail/Datadog/Loki can parse without regex wrangling.
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  // Key-management provider for envelope encryption. `local` uses the
  // ENCRYPTION_KEY env var as the master key (fine for self-host); the
  // others call out to a real KMS so the master key never sits on this host.
  KMS_PROVIDER: z.enum(['local', 'aws', 'gcp', 'vault']).default('local'),
  // Provider-specific config — all optional, only the relevant ones are read.
  AWS_KMS_KEY_ID: z.string().transform((v) => v || undefined).optional(),
  AWS_REGION: z.string().transform((v) => v || undefined).optional(),
  GCP_KMS_KEY_NAME: z.string().transform((v) => v || undefined).optional(),
  VAULT_ADDR: z.string().transform((v) => v || undefined).optional(),
  VAULT_TOKEN: z.string().transform((v) => v || undefined).optional(),
  VAULT_TRANSIT_KEY: z.string().transform((v) => v || undefined).optional(),
  // Bearer token Prometheus scrapers must present on /metrics. Leave unset
  // to disable the endpoint entirely (returns 404). Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  METRICS_TOKEN: z.string().transform((v) => v || undefined).optional(),
  // Data retention (days). Older rows are pruned by the compliance sweep.
  RETENTION_AUDIT_DAYS: z.coerce.number().int().positive().default(365),
  // --- Operator panel (admin subdomain) ---
  // Separate JWT secret so a leak of the customer JWT secret doesn't give
  // anyone admin access. Required in production; generated short-lived
  // default in dev so `pnpm dev` works without extra setup.
  OPERATOR_JWT_SECRET: z
    .string()
    .min(32, 'OPERATOR_JWT_SECRET must be >=32 chars')
    .default(DEV_OPERATOR_SECRET),
  OPERATOR_JWT_TTL: z.string().default('30m'),
  OPERATOR_REFRESH_TTL: z.string().default('1d'),
  // Origins allowed to hit /api/operator — typically the admin.* subdomain.
  // Kept separate from FRONTEND_ORIGIN so a CORS relax on the customer app
  // doesn't accidentally open the operator API.
  OPERATOR_ORIGIN: z.string().default('http://localhost:5174'),
  // Bootstrap: when both set and no operators exist yet, the API seeds a
  // super-operator on first boot. Safe because after bootstrap the check
  // `count() === 0` never triggers again.
  OPERATOR_BOOTSTRAP_EMAIL: z.string().transform((v) => v || undefined).optional(),
  OPERATOR_BOOTSTRAP_PASSWORD: z.string().transform((v) => v || undefined).optional(),
  // When true, /api/auth/signup requires a valid invite code. Existing users
  // stay logged in — the gate only blocks new account creation.
  REQUIRE_INVITE_CODE_ON_SIGNUP: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // When true, self-signups land in a `pending` queue and an operator must
  // approve them before they can log in. Default OFF now that billing gates
  // usage — new users get in immediately and are prompted to subscribe.
  REQUIRE_SIGNUP_APPROVAL: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Workspace SSO (OIDC). OFF by default: a workspace owner supplies their own
  // issuer, so an IdP they control must NEVER be trusted to assert an identity
  // outside domains that workspace has proven it owns. Until domain-ownership
  // verification exists, keep this disabled — see SsoService.callback, which
  // additionally refuses to resolve non-members.
  SSO_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Allow the SERVER to dial private/loopback/link-local addresses (connection
  // hosts, SSH bastions, webhooks). Must stay false on a shared/SaaS install —
  // it's the SSRF guard. Self-hosted instances that legitimately point at
  // databases on their own LAN can turn it on. Note this never affects
  // agent-tunnelled connections, which dial from the user's own machine.
  ALLOW_PRIVATE_HOSTS: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // --- Wayl online payments (subscription checkout) ---
  // Merchant token, sent as the `X-WAYL-AUTHENTICATION` header. When unset,
  // online payments are disabled and checkout returns a friendly "not
  // configured yet" message — nothing else breaks.
  WAYL_API_TOKEN: z.string().transform((v) => v || undefined).optional(),
  // Shared secret: sent to Wayl at link creation AND used to verify the
  // HMAC-SHA256 webhook signature. Required for the webhook to be trusted.
  WAYL_WEBHOOK_SECRET: z.string().transform((v) => v || undefined).optional(),
  // 'live' takes real payments; 'test' uses Wayl's sandbox.
  WAYL_ENV: z.enum(['live', 'test']).default('test'),
  WAYL_API_BASE: z.string().default('https://api.thewayl.com'),
  // Public URL Wayl POSTs payment results to. Defaults to the app origin's
  // proxied API path, which nginx routes to this backend.
  WAYL_WEBHOOK_URL: z.string().transform((v) => v || undefined).optional(),
  // Where Wayl bounces the customer after checkout. Defaults to the billing
  // page, which then verifies the payment on return.
  WAYL_REDIRECTION_URL: z.string().transform((v) => v || undefined).optional(),
});

export type AppEnv = z.infer<typeof EnvSchema>;

@Injectable()
export class AppConfigService {
  private readonly env: AppEnv;
  private readonly logger = new Logger(AppConfigService.name);
  readonly encryptionKey: Buffer;

  constructor() {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
      throw new Error('Invalid environment configuration');
    }
    this.env = parsed.data;

    // SECURITY: OPERATOR_JWT_SECRET has a dev default so `pnpm dev` works with
    // no setup — but that default is committed to the repo, so a production
    // deploy that forgets to set it would let anyone forge an operator token
    // and take the whole admin panel. The comment claimed it was "required in
    // production"; nothing enforced that. Now it does.
    if (this.env.NODE_ENV === 'production' && this.env.OPERATOR_JWT_SECRET === DEV_OPERATOR_SECRET) {
      throw new Error(
        'OPERATOR_JWT_SECRET is still the built-in development default. Set it to a unique random value in production — ' +
          'generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
      );
    }

    // Decode & validate encryption key: must be exactly 32 bytes.
    const keyBuf = Buffer.from(this.env.ENCRYPTION_KEY, 'base64');
    if (keyBuf.length !== 32) {
      throw new Error(
        `ENCRYPTION_KEY must decode to 32 bytes (got ${keyBuf.length}). ` +
          `Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
      );
    }
    this.encryptionKey = keyBuf;
    this.logger.log(`Config loaded (env=${this.env.NODE_ENV})`);
  }

  get nodeEnv() { return this.env.NODE_ENV; }
  get isProd() { return this.env.NODE_ENV === 'production'; }
  get port() { return this.env.PORT; }
  get databaseUrl() { return this.env.DATABASE_URL; }
  get frontendOrigins(): string[] {
    return this.env.FRONTEND_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  }
  get jwtAccessSecret() { return this.env.JWT_ACCESS_SECRET; }
  get jwtRefreshSecret() { return this.env.JWT_REFRESH_SECRET; }
  get jwtAccessTtl() { return this.env.JWT_ACCESS_TTL; }
  get jwtRefreshTtl() { return this.env.JWT_REFRESH_TTL; }
  get cookieDomain() { return this.env.COOKIE_DOMAIN; }
  get cookieSecure() { return this.env.COOKIE_SECURE; }
  get defaultStatementTimeoutMs() { return this.env.DEFAULT_STATEMENT_TIMEOUT_MS; }
  get rateLimitTtlSec() { return this.env.RATE_LIMIT_TTL_SEC; }
  get rateLimitMax() { return this.env.RATE_LIMIT_MAX; }
  get rateLimitLoginMax() { return this.env.RATE_LIMIT_LOGIN_MAX; }
  get totpIssuer() { return this.env.TOTP_ISSUER; }
  get anthropicApiKey() { return this.env.ANTHROPIC_API_KEY; }
  get anthropicModel() { return this.env.ANTHROPIC_MODEL; }
  get aiProvider() { return this.env.AI_PROVIDER; }
  get aiModelOverride() { return this.env.AI_MODEL; }
  get geminiApiKey() { return this.env.GEMINI_API_KEY; }
  get openaiApiKey() { return this.env.OPENAI_API_KEY; }
  get groqApiKey() { return this.env.GROQ_API_KEY; }
  get openrouterApiKey() { return this.env.OPENROUTER_API_KEY; }
  get ollamaBaseUrl() { return this.env.OLLAMA_BASE_URL; }
  /** True if *any* configured provider can serve AI requests. */
  get aiEnabled() {
    return !!(
      this.env.ANTHROPIC_API_KEY ||
      this.env.GEMINI_API_KEY ||
      this.env.OPENAI_API_KEY ||
      this.env.GROQ_API_KEY ||
      this.env.OPENROUTER_API_KEY ||
      this.env.OLLAMA_BASE_URL
    );
  }
  get googleClientId() { return this.env.GOOGLE_CLIENT_ID; }
  get googleClientSecret() { return this.env.GOOGLE_CLIENT_SECRET; }
  get githubClientId() { return this.env.GITHUB_CLIENT_ID; }
  get githubClientSecret() { return this.env.GITHUB_CLIENT_SECRET; }
  get oauthCallbackBaseUrl() {
    return this.env.OAUTH_CALLBACK_BASE_URL ?? `http://localhost:${this.env.PORT}`;
  }
  get oauthSuccessRedirect() { return this.env.OAUTH_SUCCESS_REDIRECT; }
  get googleOAuthEnabled() {
    return !!(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET);
  }
  get githubOAuthEnabled() {
    return !!(this.env.GITHUB_CLIENT_ID && this.env.GITHUB_CLIENT_SECRET);
  }
  get redisUrl() { return this.env.REDIS_URL; }
  get schedulerEnabled() { return !!this.env.REDIS_URL; }
  get schedulerConcurrency() { return this.env.SCHEDULER_CONCURRENCY; }
  get schedulerQueryTimeoutMs() { return this.env.SCHEDULER_QUERY_TIMEOUT_MS; }
  get smtpUrl() { return this.env.SMTP_URL; }
  get smtpFrom() { return this.env.SMTP_FROM; }
  get resendApiKey() { return this.env.RESEND_API_KEY; }
  /** From-address used for outbound mail. Resend-specific override, else SMTP_FROM. */
  get mailFrom() { return this.env.RESEND_FROM ?? this.env.SMTP_FROM; }
  get resendEnabled() { return !!(this.env.RESEND_API_KEY && this.mailFrom); }
  /** Email is sendable if either Resend (preferred) or SMTP is configured. */
  get emailEnabled() {
    return this.resendEnabled || !!(this.env.SMTP_URL && this.env.SMTP_FROM);
  }
  get slowQueryThresholdMs() { return this.env.SLOW_QUERY_THRESHOLD_MS; }
  get slowQueryRetention() { return this.env.SLOW_QUERY_RETENTION; }
  get queryCacheTtlSec() { return this.env.QUERY_CACHE_TTL_SEC; }
  get egressIpOverride() { return this.env.EGRESS_IP; }
  get sentryDsn() { return this.env.SENTRY_DSN; }
  get sentrySampleRate() { return this.env.SENTRY_SAMPLE_RATE; }
  get sentryEnabled() { return !!this.env.SENTRY_DSN; }
  get apiKeyRateLimit() { return this.env.API_KEY_RATE_LIMIT; }
  get maxConnectionsPerWorkspace() { return this.env.MAX_CONNECTIONS_PER_WORKSPACE; }
  get maxScheduledQueriesPerWorkspace() { return this.env.MAX_SCHEDULED_QUERIES_PER_WORKSPACE; }
  get maxWebhooksPerConnection() { return this.env.MAX_WEBHOOKS_PER_CONNECTION; }
  get appBaseUrl() {
    // Prefer explicit APP_BASE_URL, otherwise first FRONTEND_ORIGIN.
    return this.env.APP_BASE_URL ?? this.frontendOrigins[0] ?? 'http://localhost:5173';
  }
  get requireEmailVerification() {
    // If SMTP is configured we always require it; otherwise fall back to
    // the env flag so self-hosted single-user setups aren't forced to run
    // an SMTP server just to verify their own email.
    return this.env.REQUIRE_EMAIL_VERIFICATION || this.emailEnabled;
  }
  get logFormat() { return this.env.LOG_FORMAT; }
  get kmsProvider() { return this.env.KMS_PROVIDER; }
  get awsKmsKeyId() { return this.env.AWS_KMS_KEY_ID; }
  get awsRegion() { return this.env.AWS_REGION; }
  get gcpKmsKeyName() { return this.env.GCP_KMS_KEY_NAME; }
  get vaultAddr() { return this.env.VAULT_ADDR; }
  get vaultToken() { return this.env.VAULT_TOKEN; }
  get vaultTransitKey() { return this.env.VAULT_TRANSIT_KEY; }
  get metricsToken() { return this.env.METRICS_TOKEN; }
  get retentionAuditDays() { return this.env.RETENTION_AUDIT_DAYS; }
  get operatorJwtSecret() { return this.env.OPERATOR_JWT_SECRET; }
  get operatorJwtTtl() { return this.env.OPERATOR_JWT_TTL; }
  get operatorRefreshTtl() { return this.env.OPERATOR_REFRESH_TTL; }
  get operatorOrigins(): string[] {
    return this.env.OPERATOR_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  }
  get operatorBootstrapEmail() { return this.env.OPERATOR_BOOTSTRAP_EMAIL; }
  get operatorBootstrapPassword() { return this.env.OPERATOR_BOOTSTRAP_PASSWORD; }
  get requireInviteCode() { return this.env.REQUIRE_INVITE_CODE_ON_SIGNUP; }
  get requireSignupApproval() { return this.env.REQUIRE_SIGNUP_APPROVAL; }
  get ssoEnabled() { return this.env.SSO_ENABLED; }
  get allowPrivateHosts() { return this.env.ALLOW_PRIVATE_HOSTS; }

  // --- Wayl payments ---
  get waylApiToken() { return this.env.WAYL_API_TOKEN; }
  get waylWebhookSecret() { return this.env.WAYL_WEBHOOK_SECRET; }
  get waylEnv() { return this.env.WAYL_ENV; }
  get waylApiBase() { return this.env.WAYL_API_BASE; }
  /** Public URL Wayl calls back. Falls back to the app origin's proxied API
   *  path (nginx routes `/api` to this backend). */
  get waylWebhookUrl() {
    return this.env.WAYL_WEBHOOK_URL ?? `${this.appBaseUrl}/api/billing/wayl/webhook`;
  }
  /** Where the customer returns after checkout — the billing page verifies. */
  get waylRedirectionUrl() {
    return this.env.WAYL_REDIRECTION_URL ?? `${this.appBaseUrl}/billing`;
  }
  /** Online payments are usable only when both the merchant token and the
   *  webhook secret are set. Otherwise checkout degrades gracefully. */
  get waylEnabled() {
    return !!(this.env.WAYL_API_TOKEN && this.env.WAYL_WEBHOOK_SECRET);
  }
}
