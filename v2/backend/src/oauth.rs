//! Social OAuth (Google/GitHub) + per-workspace OIDC SSO — Rust port of v1's
//! `auth/oauth.controller.ts` (with `strategies/google.strategy.ts`,
//! `strategies/github.strategy.ts`, `guards/oauth.guards.ts` and
//! `AuthService.loginOrCreateOAuth`) and `auth/sso.controller.ts` +
//! `auth/sso.service.ts`.
//!
//! These routes mint real sessions, so this is a literal translation: same
//! paths, same provider endpoints, same account-resolution rules, same cookie
//! attributes, same redirect targets.
//!
//! ## What passport actually did (the part that had to be reimplemented)
//!
//! v1 delegated the wire protocol to `passport-oauth2`. Reproduced here from
//! the installed sources so the provider sees a byte-identical flow:
//!
//! | | Google (`passport-google-oauth20@2`) | GitHub (`passport-github2`) |
//! |---|---|---|
//! | authorize | `https://accounts.google.com/o/oauth2/v2/auth` | `https://github.com/login/oauth/authorize` |
//! | token | `https://www.googleapis.com/oauth2/v4/token` | `https://github.com/login/oauth/access_token` |
//! | scope | `email profile` (space-joined) | `user:email` |
//! | profile | `GET /oauth2/v3/userinfo` → `sub`/`email`/`name` | `GET /user` **and** `GET /user/emails` |
//! | id | `sub` | `String(json.id)` |
//! | display name | `name` | `name ?? login` |
//!
//! GitHub's email is the **primary** entry of `/user/emails` (passport asks for
//! all of them and keeps only `primary === true`); if there is none it falls
//! back to the public `email` on `/user`, and only then errors. `User-Agent:
//! passport-github` is sent because passport set it as a custom header and the
//! GitHub API rejects requests without one.
//!
//! The token exchange and profile fetches are plain `reqwest` calls. reqwest is
//! built without the `json` feature here, so bodies are `serde_json::to_vec`'d /
//! `from_slice`'d by hand and the form bodies are encoded by [`form_encode`].
//!
//! ## `state` (CSRF) — read this before changing it
//!
//! **v1 does not validate `state` on the Google/GitHub callbacks, and does not
//! even send one.** `passport-oauth2@1.8.0` picks a state store from the
//! options it is constructed with; v1 passes neither `store`, `state` nor
//! `pkce`, so it gets the `NullStore`, whose `store()` is a no-op and whose
//! `verify()` unconditionally calls back `true`. The authorize URL therefore
//! carries no `state` and the callback accepts any `code` presented to it —
//! i.e. login-CSRF is possible on v1 today.
//!
//! This port does validate it, using the *same* mechanism v1 already
//! implements for SSO (`sso.controller.ts`): a random 24-byte base64url value
//! set at authorize time in an HttpOnly cookie, echoed through the provider as
//! `state`, compared in constant time on the callback and cleared immediately
//! (single use). Cookie: `dbdash_oauth_state_{provider}`, `Path=/api/auth`,
//! `SameSite=Lax`, 10-minute `Max-Age`.
//!
//! This is safe to add rather than "incompatible" because `routes()` registers
//! the authorize leg and the callback leg **together** — either both are served
//! by this process or neither is, so a flow started here always finishes here.
//! Two deployment notes follow from that:
//!   * `OAUTH_CALLBACK_BASE_URL` must be the origin that reaches *this*
//!     process. If it points at the v1 API instead, v2 still builds the
//!     authorize URL but v1 answers the callback and ignores the cookie —
//!     which is exactly today's behaviour, so nothing breaks.
//!   * A login already in flight at the moment of a cutover has no cookie and
//!     will bounce to `/login?error=oauth_failed` once. Retrying works.
//!
//! ## Cookies
//!
//! The refresh cookie is `dbdash_rt`, `Path=/api/auth`, `HttpOnly`, absolute
//! `Expires` — identical to `main.rs`'s [`crate::refresh_cookie`] except for
//! `SameSite=Lax` instead of `Strict`. Lax is mandatory here: the browser
//! arrives on the callback as a cross-site top-level navigation from
//! Google/GitHub/the IdP, and a `Strict` cookie is not sent on it, so the
//! session would be dropped on the very next refresh.
//!
//! ## SSO
//!
//! Ported in full, including the deliberate decision documented on v1's
//! `SsoService`: the `id_token` signature is **not** verified. v1 decodes the
//! payload and checks `iss`, `aud`, `exp` and `nonce` only, arguing that the
//! token came back over a TLS-authenticated channel from the IdP's own token
//! endpoint. Reproduced verbatim — no JWKS client is involved, so nothing here
//! needed a crate v2 does not have. SAML is not implemented by v1 either
//! (`workspace-sso.prisma` says so explicitly), so there is no XML signature
//! path to port.
//!
//! The security rule that makes workspace-configured SSO safe is reproduced
//! exactly: because the workspace owner supplies the issuer, an IdP may only
//! assert an identity for someone who is *already* a member/owner of that
//! workspace, or create a brand-new account it provisions itself. Resolving an
//! arbitrary existing account by email would let any owner mint a session for
//! any user.
//!
//! ## Deployment gates (fail-safe, not feature flags)
//!
//! Same pattern as `billing.rs`/`opsadmin.rs`: a route is registered only when
//! this process holds the credentials it needs (`GOOGLE_CLIENT_ID` +
//! `GOOGLE_CLIENT_SECRET`, `GITHUB_*`, `SSO_ENABLED=true` + `ENCRYPTION_KEY`,
//! and `OAUTH_CALLBACK_BASE_URL` for anything that builds a `redirect_uri`).
//! Anything unregistered falls through the strangler proxy to v1, which still
//! has the credentials — an unconditional registration would turn a working
//! "Sign in with Google" into a permanent 503.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{
    audit, ensure_personal_workspace, gen_id, issue_tokens, req_meta, ApiError, ApiResult, AppState,
    AuthUser,
};

/// v1: `REFRESH_COOKIE` in both controllers.
const REFRESH_COOKIE: &str = "dbdash_rt";
/// v1 `sso.controller.ts` — names and attributes must match, they are the
/// cookies a login started on either stack presents on the callback.
const SSO_STATE_PREFIX: &str = "dbdash_sso_state_";
const SSO_NONCE_PREFIX: &str = "dbdash_sso_nonce_";
/// Not in v1 (v1 sends no `state` at all) — see the module docs.
const OAUTH_STATE_PREFIX: &str = "dbdash_oauth_state_";
/// v1 sets `maxAge: 10 * 60 * 1000` on the SSO state/nonce cookies.
const STATE_TTL_SECS: i64 = 10 * 60;

// ---------------------------------------------------------------------------
// Configuration (v1 `AppConfigService`)
// ---------------------------------------------------------------------------

/// v1's zod schema maps an empty string to `undefined`, so an empty env var is
/// "unset", not "set to nothing".
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

struct OauthCfg {
    /// `(clientId, clientSecret)` — v1's `googleOAuthEnabled` is
    /// `!!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET)`.
    google: Option<(String, String)>,
    github: Option<(String, String)>,
    /// v1 falls back to `http://localhost:${PORT}`, which is its *own* port —
    /// unreproducible from here and never right in production, so a missing
    /// value means "leave OAuth/SSO to v1" instead of guessing a redirect_uri.
    callback_base: Option<String>,
    /// `OAUTH_SUCCESS_REDIRECT`, default `/auth/callback`.
    success_redirect: String,
    /// v1: `frontendOrigins[0] ?? 'http://localhost:5173'`.
    frontend_origin: String,
    /// `SSO_ENABLED` — v1 defaults it to false and requires the literal
    /// `'true'`.
    sso_enabled: bool,
}

fn cfg() -> &'static OauthCfg {
    static CFG: OnceLock<OauthCfg> = OnceLock::new();
    CFG.get_or_init(|| {
        let pair = |id: &str, secret: &str| match (env_opt(id), env_opt(secret)) {
            (Some(i), Some(s)) => Some((i, s)),
            _ => None,
        };
        OauthCfg {
            google: pair("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
            github: pair("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
            callback_base: env_opt("OAUTH_CALLBACK_BASE_URL"),
            success_redirect: env_opt("OAUTH_SUCCESS_REDIRECT")
                .unwrap_or_else(|| "/auth/callback".to_string()),
            frontend_origin: env_opt("FRONTEND_ORIGIN")
                .and_then(|v| v.split(',').map(|s| s.trim().to_string()).find(|s| !s.is_empty()))
                .unwrap_or_else(|| "http://localhost:5173".to_string()),
            sso_enabled: env_opt("SSO_ENABLED").as_deref() == Some("true"),
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Prov {
    Google,
    Github,
}

impl Prov {
    /// Path segment, `User.oauthProvider` value and cookie suffix.
    fn key(self) -> &'static str {
        match self {
            Prov::Google => "google",
            Prov::Github => "github",
        }
    }
    /// v1's `ServiceUnavailableException('Google SSO not configured')`.
    fn label(self) -> &'static str {
        match self {
            Prov::Google => "Google",
            Prov::Github => "GitHub",
        }
    }
    fn authorize_url(self) -> &'static str {
        match self {
            Prov::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Prov::Github => "https://github.com/login/oauth/authorize",
        }
    }
    fn token_url(self) -> &'static str {
        match self {
            Prov::Google => "https://www.googleapis.com/oauth2/v4/token",
            Prov::Github => "https://github.com/login/oauth/access_token",
        }
    }
    /// Already joined with the strategy's `scopeSeparator` (' ' for Google,
    /// ',' for GitHub — irrelevant with a single scope, kept for fidelity).
    fn scope(self) -> &'static str {
        match self {
            Prov::Google => "email profile",
            Prov::Github => "user:email",
        }
    }
    fn creds(self) -> Option<&'static (String, String)> {
        match self {
            Prov::Google => cfg().google.as_ref(),
            Prov::Github => cfg().github.as_ref(),
        }
    }
}

/// v1 `google.strategy.ts`: `` `${cfg.oauthCallbackBaseUrl}/api/auth/oauth/google/callback` ``.
/// Deliberately NOT trailing-slash-normalised — this string has to equal the
/// URI registered in the provider console, which is whatever v1 has been
/// sending.
fn oauth_callback_url(p: Prov) -> Option<String> {
    cfg()
        .callback_base
        .as_ref()
        .map(|b| format!("{b}/api/auth/oauth/{}/callback", p.key()))
}

/// v1 `sso.service.ts` `callbackUrl()` — this one *does* strip a trailing slash.
fn sso_callback_url(slug: &str) -> Option<String> {
    cfg()
        .callback_base
        .as_ref()
        .map(|b| format!("{}/api/auth/sso/{slug}/callback", b.trim_end_matches('/')))
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

pub fn routes() -> Router<AppState> {
    let c = cfg();
    let mut r = Router::new();

    // `providers` drives the login page's buttons. Registered only when this
    // process serves at least one provider, so an OAuth-less v2 keeps
    // reporting v1's answer instead of hiding working buttons.
    let can_serve_oauth = c.callback_base.is_some() && (c.google.is_some() || c.github.is_some());
    if can_serve_oauth {
        r = r.route("/api/auth/oauth/providers", get(providers));
    }
    if c.callback_base.is_some() && c.google.is_some() {
        r = r
            .route("/api/auth/oauth/google", get(google_start))
            .route("/api/auth/oauth/google/callback", get(google_callback));
    }
    if c.callback_base.is_some() && c.github.is_some() {
        r = r
            .route("/api/auth/oauth/github", get(github_start))
            .route("/api/auth/oauth/github/callback", get(github_callback));
    }

    // SSO additionally needs ENCRYPTION_KEY: the IdP client secret is stored
    // as an encrypted envelope, so without the key this process cannot
    // complete a login at all — leave the whole feature with v1.
    if c.sso_enabled && c.callback_base.is_some() && std::env::var("ENCRYPTION_KEY").is_ok() {
        r = r
            .route(
                // `:id` (not `:workspaceId`) so the path parameter agrees with
                // the other `/api/workspaces/:id/...` routes in this router.
                "/api/workspaces/:id/sso",
                get(sso_get_config).put(sso_upsert_config).delete(sso_disable),
            )
            .route("/api/auth/sso/:slug", get(sso_start))
            .route("/api/auth/sso/:slug/callback", get(sso_callback))
            .route("/api/auth/sso/:slug/available", get(sso_available));
    }
    r
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// `encodeURIComponent` — everything outside `A-Za-z0-9-_.!~*'()` is
/// percent-encoded.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// `application/x-www-form-urlencoded` body. Space would be `%20` rather than
/// `+`; every field used here (grant_type, code, redirect_uri, client id and
/// secret) is space-free, and both encodings decode identically anyway.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", encode_uri_component(k), encode_uri_component(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// v1: `randomBytes(24).toString('base64url')`.
fn rand_state() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Constant-time equality — a `state` comparison must not leak its prefix.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Short-lived HttpOnly cookie: `Path=/api/auth`, `SameSite=Lax`, `Max-Age`.
/// Mirrors the `common` object v1 spreads over its SSO state/nonce cookies.
fn short_cookie(state: &AppState, name: &str, value: &str, max_age: i64) -> String {
    let mut c = format!("{name}={value}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    if !state.cookie_domain.is_empty() {
        c.push_str(&format!("; Domain={}", state.cookie_domain));
    }
    if state.cookie_secure {
        c.push_str("; Secure");
    }
    c
}

/// v1's `res.clearCookie(name, { path: '/api/auth', domain })`.
fn clear_cookie(state: &AppState, name: &str) -> String {
    let mut c = format!("{name}=; Path=/api/auth; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    if !state.cookie_domain.is_empty() {
        c.push_str(&format!("; Domain={}", state.cookie_domain));
    }
    if state.cookie_secure {
        c.push_str("; Secure");
    }
    c
}

/// The refresh cookie exactly as `main.rs` writes it, but `SameSite=Lax`
/// instead of `Strict` — v1's OAuth/SSO controllers override it for the same
/// reason: the browser reaches the callback through a cross-site redirect, and
/// a Strict cookie would not be sent there (nor on the redirect that follows),
/// so the session would die at the first refresh.
fn refresh_cookie_lax(state: &AppState, token: &str, expires: chrono::NaiveDateTime) -> String {
    let mut c = format!(
        "{REFRESH_COOKIE}={token}; Path=/api/auth; HttpOnly; SameSite=Lax; Expires={}",
        expires.format("%a, %d %b %Y %H:%M:%S GMT")
    );
    if !state.cookie_domain.is_empty() {
        c.push_str(&format!("; Domain={}", state.cookie_domain));
    }
    if state.cookie_secure {
        c.push_str("; Secure");
    }
    c
}

/// `res.redirect(url)` — Express answers 302 with a tiny body; only the
/// `Location` header matters to the browser.
fn redirect(location: &str, cookies: Vec<String>) -> Response {
    let mut b = Response::builder()
        .status(StatusCode::FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8");
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(&c) {
            b = b.header(header::SET_COOKIE, v);
        }
    }
    match HeaderValue::from_str(location) {
        Ok(loc) => b
            .header(header::LOCATION, loc)
            .body(Body::from(format!("Found. Redirecting to {location}")))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        // A header-unsafe Location can only come from a mangled config value;
        // never emit a half-built redirect.
        Err(_) => ApiError::internal("Invalid redirect target").into_response(),
    }
}

/// Attach a `Set-Cookie` to an error response (the state cookie is single-use
/// and must be dropped even when the login fails).
fn with_cookie(mut res: Response, cookie: String) -> Response {
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().append(header::SET_COOKIE, v);
    }
    res
}

/// Base64url-decode a JWT segment. Node's `Buffer.from(s, 'base64url')`
/// tolerates padding; the `URL_SAFE_NO_PAD` engine does not, so strip it.
fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .ok()
}

// ---------------------------------------------------------------------------
// GET /api/auth/oauth/providers
// ---------------------------------------------------------------------------

async fn providers() -> Json<Value> {
    Json(json!({
        "google": cfg().google.is_some(),
        "github": cfg().github.is_some(),
    }))
}

// ---------------------------------------------------------------------------
// GET /api/auth/oauth/{google,github}  — the authorize redirect
// ---------------------------------------------------------------------------

async fn google_start(State(state): State<AppState>) -> ApiResult<Response> {
    oauth_start(&state, Prov::Google)
}

async fn github_start(State(state): State<AppState>) -> ApiResult<Response> {
    oauth_start(&state, Prov::Github)
}

fn oauth_start(state: &AppState, p: Prov) -> ApiResult<Response> {
    // v1's OAuth guards: 503 when the provider isn't configured. Unreachable
    // while `routes()` gates registration, kept so the behaviour is identical
    // if that ever changes.
    let (client_id, _) = p.creds().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("{} SSO not configured", p.label()),
        )
    })?;
    let redirect_uri = oauth_callback_url(p).ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("{} SSO not configured", p.label()),
        )
    })?;

    let st = rand_state();
    // passport builds: response_type, redirect_uri, scope, state, client_id.
    let url = format!(
        "{}?response_type=code&redirect_uri={}&scope={}&client_id={}&state={}",
        p.authorize_url(),
        encode_uri_component(&redirect_uri),
        encode_uri_component(p.scope()),
        encode_uri_component(client_id),
        encode_uri_component(&st),
    );
    Ok(redirect(
        &url,
        vec![short_cookie(
            state,
            &format!("{OAUTH_STATE_PREFIX}{}", p.key()),
            &st,
            STATE_TTL_SECS,
        )],
    ))
}

// ---------------------------------------------------------------------------
// GET /api/auth/oauth/{google,github}/callback
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CallbackQuery {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    /// `?error=access_denied` when the user declines at the provider.
    #[serde(default)]
    error: Option<String>,
}

async fn google_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    oauth_callback(state, Prov::Google, q, headers).await
}

async fn github_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    oauth_callback(state, Prov::Github, q, headers).await
}

async fn oauth_callback(state: AppState, p: Prov, q: CallbackQuery, headers: HeaderMap) -> Response {
    let base = &cfg().frontend_origin;
    let cookie_name = format!("{OAUTH_STATE_PREFIX}{}", p.key());
    // Single use: cleared on every outcome, success or failure.
    let cleared = clear_cookie(&state, &cookie_name);
    let failed = |cookie: String| {
        redirect(&format!("{base}/login?error=oauth_failed"), vec![cookie])
    };

    // --- CSRF: the callback is only honoured for a flow this process started.
    let expected = crate::cookie_from_header(&headers, &cookie_name);
    let state_ok = match (q.state.as_deref(), expected.as_deref()) {
        (Some(got), Some(exp)) => !exp.is_empty() && ct_eq(got, exp),
        _ => false,
    };
    if !state_ok {
        tracing::warn!("{} oauth callback rejected: state mismatch", p.key());
        return failed(cleared);
    }
    if q.error.is_some() {
        return failed(cleared);
    }
    let Some(code) = q.code.as_deref().filter(|c| !c.is_empty()) else {
        return failed(cleared);
    };

    let profile = match fetch_oauth_profile(&state, p, code).await {
        Ok(pr) => pr,
        Err(e) => {
            // Never surface provider errors in the URL — v1 shows a generic code.
            tracing::warn!("{} oauth failed: {e}", p.key());
            return failed(cleared);
        }
    };

    let meta = req_meta(&headers);
    match login_or_create_oauth(&state, p, &profile, &meta).await {
        Ok((access, refresh, expires_at)) => redirect(
            &format!(
                "{base}{}#accessToken={}",
                cfg().success_redirect,
                encode_uri_component(&access)
            ),
            vec![cleared, refresh_cookie_lax(&state, &refresh, expires_at)],
        ),
        // v1 does NOT catch here: a suspended/pending/rejected account gets the
        // typed `{ code, message }` 403 body rendered in the browser rather
        // than a redirect. Reproduced so the code stays visible to support.
        // Anything else (a DB failure) becomes the generic bounce instead —
        // v1's exception filter also refuses to render internal errors, and
        // `From<sqlx::Error>` would otherwise put SQL text in front of an
        // unauthenticated visitor.
        Err(e) if e.body.is_some() => with_cookie(e.into_response(), cleared),
        Err(e) => {
            tracing::warn!("{} oauth login failed: {}", p.key(), e.message);
            failed(cleared)
        }
    }
}

// ---------------------------------------------------------------------------
// Provider token exchange + profile (passport's `userProfile`)
// ---------------------------------------------------------------------------

struct OauthProfile {
    provider_id: String,
    email: String,
    display_name: Option<String>,
}

/// GitHub rejects API calls without a User-Agent; passport sent this one.
const GITHUB_UA: &str = "passport-github";

async fn fetch_oauth_profile(state: &AppState, p: Prov, code: &str) -> Result<OauthProfile, String> {
    let (client_id, client_secret) = p.creds().ok_or_else(|| "provider not configured".to_string())?;
    let redirect_uri = oauth_callback_url(p).ok_or_else(|| "no callback base url".to_string())?;

    let body = form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
    ]);
    let mut req = state
        .http
        .post(p.token_url())
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        // GitHub answers `application/x-www-form-urlencoded` unless asked for
        // JSON (node-oauth parsed both); Google always answers JSON.
        .header(reqwest::header::ACCEPT, "application/json");
    if p == Prov::Github {
        req = req.header(reqwest::header::USER_AGENT, GITHUB_UA);
    }
    let res = req
        .body(body)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = res.status();
    let raw = res.bytes().await.map_err(|e| format!("token read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("token endpoint returned {}", status.as_u16()));
    }
    let access = parse_access_token(&raw).ok_or_else(|| "no access_token in token response".to_string())?;

    match p {
        Prov::Google => google_profile(state, &access).await,
        Prov::Github => github_profile(state, &access).await,
    }
}

/// JSON `{ "access_token": ... }`, or the form-encoded shape GitHub falls back
/// to. Token values are URL-safe, so the form branch needs no decoding.
fn parse_access_token(raw: &[u8]) -> Option<String> {
    if let Ok(v) = serde_json::from_slice::<Value>(raw) {
        if let Some(t) = v.get("access_token").and_then(|t| t.as_str()) {
            return Some(t.to_string());
        }
    }
    let text = String::from_utf8_lossy(raw);
    text.split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == "access_token")
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty())
}

async fn get_json(state: &AppState, url: &str, token: &str, ua: Option<&str>) -> Result<Value, String> {
    let mut req = state
        .http
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(ua) = ua {
        req = req.header(reqwest::header::USER_AGENT, ua);
    }
    let res = req.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = res.status();
    let raw = res.bytes().await.map_err(|e| format!("{url}: {e}"))?;
    if !status.is_success() {
        return Err(format!("{url} returned {}", status.as_u16()));
    }
    serde_json::from_slice(&raw).map_err(|e| format!("{url}: bad json: {e}"))
}

/// `passport-google-oauth20` → `/oauth2/v3/userinfo`, parsed by
/// `profile/openid.js`: `id = sub`, `displayName = name`, `emails[0] = email`.
async fn google_profile(state: &AppState, token: &str) -> Result<OauthProfile, String> {
    let j = get_json(state, "https://www.googleapis.com/oauth2/v3/userinfo", token, None).await?;
    let provider_id = j
        .get("sub")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Google userinfo has no sub".to_string())?
        .to_string();
    // v1: `UnauthorizedException('Google account has no email')`.
    let email = j
        .get("email")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Google account has no email".to_string())?
        .to_string();
    Ok(OauthProfile {
        provider_id,
        email,
        display_name: j.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()),
    })
}

/// `passport-github2`: `/user` for the identity, then `/user/emails` (the
/// `user:email` scope is granted) keeping only the entry flagged `primary`.
async fn github_profile(state: &AppState, token: &str) -> Result<OauthProfile, String> {
    let j = get_json(state, "https://api.github.com/user", token, Some(GITHUB_UA)).await?;
    // `String(json.id)` — GitHub ids are integers.
    let provider_id = match j.get("id") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => return Err("GitHub profile has no id".to_string()),
    };
    let login = j.get("login").and_then(|v| v.as_str()).map(|s| s.to_string());
    // `displayName: profile.displayName ?? profile.username`
    let display_name = j
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or(login);

    let emails = get_json(state, "https://api.github.com/user/emails", token, Some(GITHUB_UA)).await?;
    let arr = emails.as_array().cloned().unwrap_or_default();
    if arr.is_empty() {
        return Err("Failed to fetch user emails".to_string());
    }
    let primary = arr
        .iter()
        .find(|e| e.get("primary").and_then(|p| p.as_bool()).unwrap_or(false))
        .and_then(|e| e.get("email"))
        .and_then(|e| e.as_str())
        .map(|s| s.to_string());
    // passport only replaces `profile.emails` when it finds a primary, so the
    // public `email` from /user is the fallback — then, and only then, v1's
    // `validate()` errors.
    let email = primary
        .or_else(|| j.get("email").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .ok_or_else(|| {
            "GitHub account has no public email — enable email in profile".to_string()
        })?;

    Ok(OauthProfile { provider_id, email, display_name })
}

// ---------------------------------------------------------------------------
// AuthService.loginOrCreateOAuth
// ---------------------------------------------------------------------------

/// Columns every account-gate decision below reads.
const USER_COLS: &str = r#""id","email","displayName","emailVerifiedAt","suspendedAt","suspendedReason",
    "approvalStatus"::text AS "approvalStatus","approvalNote""#;

struct GateUser {
    id: String,
    email: String,
    display_name: Option<String>,
}

/// Read the three gate columns and reproduce v1's suspended / pending /
/// rejected refusals, including the audit rows and the typed error codes.
///
/// `suspendedAt` and `approvalStatus` are read with a propagating `try_get`:
/// `.ok().flatten()` on either would turn a decode mistake into "not
/// suspended" / "approved" and silently let a barred account through.
async fn gate_user(
    state: &AppState,
    row: &sqlx::postgres::PgRow,
    meta: &crate::ReqMeta,
) -> ApiResult<GateUser> {
    let id: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let email: String = row.try_get("email").map_err(|e| ApiError::internal(e.to_string()))?;
    let display_name: Option<String> = row.try_get("displayName").ok().flatten();

    let suspended: Option<chrono::NaiveDateTime> = row
        .try_get("suspendedAt")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if suspended.is_some() {
        let reason: Option<String> = row.try_get("suspendedReason").ok().flatten();
        audit(state, Some(&id), "LOGIN_SUSPENDED", meta, None).await;
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "ACCOUNT_SUSPENDED",
            reason
                .map(|r| format!("Account suspended: {r}"))
                .unwrap_or_else(|| "Account suspended. Contact support to restore access.".to_string()),
        ));
    }
    let approval: String = row
        .try_get("approvalStatus")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if approval == "pending" {
        audit(state, Some(&id), "LOGIN_PENDING", meta, None).await;
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "ACCOUNT_PENDING",
            "Your account is awaiting admin approval. You'll be able to sign in once it's reviewed.",
        ));
    }
    if approval == "rejected" {
        let note: Option<String> = row.try_get("approvalNote").ok().flatten();
        audit(state, Some(&id), "LOGIN_REJECTED", meta, None).await;
        return Err(ApiError::coded(
            StatusCode::FORBIDDEN,
            "ACCOUNT_REJECTED",
            note.map(|n| format!("Account not approved: {n}")).unwrap_or_else(|| {
                "Your account was not approved. Contact support if you think this was a mistake."
                    .to_string()
            }),
        ));
    }
    Ok(GateUser { id, email, display_name })
}

async fn login_or_create_oauth(
    state: &AppState,
    p: Prov,
    profile: &OauthProfile,
    meta: &crate::ReqMeta,
) -> ApiResult<(String, String, chrono::NaiveDateTime)> {
    // Normalize so OAuth resolves to the same account as a case/whitespace
    // variant signed up by password.
    let email = profile.email.trim().to_lowercase();

    // 1) Exact match on (provider, providerId).
    let mut row = sqlx::query(&format!(
        r#"SELECT {USER_COLS} FROM "User" WHERE "oauthProvider" = $1 AND "oauthId" = $2 LIMIT 1"#
    ))
    .bind(p.key())
    .bind(&profile.provider_id)
    .fetch_optional(&state.pool)
    .await?;

    // 2) Fall back to email — link the identity to the existing account. The
    //    provider vouched for the address, so the account becomes verified.
    if row.is_none() && !email.is_empty() {
        let existing: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
        if let Some(uid) = existing {
            row = Some(
                sqlx::query(&format!(
                    r#"UPDATE "User"
                       SET "oauthProvider" = $1,
                           "oauthId" = $2,
                           "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()),
                           "updatedAt" = now()
                       WHERE "id" = $3
                       RETURNING {USER_COLS}"#
                ))
                .bind(p.key())
                .bind(&profile.provider_id)
                .bind(&uid)
                .fetch_one(&state.pool)
                .await?,
            );
        }
    }

    // 3) Brand-new user. OAuth accounts are verified at creation; the first
    //    account on an install is auto-approved so a fresh self-host is
    //    usable, everyone else follows REQUIRE_SIGNUP_APPROVAL. `isAdmin` is
    //    never granted at signup — instance admin lives in the operator portal.
    let row = match row {
        Some(r) => r,
        None => {
            let existing_count: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "User""#)
                .fetch_one(&state.pool)
                .await?;
            let require_approval = env_opt("REQUIRE_SIGNUP_APPROVAL").as_deref() == Some("true");
            let auto_approve = existing_count == 0 || !require_approval;
            let id = gen_id();
            let created = sqlx::query(&format!(
                r#"INSERT INTO "User"
                   ("id","email","passwordHash","displayName","oauthProvider","oauthId",
                    "emailVerifiedAt","isAdmin","approvalStatus","approvedAt","createdAt","updatedAt")
                   VALUES ($1,$2,NULL,$3,$4,$5,now(),false,
                           (CASE WHEN $6::boolean THEN 'approved' ELSE 'pending' END)::"UserApprovalStatus",
                           CASE WHEN $6::boolean THEN now() ELSE NULL END, now(), now())
                   RETURNING {USER_COLS}"#
            ))
            .bind(&id)
            .bind(&email)
            .bind(profile.display_name.as_deref())
            .bind(p.key())
            .bind(&profile.provider_id)
            .bind(auto_approve)
            .fetch_one(&state.pool)
            .await?;
            audit(state, Some(&id), "SIGNUP", meta, None).await;
            created
        }
    };

    // Gate OAuth exactly like the password login.
    let user = gate_user(state, &row, meta).await?;

    // ensurePersonalWorkspace + startTrial (v2's helper does both).
    ensure_personal_workspace(state, &user.id, &user.email, user.display_name.as_deref()).await;
    audit(state, Some(&user.id), "LOGIN", meta, None).await;
    issue_tokens(state, &user.id, &user.email, meta).await
}

/// v1 `AuthService.claimConnectionInvites` — pending invites addressed to this
/// mailbox become memberships on first sign-in. Best effort: a claim failure
/// must never prevent login. (The OAuth path does not call this; v1 only runs
/// it from `issueSessionForUser`, which is the SSO path.)
async fn claim_connection_invites(state: &AppState, user_id: &str, email: &str) {
    let norm = email.trim().to_lowercase();
    let Ok(rows) = sqlx::query(
        r#"SELECT "id","connectionId","role"::text AS "role"
           FROM "ConnectionInvite" WHERE "email" = $1 AND "status" = 'PENDING'"#,
    )
    .bind(&norm)
    .fetch_all(&state.pool)
    .await
    else {
        return;
    };
    for r in rows {
        let (Ok(inv_id), Ok(conn_id), Ok(role)) = (
            r.try_get::<String, _>("id"),
            r.try_get::<String, _>("connectionId"),
            r.try_get::<String, _>("role"),
        ) else {
            continue;
        };
        let ok = sqlx::query(
            r#"INSERT INTO "ConnectionMember" ("id","connectionId","userId","role","createdAt")
               VALUES ($1,$2,$3,$4::"Role",now())
               ON CONFLICT ("connectionId","userId") DO UPDATE SET "role" = EXCLUDED."role""#,
        )
        .bind(gen_id())
        .bind(&conn_id)
        .bind(user_id)
        .bind(&role)
        .execute(&state.pool)
        .await
        .is_ok();
        if ok {
            let _ = sqlx::query(
                r#"UPDATE "ConnectionInvite"
                   SET "status" = 'ACCEPTED', "acceptedById" = $1, "acceptedAt" = now(), "updatedAt" = now()
                   WHERE "id" = $2"#,
            )
            .bind(user_id)
            .bind(&inv_id)
            .execute(&state.pool)
            .await;
        }
    }
}

// ---------------------------------------------------------------------------
// SSO — issuer metadata (OIDC discovery), cached 10 minutes like v1
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct IssuerMeta {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
}

fn meta_cache() -> &'static Mutex<HashMap<String, (Instant, IssuerMeta)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, IssuerMeta)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

const META_TTL_SECS: u64 = 10 * 60;

async fn fetch_metadata(state: &AppState, issuer_url: &str) -> ApiResult<IssuerMeta> {
    if let Ok(map) = meta_cache().lock() {
        if let Some((at, data)) = map.get(issuer_url) {
            if at.elapsed().as_secs() < META_TTL_SECS {
                return Ok(data.clone());
            }
        }
    }
    // Both an issuer URL and a ready-made discovery URL are accepted.
    let discovery = if issuer_url.ends_with("/.well-known/openid-configuration") {
        issuer_url.to_string()
    } else {
        format!("{}/.well-known/openid-configuration", issuer_url.trim_end_matches('/'))
    };
    let res = state
        .http
        .get(&discovery)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| ApiError::bad(format!("OIDC discovery failed for {discovery}: {e}")))?;
    let status = res.status();
    if !status.is_success() {
        return Err(ApiError::bad(format!(
            "OIDC discovery failed ({}) for {discovery}",
            status.as_u16()
        )));
    }
    let raw = res
        .bytes()
        .await
        .map_err(|e| ApiError::bad(format!("OIDC discovery failed for {discovery}: {e}")))?;
    let j: Value = serde_json::from_slice(&raw)
        .map_err(|_| ApiError::bad("IdP discovery doc missing required fields"))?;
    let (Some(issuer), Some(authorization_endpoint), Some(token_endpoint)) = (
        j.get("issuer").and_then(|v| v.as_str()),
        j.get("authorization_endpoint").and_then(|v| v.as_str()),
        j.get("token_endpoint").and_then(|v| v.as_str()),
    ) else {
        return Err(ApiError::bad("IdP discovery doc missing required fields"));
    };
    let data = IssuerMeta {
        issuer: issuer.to_string(),
        authorization_endpoint: authorization_endpoint.to_string(),
        token_endpoint: token_endpoint.to_string(),
    };
    if let Ok(mut map) = meta_cache().lock() {
        map.insert(issuer_url.to_string(), (Instant::now(), data.clone()));
    }
    Ok(data)
}

// ---------------------------------------------------------------------------
// SSO admin endpoints (workspace owner only)
// ---------------------------------------------------------------------------

async fn require_workspace_owner(state: &AppState, user_id: &str, workspace_id: &str) -> ApiResult<()> {
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Workspace" WHERE "id" = $1"#)
        .bind(workspace_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    // v1 answers 403 for both cases (not 404) so the endpoint can't be used to
    // probe which workspace ids exist.
    let Some(owner) = owner else {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Workspace not found"));
    };
    if owner != user_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the workspace owner can manage SSO",
        ));
    }
    Ok(())
}

/// v1 `SsoService.getConfig` — never returns the secret, only whether one is set.
async fn sso_config_dto(state: &AppState, workspace_id: &str) -> ApiResult<Value> {
    let row = sqlx::query(
        r#"SELECT "enabled","issuerUrl","clientId","allowedDomains","autoProvision",
                  (octet_length("clientSecretCt") > 0) AS "hasSecret"
           FROM "WorkspaceSso" WHERE "workspaceId" = $1"#,
    )
    .bind(workspace_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(r) = row else { return Ok(Value::Null) };
    Ok(json!({
        "enabled": r.try_get::<bool, _>("enabled").unwrap_or(false),
        "issuerUrl": r.try_get::<String, _>("issuerUrl").unwrap_or_default(),
        "clientId": r.try_get::<String, _>("clientId").unwrap_or_default(),
        "allowedDomains": r.try_get::<Option<String>, _>("allowedDomains").ok().flatten(),
        "autoProvision": r.try_get::<bool, _>("autoProvision").unwrap_or(true),
        "hasSecret": r.try_get::<Option<bool>, _>("hasSecret").ok().flatten().unwrap_or(false),
    }))
}

async fn sso_get_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_workspace_owner(&state, &user.id, &workspace_id).await?;
    Ok(Json(sso_config_dto(&state, &workspace_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SsoConfigBody {
    #[serde(default)]
    issuer_url: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    allowed_domains: Option<String>,
    #[serde(default)]
    auto_provision: Option<bool>,
}

async fn sso_upsert_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<String>,
    Json(body): Json<SsoConfigBody>,
) -> ApiResult<Json<Value>> {
    require_workspace_owner(&state, &user.id, &workspace_id).await?;

    // v1's global ValidationPipe runs before the handler: `SsoConfigDto` is
    // `@IsString() @Length(10,500) issuerUrl`, `@Length(1,500) clientId`, and
    // optional `@Length(0,500)` strings for the secret / allowed domains.
    let issuer_url = body.issuer_url.unwrap_or_default();
    let client_id = body.client_id.unwrap_or_default();
    let len = |s: &str| s.chars().count();
    if !(10..=500).contains(&len(&issuer_url)) {
        return Err(ApiError::bad(
            "issuerUrl must be longer than or equal to 10 and shorter than or equal to 500 characters",
        ));
    }
    if !(1..=500).contains(&len(&client_id)) {
        return Err(ApiError::bad(
            "clientId must be longer than or equal to 1 and shorter than or equal to 500 characters",
        ));
    }
    if body.client_secret.as_deref().map(|s| len(s) > 500).unwrap_or(false) {
        return Err(ApiError::bad("clientSecret must be shorter than or equal to 500 characters"));
    }
    if body.allowed_domains.as_deref().map(|s| len(s) > 500).unwrap_or(false) {
        return Err(ApiError::bad("allowedDomains must be shorter than or equal to 500 characters"));
    }
    if !issuer_url.starts_with("https://") {
        return Err(ApiError::bad("Issuer URL must be https://"));
    }

    let existing = sqlx::query(
        r#"SELECT "clientSecretCt","enabled","autoProvision","issuerUrl"
           FROM "WorkspaceSso" WHERE "workspaceId" = $1"#,
    )
    .bind(&workspace_id)
    .fetch_optional(&state.pool)
    .await?;

    // A secret is required to create; on update an absent one means "unchanged".
    let new_secret = body.client_secret.as_deref().filter(|s| !s.trim().is_empty());
    let secret_ct: Vec<u8> = match (new_secret, existing.as_ref()) {
        (Some(plain), _) => {
            let crypto = state
                .crypto
                .as_ref()
                .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY is not configured"))?;
            // Same envelope as connection credentials; stored as UTF-8 bytes of
            // the `v2:local:...` string (v1 does the identical thing).
            crypto
                .encrypt(plain, &format!("sso:{workspace_id}"))
                .map_err(|e| ApiError::internal(e.to_string()))?
                .into_bytes()
        }
        (None, Some(row)) => row.try_get::<Vec<u8>, _>("clientSecretCt").unwrap_or_default(),
        (None, None) => {
            return Err(ApiError::bad("Client secret is required for new SSO configs"));
        }
    };

    // v1's `?? existing ?? default` chain — note `allowedDomains` is NOT
    // sticky: omitting it clears the restriction.
    let enabled = body
        .enabled
        .or_else(|| existing.as_ref().and_then(|r| r.try_get::<bool, _>("enabled").ok()))
        .unwrap_or(false);
    let auto_provision = body
        .auto_provision
        .or_else(|| existing.as_ref().and_then(|r| r.try_get::<bool, _>("autoProvision").ok()))
        .unwrap_or(true);

    sqlx::query(
        r#"INSERT INTO "WorkspaceSso"
           ("id","workspaceId","issuerUrl","clientId","clientSecretCt","enabled","allowedDomains",
            "autoProvision","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
           ON CONFLICT ("workspaceId") DO UPDATE SET
             "issuerUrl" = EXCLUDED."issuerUrl",
             "clientId" = EXCLUDED."clientId",
             "clientSecretCt" = EXCLUDED."clientSecretCt",
             "enabled" = EXCLUDED."enabled",
             "allowedDomains" = EXCLUDED."allowedDomains",
             "autoProvision" = EXCLUDED."autoProvision",
             "updatedAt" = now()"#,
    )
    .bind(gen_id())
    .bind(&workspace_id)
    .bind(&issuer_url)
    .bind(&client_id)
    .bind(secret_ct.as_slice())
    .bind(enabled)
    .bind(body.allowed_domains.as_deref())
    .bind(auto_provision)
    .execute(&state.pool)
    .await?;

    // Invalidate the discovery cache so a corrected issuer takes effect now.
    if let Ok(mut map) = meta_cache().lock() {
        map.remove(&issuer_url);
        if let Some(row) = existing.as_ref() {
            if let Ok(old) = row.try_get::<String, _>("issuerUrl") {
                map.remove(&old);
            }
        }
    }
    Ok(Json(sso_config_dto(&state, &workspace_id).await?))
}

async fn sso_disable(
    State(state): State<AppState>,
    user: AuthUser,
    Path(workspace_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_workspace_owner(&state, &user.id, &workspace_id).await?;
    sqlx::query(r#"UPDATE "WorkspaceSso" SET "enabled" = false, "updatedAt" = now() WHERE "workspaceId" = $1"#)
        .bind(&workspace_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// SSO login flow
// ---------------------------------------------------------------------------

/// Workspace + its SSO row, only when SSO is switched on for it.
struct SsoWorkspace {
    id: String,
    owner_id: String,
    issuer_url: String,
    client_id: String,
    client_secret_ct: Vec<u8>,
    allowed_domains: Option<String>,
    auto_provision: bool,
}

async fn load_sso_workspace(state: &AppState, slug: &str) -> ApiResult<SsoWorkspace> {
    let row = sqlx::query(
        r#"SELECT w."id", w."ownerId", s."issuerUrl", s."clientId", s."clientSecretCt",
                  s."allowedDomains", s."autoProvision", s."enabled"
           FROM "Workspace" w
           JOIN "WorkspaceSso" s ON s."workspaceId" = w."id"
           WHERE w."slug" = $1"#,
    )
    .bind(slug)
    .fetch_optional(&state.pool)
    .await?;
    // v1: `if (!ws?.sso?.enabled) throw new NotFoundException(...)`.
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "SSO not configured for this workspace");
    let row = row.ok_or_else(not_found)?;
    // `enabled` decides whether an attacker-supplied IdP may speak at all —
    // a decode error must not read as "enabled".
    let enabled: bool = row.try_get("enabled").map_err(|e| ApiError::internal(e.to_string()))?;
    if !enabled {
        return Err(not_found());
    }
    Ok(SsoWorkspace {
        id: row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?,
        owner_id: row.try_get("ownerId").map_err(|e| ApiError::internal(e.to_string()))?,
        issuer_url: row.try_get("issuerUrl").map_err(|e| ApiError::internal(e.to_string()))?,
        client_id: row.try_get("clientId").map_err(|e| ApiError::internal(e.to_string()))?,
        client_secret_ct: row
            .try_get("clientSecretCt")
            .map_err(|e| ApiError::internal(e.to_string()))?,
        allowed_domains: row.try_get("allowedDomains").ok().flatten(),
        auto_provision: row.try_get("autoProvision").unwrap_or(true),
    })
}

async fn sso_start(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Response> {
    let ws = load_sso_workspace(&state, &slug).await?;
    let meta = fetch_metadata(&state, &ws.issuer_url).await?;
    let redirect_uri = sso_callback_url(&slug)
        .ok_or_else(|| ApiError::internal("OAUTH_CALLBACK_BASE_URL is not configured"))?;

    let st = rand_state();
    let nonce = rand_state();
    // `new URL(...); searchParams.set(...)` — keep any query the IdP's
    // authorization endpoint already carries.
    let sep = if meta.authorization_endpoint.contains('?') { '&' } else { '?' };
    let url = format!(
        "{}{sep}client_id={}&response_type=code&scope={}&redirect_uri={}&state={}&nonce={}",
        meta.authorization_endpoint,
        encode_uri_component(&ws.client_id),
        encode_uri_component("openid email profile"),
        encode_uri_component(&redirect_uri),
        encode_uri_component(&st),
        encode_uri_component(&nonce),
    );
    Ok(redirect(
        &url,
        vec![
            short_cookie(&state, &format!("{SSO_STATE_PREFIX}{slug}"), &st, STATE_TTL_SECS),
            short_cookie(&state, &format!("{SSO_NONCE_PREFIX}{slug}"), &nonce, STATE_TTL_SECS),
        ],
    ))
}

async fn sso_callback(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(q): Query<CallbackQuery>,
) -> Response {
    let base = &cfg().frontend_origin;
    let state_cookie = format!("{SSO_STATE_PREFIX}{slug}");
    let nonce_cookie = format!("{SSO_NONCE_PREFIX}{slug}");
    let expected_state = crate::cookie_from_header(&headers, &state_cookie).unwrap_or_default();
    let expected_nonce = crate::cookie_from_header(&headers, &nonce_cookie).unwrap_or_default();
    // Cleared immediately — they're single-use.
    let mut cookies = vec![clear_cookie(&state, &state_cookie), clear_cookie(&state, &nonce_cookie)];

    let meta = req_meta(&headers);
    match sso_complete_login(
        &state,
        &slug,
        q.code.as_deref().unwrap_or(""),
        q.state.as_deref().unwrap_or(""),
        &expected_state,
        &expected_nonce,
        &meta,
    )
    .await
    {
        Ok((access, refresh, expires_at)) => {
            cookies.push(refresh_cookie_lax(&state, &refresh, expires_at));
            redirect(
                &format!(
                    "{base}{}#accessToken={}",
                    cfg().success_redirect,
                    encode_uri_component(&access)
                ),
                cookies,
            )
        }
        Err(e) => {
            // Generic code in the URL plus a truncated reason, as v1 does.
            let detail: String = e.message.chars().take(200).collect();
            redirect(
                &format!("{base}/login?error=sso&detail={}", encode_uri_component(&detail)),
                cookies,
            )
        }
    }
}

async fn sso_available(State(state): State<AppState>, Path(slug): Path<String>) -> ApiResult<Json<Value>> {
    // Reports false rather than 404ing — the login page polls this on every
    // load and should just not offer the SSO button.
    let enabled: Option<bool> = sqlx::query_scalar(
        r#"SELECT s."enabled" FROM "Workspace" w
           JOIN "WorkspaceSso" s ON s."workspaceId" = w."id"
           WHERE w."slug" = $1"#,
    )
    .bind(&slug)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    Ok(Json(json!({ "available": enabled.unwrap_or(false) })))
}

/// v1 `SsoService.completeLogin`.
async fn sso_complete_login(
    state: &AppState,
    slug: &str,
    code: &str,
    returned_state: &str,
    expected_state: &str,
    expected_nonce: &str,
    meta: &crate::ReqMeta,
) -> ApiResult<(String, String, chrono::NaiveDateTime)> {
    if code.is_empty() {
        return Err(ApiError::bad("Missing code"));
    }
    // A missing cookie leaves `expected_state` empty, which can never match a
    // returned state — the callback is rejected, as it must be.
    if returned_state.is_empty() || !ct_eq(returned_state, expected_state) {
        return Err(ApiError::unauthorized("SSO state mismatch (possible CSRF)"));
    }
    let ws = load_sso_workspace(state, slug).await?;
    let meta_doc = fetch_metadata(state, &ws.issuer_url).await?;

    // Stored envelope: new rows are UTF-8 bytes of the `v2:` envelope string,
    // historic rows are raw base64 bytes of the old single-key ciphertext.
    let as_utf8 = String::from_utf8_lossy(&ws.client_secret_ct).to_string();
    let envelope = if as_utf8.starts_with("v2:") {
        as_utf8
    } else {
        base64::engine::general_purpose::STANDARD.encode(&ws.client_secret_ct)
    };
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY is not configured"))?;
    let client_secret = crypto
        .decrypt(&envelope, &format!("sso:{}", ws.id))
        .map_err(|e| ApiError::internal(format!("SSO client secret could not be decrypted: {e}")))?;

    let redirect_uri = sso_callback_url(slug)
        .ok_or_else(|| ApiError::internal("OAUTH_CALLBACK_BASE_URL is not configured"))?;
    let body = form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri.as_str()),
        ("client_id", ws.client_id.as_str()),
        ("client_secret", client_secret.as_str()),
    ]);
    let res = state
        .http
        .post(&meta_doc.token_endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("SSO token exchange failed: {e}");
            ApiError::unauthorized("SSO token exchange failed")
        })?;
    let status = res.status();
    let raw = res.bytes().await.unwrap_or_default();
    if !status.is_success() {
        tracing::warn!(
            "SSO token exchange failed: {} {}",
            status.as_u16(),
            String::from_utf8_lossy(&raw).chars().take(500).collect::<String>()
        );
        return Err(ApiError::unauthorized("SSO token exchange failed"));
    }
    let token_json: Value = serde_json::from_slice(&raw)
        .map_err(|_| ApiError::unauthorized("IdP did not return an id_token"))?;
    let id_token = token_json
        .get("id_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::unauthorized("IdP did not return an id_token"))?;

    // --- id_token: decoded, NOT signature-verified. See the module docs; this
    // is v1's documented decision, and changing it here would make the two
    // stacks disagree about which IdPs work.
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        return Err(ApiError::unauthorized("Malformed id_token"));
    }
    let payload = b64url_decode(parts[1]).ok_or_else(|| ApiError::unauthorized("Unparseable id_token payload"))?;
    let claims: Value = serde_json::from_slice(&payload)
        .map_err(|_| ApiError::unauthorized("Unparseable id_token payload"))?;

    let iss = claims.get("iss").and_then(|v| v.as_str());
    if iss != Some(meta_doc.issuer.as_str()) && iss != Some(ws.issuer_url.as_str()) {
        return Err(ApiError::unauthorized("id_token issuer mismatch"));
    }
    let aud_ok = match claims.get("aud") {
        Some(Value::String(s)) => s == &ws.client_id,
        Some(Value::Array(a)) => a.iter().any(|v| v.as_str() == Some(ws.client_id.as_str())),
        _ => false,
    };
    if !aud_ok {
        return Err(ApiError::unauthorized("id_token audience mismatch"));
    }
    if let Some(exp) = claims.get("exp").and_then(|v| v.as_i64()) {
        if exp * 1000 < chrono::Utc::now().timestamp_millis() {
            return Err(ApiError::unauthorized("id_token expired"));
        }
    }
    let nonce = claims.get("nonce").and_then(|v| v.as_str());
    if !expected_nonce.is_empty() {
        if let Some(n) = nonce {
            if !ct_eq(n, expected_nonce) {
                return Err(ApiError::unauthorized("id_token nonce mismatch"));
            }
        }
    }

    let email = claims
        .get("email")
        .and_then(|v| v.as_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| ApiError::unauthorized("IdP did not return an email claim"))?;

    if let Some(allowed) = ws.allowed_domains.as_deref() {
        let list: Vec<String> = allowed
            .split(',')
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty())
            .collect();
        let domain = email.split('@').nth(1).unwrap_or("").to_string();
        if !list.is_empty() && !list.contains(&domain) {
            return Err(ApiError::unauthorized(format!(
                "Email domain {domain} is not allowed for this workspace"
            )));
        }
    }

    // SECURITY (v1's comment, reproduced because the rule is the whole point):
    // the issuer is supplied by the workspace owner, so the IdP is trusted only
    // to speak for people who ALREADY belong to this workspace. Resolving an
    // arbitrary account by email would let any owner point SSO at an IdP they
    // run, assert someone else's address and receive a session for that
    // account — bypassing password, 2FA, suspension and approval.
    let existing = sqlx::query(&format!(r#"SELECT {USER_COLS} FROM "User" WHERE "email" = $1"#))
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;

    let row = match existing {
        Some(r) => {
            let uid: String = r.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
            let member: Option<String> = sqlx::query_scalar(
                r#"SELECT "id" FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2"#,
            )
            .bind(&ws.id)
            .bind(&uid)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
            if ws.owner_id != uid && member.is_none() {
                return Err(ApiError::unauthorized(
                    "This account is not a member of this workspace. Ask the owner to invite you first.",
                ));
            }
            let verified: Option<chrono::NaiveDateTime> = r
                .try_get("emailVerifiedAt")
                .map_err(|e| ApiError::internal(e.to_string()))?;
            if verified.is_none() {
                sqlx::query(&format!(
                    r#"UPDATE "User" SET "emailVerifiedAt" = now(), "updatedAt" = now()
                       WHERE "id" = $1 RETURNING {USER_COLS}"#
                ))
                .bind(&uid)
                .fetch_one(&state.pool)
                .await?
            } else {
                r
            }
        }
        None => {
            if !ws.auto_provision {
                return Err(ApiError::unauthorized(
                    "No account for this email. Ask your workspace owner to invite you.",
                ));
            }
            // No `approvalStatus` here on purpose: v1 lets Prisma's default
            // (`pending`) stand and the gate below only refuses `rejected`.
            sqlx::query(&format!(
                r#"INSERT INTO "User" ("id","email","passwordHash","displayName","emailVerifiedAt","createdAt","updatedAt")
                   VALUES ($1,$2,NULL,$3,now(),now(),now())
                   RETURNING {USER_COLS}"#
            ))
            .bind(gen_id())
            .bind(&email)
            .bind(claims.get("name").and_then(|v| v.as_str()))
            .fetch_one(&state.pool)
            .await?
        }
    };

    let user_id: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let user_email: String = row.try_get("email").map_err(|e| ApiError::internal(e.to_string()))?;
    let display_name: Option<String> = row.try_get("displayName").ok().flatten();

    // Never let SSO hand out a session for a suspended/rejected account —
    // `issueSessionForUser` skips the checks `login()` performs. Note this is
    // NOT the full password-login gate: v1 deliberately allows `pending` here.
    let suspended: Option<chrono::NaiveDateTime> = row
        .try_get("suspendedAt")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if suspended.is_some() {
        return Err(ApiError::unauthorized(
            "Account suspended. Contact support to restore access.",
        ));
    }
    let approval: String = row
        .try_get("approvalStatus")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if approval == "rejected" {
        return Err(ApiError::unauthorized("Account is not approved."));
    }

    // SSO implies "you belong here".
    sqlx::query(
        r#"INSERT INTO "WorkspaceMember" ("id","workspaceId","userId","role","createdAt")
           VALUES ($1,$2,$3,'VIEWER',now())
           ON CONFLICT ("workspaceId","userId") DO NOTHING"#,
    )
    .bind(gen_id())
    .bind(&ws.id)
    .bind(&user_id)
    .execute(&state.pool)
    .await?;

    // Guarantee the personal workspace so downstream code that assumes it
    // doesn't blow up. (v2's helper also seeds the FREE trial subscription;
    // v1's SSO path leaves that to the first billing read.)
    ensure_personal_workspace(state, &user_id, &user_email, display_name.as_deref()).await;

    // v1 `AuthService.issueSessionForUser`.
    audit(state, Some(&user_id), "LOGIN", meta, None).await;
    claim_connection_invites(state, &user_id, &user_email).await;
    issue_tokens(state, &user_id, &user_email, meta).await
}
