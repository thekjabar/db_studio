//! Query Schema v2 â€” Rust/axum reimplementation of the v1 hot path.
//!
//! Shares the same Postgres as v1 (`DATABASE_URL`), verifies the same argon2id
//! password hashes, and returns a server-measured `tookMs` on the data endpoints
//! so the Rust stack can be benchmarked against the Node/Nest one.
//!
//! Everything uses the sqlx *runtime* query API (no `query!` macro), so the
//! binary compiles without a database connection at build time.

mod admin;
mod ai;
mod audit_log;
mod billing;
mod conns;
mod misc;
mod opsadmin;
mod totp;
mod importer;
mod oauth;
mod queue;
mod realtime;
mod tunnel;
mod backup;
mod collab;
mod crypto;
mod datamove;
mod dbadmin;
mod docs;
mod ops;
mod permissions;
mod query_tools;
mod sharing;
mod workspaces;

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use axum::body::{to_bytes, Body};
use axum::extract::{FromRequestParts, Request};
use axum::middleware::{self, Next};
use axum::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, Connection, Executor, PgConnection, PgPool, Row, TypeInfo};
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    jwt_secret: String,
    /// Access-token lifetime in seconds.
    jwt_ttl: i64,
    /// Hard cap on rows returned by row/query endpoints.
    max_rows: i64,
    /// Present when ENCRYPTION_KEY is set â€” enables decrypting v1 connection
    /// credentials to reach target databases. None = app-DB-only mode.
    crypto: Option<crypto::Crypto>,
    /// HTTP client + origin for the strangler proxy to the v1 Node API.
    http: reqwest::Client,
    v1_origin: String,
    /// Refresh-token lifetime in seconds (JWT_REFRESH_TTL, default 7d).
    refresh_ttl_secs: i64,
    /// Refresh-cookie attributes (mirror v1's setRefreshCookie).
    cookie_domain: String,
    cookie_secure: bool,
    /// Block unverified users at login (matches v1 requireEmailVerification).
    require_email_verification: bool,
    /// Per-email failed-login lockout (in-memory; v2 is single-pod â€” matches
    /// v1's documented Map fallback when Redis is absent).
    cooldown: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, CooldownEntry>>>,
    /// Mail via the Resend HTTP API (prod sets RESEND_API_KEY/RESEND_FROM).
    /// None = mail disabled; links are logged instead, as v1 does in dev.
    resend_key: Option<String>,
    mail_from: Option<String>,
    /// Base URL used to build verification/reset links (v1's APP_BASE_URL,
    /// falling back to the first FRONTEND_ORIGIN).
    app_base_url: String,
}

#[derive(Clone, Copy)]
struct CooldownEntry {
    failures: u32,
    reset_at: i64,
    locked_until: Option<i64>,
}

/// Parse a `<n><unit>` TTL (s/m/h/d) to seconds; default 7 days.
fn parse_ttl_secs(s: &str) -> i64 {
    let s = s.trim();
    let (num, mult) = if let Some(n) = s.strip_suffix('d') {
        (n, 86_400)
    } else if let Some(n) = s.strip_suffix('h') {
        (n, 3_600)
    } else if let Some(n) = s.strip_suffix('m') {
        (n, 60)
    } else if let Some(n) = s.strip_suffix('s') {
        (n, 1)
    } else {
        return 7 * 86_400;
    };
    num.trim().parse::<i64>().map(|n| n * mult).unwrap_or(7 * 86_400)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("queryschema_v2=info,tower_http=info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let jwt_secret = std::env::var("V2_JWT_SECRET")
        .or_else(|_| std::env::var("JWT_ACCESS_SECRET"))
        .expect("V2_JWT_SECRET (or JWT_ACCESS_SECRET) is required");
    let jwt_ttl = std::env::var("V2_JWT_TTL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);
    let max_rows = std::env::var("V2_MAX_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3010);
    let max_conns = std::env::var("V2_DB_POOL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    let pool = PgPoolOptions::new()
        .max_connections(max_conns)
        .connect(&database_url)
        .await?;

    let crypto = crypto::Crypto::from_env().ok();
    if crypto.is_some() {
        tracing::info!("ENCRYPTION_KEY loaded â€” target-database connections enabled");
    }
    let v1_origin = std::env::var("V1_ORIGIN").unwrap_or_else(|_| "http://dbdash-api:3000".into());
    let http = reqwest::Client::builder()
        .build()
        .expect("reqwest client");
    let refresh_ttl_secs = parse_ttl_secs(&std::env::var("JWT_REFRESH_TTL").unwrap_or_else(|_| "7d".into()));
    let cookie_domain = std::env::var("COOKIE_DOMAIN").unwrap_or_else(|_| ".queryschema.com".into());
    let cookie_secure = std::env::var("COOKIE_SECURE").map(|v| v != "false").unwrap_or(true);
    // Default true â€” queryschema prod has email enabled, so v1 requires
    // verification. Only an explicit "false" opens login to unverified users.
    let require_email_verification = std::env::var("REQUIRE_EMAIL_VERIFICATION")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);
    let cooldown = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let resend_key = std::env::var("RESEND_API_KEY").ok().filter(|v| !v.trim().is_empty());
    let mail_from = std::env::var("RESEND_FROM")
        .or_else(|_| std::env::var("SMTP_FROM"))
        .ok()
        .filter(|v| !v.trim().is_empty());
    let app_base_url = std::env::var("APP_BASE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            std::env::var("FRONTEND_ORIGIN")
                .ok()
                .and_then(|v| v.split(',').next().map(|s| s.trim().to_string()))
                .filter(|v| !v.is_empty())
        })
        .unwrap_or_else(|| "https://queryschema.com".into());
    if resend_key.is_some() && mail_from.is_some() {
        tracing::info!("mail enabled (Resend) â€” verification + reset emails sent natively");
    } else {
        tracing::warn!("mail NOT configured â€” verification/reset links will only be logged");
    }
    let state = AppState {
        pool, jwt_secret, jwt_ttl, max_rows, crypto, http, v1_origin,
        refresh_ttl_secs, cookie_domain, cookie_secure, require_email_verification, cooldown,
        resend_key, mail_from, app_base_url,
    };

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "service": "queryschema-v2" })) }))
        .route("/api/health/db", get(health_db))
        // --- Rust hot path: v1's EXACT paths, so the perf-critical calls run
        //     in Rust. Everything else falls through to the v1 proxy below. ---
        // Auth, ported from v1 (see the compatibility contract above). The
        // remaining /api/auth/* routes (signup, 2FA, OAuth, SSO, email flows,
        // sessions) still fall through to the v1 proxy.
        .route("/api/auth/signup", post(signup))
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(auth_refresh))
        .route("/api/auth/logout", post(auth_logout))
        .route("/api/auth/change-password", post(change_password))
        .route("/api/auth/verify-email", post(verify_email))
        .route("/api/auth/complete-password-reset", post(complete_password_reset))
        .route("/api/auth/request-password-reset", post(request_password_reset))
        .route("/api/auth/resend-verification", post(resend_verification))
        .route("/api/auth/sessions", get(sessions_list).delete(sessions_revoke_all))
        .route("/api/auth/sessions/:id", delete(session_revoke))
        .route("/api/connections/:id/row-filters", get(row_filters_list).post(row_filter_create))
        .route("/api/connections/:id/row-filters/:filterId", delete(row_filter_delete))
        .route("/api/connections/:id/column-masks", get(column_masks_list).post(column_mask_create))
        .route("/api/connections/:id/column-masks/:maskId", delete(column_mask_delete))
        .route("/api/api-keys", get(api_keys_list).post(api_key_create))
        .route("/api/api-keys/:id", delete(api_key_delete))
        .route("/api/api-keys/:id/revoke", post(api_key_revoke))
        .route("/api/users/me", get(v1_me).patch(v1_update_me))
        .route("/api/workspaces", get(v1_workspaces_list))
        // Create/update carry v1-only business logic (SSRF host guard,
        // assertOwnedAgent, viaAgent/agentId persistence) â€” proxy them to v1 so
        // agent connections are validated + stored exactly as in v1. Reads +
        // delete stay in Rust.
        // create/update now live in conns.rs (SSRF guard + agent ownership +
        // quota + credential encryption ported), so they no longer proxy.
        .route("/api/connections", get(v1_connections_list))
        .route(
            "/api/connections/:id",
            get(v1_connection_get).delete(v1_connection_delete),
        )
        .route("/api/connections/:id/test", post(v1_connection_test))
        .route("/api/connections/:id/schemas", get(v1_schemas))
        .route("/api/connections/:id/tables", get(v1_tables))
        .route("/api/connections/:id/tables/:name/columns", get(v1_conn_columns))
        .route("/api/connections/:id/tables/:name/data", get(v1_table_data))
        .route("/api/connections/:id/tables/:name/lookup", get(v1_lookup))
        .route("/api/connections/:id/tables/:name/definition", get(v1_definition))
        .route("/api/snippets", get(snippet_list).post(snippet_create))
        .route("/api/snippets/:id", patch(snippet_update).delete(snippet_delete))
        .route("/api/connections/:id/er", get(v1_er))
        .route("/api/connections/:id/functions", get(v1_functions))
        .route("/api/connections/:id/triggers", get(v1_triggers))
        .route("/api/connections/:id/indexes", get(v1_indexes))
        .route(
            "/api/connections/:id/tables/:name/rows",
            post(row_insert).patch(row_update).delete(row_delete),
        )
        .route("/api/connections/:id/tables/:name/rows/bulk-delete", post(row_bulk_delete))
        .route("/api/connections/:id/tables/:name/rows/bulk-update", post(row_bulk_update))
        .route("/api/connections/:id/query", post(v1_query))
        .route("/api/connections/:id/saved-queries", get(sq_list).post(sq_create))
        .route(
            "/api/connections/:id/saved-queries/:queryId",
            get(sq_get).patch(sq_update).delete(sq_delete),
        )
        // Modules ported from v1. Each owns its full paths; merging keeps them
        // ahead of the strangler fallback below.
        .merge(permissions::routes())
        .merge(workspaces::routes())
        .merge(audit_log::routes())
        .merge(backup::routes())
        .merge(docs::routes())
        .merge(collab::routes())
        .merge(admin::routes())
        .merge(ops::routes())
        .merge(sharing::routes())
        .merge(dbadmin::routes())
        .merge(datamove::routes())
        .merge(query_tools::routes())
        .merge(conns::routes())
        .merge(ai::routes())
        .merge(billing::routes())
        .merge(misc::routes())
        .merge(opsadmin::routes())
        .merge(totp::routes())
        // /agent-ws lives here now. Additive until nginx repoints agents at
        // this container — the registry is per-process in BOTH stacks, so the
        // endpoint must be served by exactly one backend, never split.
        .merge(tunnel::routes())
        // Registers only when this process holds the provider credentials —
        // otherwise the flows keep proxying to v1 rather than half-working.
        .merge(oauth::routes())
        .merge(importer::routes())
        // --- Strangler proxy: every other endpoint â†’ v1 Node API ---
        .fallback(proxy)
        // Agent-backed connections bypass Rust entirely (tunnel lives in v1).
        .layer(middleware::from_fn_with_state(state.clone(), agent_guard))
        // socket.io (/socket.io/*) serving the /realtime namespace.
        .layer(realtime::layer(state.clone()))
        // CORS goes on LAST so it is the OUTERMOST layer — otherwise socket.io
        // answers first and its responses carry no CORS headers at all, which
        // the browser rejects (the frontend is on queryschema.com, the socket
        // on api.queryschema.com).
        //
        // Mirroring the request origin + allow_credentials mirrors v1's gateway
        // (`cors: { origin: true, credentials: true }`). A wildcard origin is
        // NOT usable here: browsers reject `Access-Control-Allow-Origin: *` on
        // any credentialed request, and tower-http panics on Any + credentials.
        .layer(
            CorsLayer::new()
                .allow_origin(tower_http::cors::AllowOrigin::mirror_request())
                .allow_methods(tower_http::cors::AllowMethods::mirror_request())
                .allow_headers(tower_http::cors::AllowHeaders::mirror_request())
                .allow_credentials(true),
        )
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("queryschema-v2 listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct ApiError {
    status: StatusCode,
    message: String,
    /// Optional full JSON body (for v1-shaped coded errors like ACCOUNT_PENDING).
    body: Option<Value>,
}
impl ApiError {
    fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self { status, message: msg.into(), body: None }
    }
    fn bad(msg: impl Into<String>) -> Self { Self::new(StatusCode::BAD_REQUEST, msg) }
    fn unauthorized(msg: impl Into<String>) -> Self { Self::new(StatusCode::UNAUTHORIZED, msg) }
    fn internal(msg: impl Into<String>) -> Self { Self::new(StatusCode::INTERNAL_SERVER_ERROR, msg) }
    /// v1-shaped `{ code, message }` body (login gates, lockout).
    fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> Self {
        let m = msg.into();
        Self { status, message: m.clone(), body: Some(json!({ "code": code, "message": m })) }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // The frontend reads `message` (lib/api.ts: `data?.message`), matching
        // v1's error envelope. Without it every failure renders as axios's
        // generic "Request failed with status code 401" instead of the real
        // reason. `error` is kept alongside for anything still reading it.
        let body = self.body.unwrap_or_else(|| {
            json!({
                "statusCode": self.status.as_u16(),
                "message": self.message,
                "error": self.message,
            })
        });
        (self.status, Json(body)).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // Surface the DB message â€” this is a query tool, the SQL error IS the useful output.
        ApiError::new(StatusCode::BAD_REQUEST, e.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// v1's exact access-token payload: `{sub, email, iat, exp}`, HS256. `email`
/// and `iat` are optional on decode so tokens minted before this port (which
/// carried only sub/exp) keep verifying until they expire.
#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    iat: Option<i64>,
    exp: i64,
}

type HmacSha256 = Hmac<Sha256>;

fn jwt_sign(input: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(input.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn jwt_encode(claims: &Claims, secret: &str) -> anyhow::Result<String> {
    let header = B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = B64.encode(serde_json::to_vec(claims)?);
    let signing_input = format!("{header}.{payload}");
    let sig = jwt_sign(&signing_input, secret);
    Ok(format!("{signing_input}.{sig}"))
}

fn jwt_decode(token: &str, secret: &str) -> anyhow::Result<Claims> {
    let mut parts = token.splitn(3, '.');
    let h = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let p = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let s = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let expected = jwt_sign(&format!("{h}.{p}"), secret);
    if !ct_eq(expected.as_bytes(), s.as_bytes()) {
        anyhow::bail!("bad signature");
    }
    let claims: Claims = serde_json::from_slice(&B64.decode(p)?)?;
    if claims.exp < chrono::Utc::now().timestamp() {
        anyhow::bail!("token expired");
    }
    Ok(claims)
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Authenticated-user extractor: pulls the Bearer token and verifies the JWT.
struct AuthUser {
    id: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::unauthorized("Missing Authorization header"))?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(|| ApiError::unauthorized("Malformed Authorization header"))?;
        let claims = jwt_decode(token, &state.jwt_secret)
            .map_err(|_| ApiError::unauthorized("Invalid or expired token"))?;
        Ok(AuthUser { id: claims.sub })
    }
}

// â”€â”€ auth (ported from v1; MUST stay wire-compatible) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Compatibility contract with the v1 Node API â€” breaking any of these logs every
// live user out, so they are exact by design:
//   * access token: HS256, claims {sub, email, iat, exp}, signed with the same
//     JWT_ACCESS_SECRET, so tokens issued here verify in v1 and vice-versa.
//   * refresh token: an OPAQUE 48-byte base64url string (not a JWT), stored as
//     an unsalted lowercase-hex sha256 in "RefreshToken"."tokenHash" â€” the exact
//     digest v1 writes, so existing rows keep working.
//   * cookie: dbdash_rt, Path=/api/auth, SameSite=Strict, HttpOnly, explicit
//     Domain and absolute Expires (v1 uses Expires, not Max-Age).
//   * rotation + reuse detection: presenting an already-revoked token revokes
//     EVERY live session for that user (v1 treats the whole user as the family).

const REFRESH_COOKIE: &str = "dbdash_rt";
/// v1 argon2-verifies this when the account is missing so the response time
/// doesn't reveal whether an email exists.
const DUMMY_ARGON2: &str = "$argon2id$v=19$m=65536,t=3,p=4$abcdefghijklmnop$abcdefghijklmnopabcdefghijklmnopabcdefghijk";

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn cookie_from_header(parts: &axum::http::HeaderMap, name: &str) -> Option<String> {
    let raw = parts.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k.trim() == name).then(|| v.trim().to_string())
    })
}

fn refresh_cookie(state: &AppState, token: &str, expires: chrono::NaiveDateTime) -> String {
    // Mirrors v1's setRefreshCookie exactly, including Path=/api/auth (so the
    // cookie is NOT sent to ordinary API calls) and Expires rather than Max-Age.
    let mut c = format!(
        "{REFRESH_COOKIE}={token}; Path=/api/auth; HttpOnly; SameSite=Strict; Expires={}",
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

fn clear_refresh_cookie(state: &AppState) -> String {
    let mut c = format!(
        "{REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT"
    );
    if !state.cookie_domain.is_empty() {
        c.push_str(&format!("; Domain={}", state.cookie_domain));
    }
    if state.cookie_secure {
        c.push_str("; Secure");
    }
    c
}

/// Best-effort audit row â€” never fails the request (v1 also swallows these).
async fn audit(state: &AppState, user_id: Option<&str>, action: &str, meta: &ReqMeta, extra: Option<Value>) {
    let _ = sqlx::query(
        r#"INSERT INTO "AuditLog" ("id","userId","action","ip","userAgent","metadata","createdAt")
           VALUES ($1,$2,$3::"AuditAction",$4,$5,$6,now())"#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(action)
    .bind(meta.ip.as_deref())
    .bind(meta.user_agent.as_deref())
    .bind(extra)
    .execute(&state.pool)
    .await;
}

struct ReqMeta {
    ip: Option<String>,
    user_agent: Option<String>,
}

fn req_meta(h: &axum::http::HeaderMap) -> ReqMeta {
    let ip = h
        .get("cf-connecting-ip")
        .or_else(|| h.get("x-forwarded-for"))
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or(v).trim().to_string());
    let user_agent = h
        .get(axum::http::header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    ReqMeta { ip, user_agent }
}

// v1 login cooldown: 3 failures inside 15 min locks the email for 15 min.
const COOLDOWN_WINDOW_SECS: i64 = 15 * 60;
const COOLDOWN_MAX_FAILURES: u32 = 3;
const COOLDOWN_LOCK_SECS: i64 = 15 * 60;

fn cooldown_locked_for(state: &AppState, email: &str) -> Option<i64> {
    let now = chrono::Utc::now().timestamp();
    let map = state.cooldown.lock().ok()?;
    let e = map.get(email)?;
    e.locked_until.filter(|u| *u > now).map(|u| u - now)
}

fn cooldown_record_failure(state: &AppState, email: &str) {
    let now = chrono::Utc::now().timestamp();
    if let Ok(mut map) = state.cooldown.lock() {
        let e = map.entry(email.to_string()).or_insert(CooldownEntry {
            failures: 0,
            reset_at: now + COOLDOWN_WINDOW_SECS,
            locked_until: None,
        });
        if e.reset_at <= now {
            e.failures = 0;
            e.reset_at = now + COOLDOWN_WINDOW_SECS;
        }
        e.failures += 1;
        if e.failures >= COOLDOWN_MAX_FAILURES {
            e.locked_until = Some(now + COOLDOWN_LOCK_SECS);
            e.failures = 0;
        }
    }
}

fn cooldown_record_success(state: &AppState, email: &str) {
    if let Ok(mut map) = state.cooldown.lock() {
        map.remove(email);
    }
}

/// Mint an access token + a fresh opaque refresh token row (v1's issueTokens).
async fn issue_tokens(
    state: &AppState,
    user_id: &str,
    email: &str,
    meta: &ReqMeta,
) -> Result<(String, String, chrono::NaiveDateTime), ApiError> {
    let now = chrono::Utc::now();
    let claims = Claims {
        sub: user_id.to_string(),
        email: Some(email.to_string()),
        iat: Some(now.timestamp()),
        exp: now.timestamp() + state.jwt_ttl,
    };
    let access = jwt_encode(&claims, &state.jwt_secret).map_err(|e| ApiError::internal(e.to_string()))?;

    // 48 random bytes, base64url â€” byte-for-byte the shape v1 issues.
    let raw: String = {
        use rand::RngCore;
        let mut b = [0u8; 48];
        rand::thread_rng().fill_bytes(&mut b);
        B64.encode(b)
    };
    // Prisma's DateTime columns are `timestamp WITHOUT time zone`, which sqlx
    // only binds/decodes as NaiveDateTime — passing a DateTime<Utc> here is a
    // type mismatch that fails the INSERT (i.e. breaks login).
    let expires_at = (now + chrono::Duration::seconds(state.refresh_ttl_secs)).naive_utc();
    sqlx::query(
        r#"INSERT INTO "RefreshToken" ("id","userId","tokenHash","expiresAt","userAgent","ip","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,now())"#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(sha256_hex(&raw))
    .bind(expires_at)
    .bind(meta.user_agent.as_deref())
    .bind(meta.ip.as_deref())
    .execute(&state.pool)
    .await?;
    Ok((access, raw, expires_at))
}

#[derive(Deserialize, Serialize)]
struct LoginBody {
    email: String,
    password: String,
    #[serde(rename = "totpCode", skip_serializing_if = "Option::is_none")]
    totp_code: Option<String>,
}

async fn login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    let email = body.email.trim().to_lowercase();
    let meta = req_meta(&headers);

    if let Some(secs) = cooldown_locked_for(&state, &email) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            format!("Too many failed logins. Try again in {} minute(s).", (secs + 59) / 60),
        ));
    }

    let row = sqlx::query(
        r#"SELECT u."id", u."email", u."passwordHash", u."suspendedAt", u."suspendedReason",
                  u."approvalStatus"::text AS "approvalStatus", u."approvalNote", u."emailVerifiedAt",
                  COALESCE(t."enabled", false) AS "totpEnabled"
           FROM "User" u
           LEFT JOIN "TotpSecret" t ON t."userId" = u."id"
           WHERE u."email" = $1 LIMIT 1"#,
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    // Equalise timing for unknown accounts exactly as v1 does.
    let Some(row) = row else {
        let _ = verify_argon2(&body.password, DUMMY_ARGON2);
        cooldown_record_failure(&state, &email);
        return Err(ApiError::unauthorized("Invalid credentials"));
    };

    let id: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let hash: Option<String> = row.try_get("passwordHash").ok().flatten();
    let ok = match hash.as_deref() {
        Some(h) => verify_argon2(&body.password, h).is_ok(),
        None => {
            // OAuth-only account: still burn the time, still "invalid".
            let _ = verify_argon2(&body.password, DUMMY_ARGON2);
            false
        }
    };
    if !ok {
        audit(&state, Some(&id), "LOGIN_FAILED", &meta, None).await;
        cooldown_record_failure(&state, &email);
        return Err(ApiError::unauthorized("Invalid credentials"));
    }

    // 2FA, verified natively. v1's order: a missing code is rejected before a
    // wrong one, and a wrong code audits LOGIN_FAILED but deliberately does NOT
    // call recordFailure — the lockout counts bad passwords, not bad codes.
    let totp_enabled: bool = row.try_get("totpEnabled").unwrap_or(false);
    if totp_enabled {
        // .filter(non-empty) reproduces JS falsiness on ""
        let Some(code) = body.totp_code.as_deref().filter(|c| !c.is_empty()) else {
            return Err(ApiError::unauthorized("TOTP code required"));
        };
        if !totp::check_user_code(&state, &id, code).await? {
            audit(&state, Some(&id), "LOGIN_FAILED", &meta, None).await;
            return Err(ApiError::unauthorized("Invalid TOTP code"));
        }
    }

    // NOTE: no `.ok().flatten()` on the two gate columns below. That pattern
    // turns a DECODE error into `None`, which here would silently mean "not
    // suspended" / "not verified" — i.e. a type mistake would quietly disable a
    // security check instead of failing loudly. Propagate the error instead.
    let suspended: Option<chrono::NaiveDateTime> =
        row.try_get("suspendedAt").map_err(|e| ApiError::internal(e.to_string()))?;
    if suspended.is_some() {
        let reason: Option<String> = row.try_get("suspendedReason").ok().flatten();
        audit(&state, Some(&id), "LOGIN_SUSPENDED", &meta, None).await;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            reason
                .map(|r| format!("Account suspended: {r}"))
                .unwrap_or_else(|| "Account suspended. Contact support to restore access.".into()),
        ));
    }

    let approval: String = row.try_get("approvalStatus").unwrap_or_else(|_| "approved".into());
    if approval == "pending" {
        audit(&state, Some(&id), "LOGIN_PENDING", &meta, None).await;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Your account is awaiting admin approval. You'll be able to sign in once it's reviewed.",
        ));
    }
    if approval == "rejected" {
        let note: Option<String> = row.try_get("approvalNote").ok().flatten();
        audit(&state, Some(&id), "LOGIN_REJECTED", &meta, None).await;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            note.map(|n| format!("Account not approved: {n}")).unwrap_or_else(|| {
                "Your account was not approved. Contact support if you think this was a mistake.".into()
            }),
        ));
    }

    if state.require_email_verification {
        let verified: Option<chrono::NaiveDateTime> =
            row.try_get("emailVerifiedAt").map_err(|e| ApiError::internal(e.to_string()))?;
        if verified.is_none() {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Verify your email address to sign in."));
        }
    }

    let (access, refresh, expires_at) = issue_tokens(&state, &id, &email, &meta).await?;
    cooldown_record_success(&state, &email);
    audit(&state, Some(&id), "LOGIN", &meta, None).await;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::SET_COOKIE, refresh_cookie(&state, &refresh, expires_at))
        .body(Body::from(serde_json::to_vec(&json!({ "accessToken": access, "userId": id })).unwrap_or_default()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

// â”€â”€ mail (Resend HTTP API â€” prod has RESEND_API_KEY set, no SMTP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// v1's dark email layout, close enough to be visually identical in a client:
/// brand wordmark, intro copy, one accent button, a small note.
fn render_email(title: &str, intro: &str, btn_label: &str, btn_url: &str, note: &str) -> String {
    format!(
        r#"<!doctype html><html><body style="margin:0;padding:24px;background:#0b0f14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#111820;border:1px solid #1e2733;border-radius:14px;padding:28px">
<tr><td style="color:#3ECF8E;font-weight:700;font-size:15px;padding-bottom:18px">Query Schema</td></tr>
<tr><td style="color:#e6e9ef;font-size:20px;font-weight:700;padding-bottom:10px">{}</td></tr>
<tr><td style="color:#95a1b2;font-size:14px;line-height:22px;padding-bottom:22px">{}</td></tr>
<tr><td><a href="{}" style="display:inline-block;background:#3ECF8E;color:#04180f;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:9px">{}</a></td></tr>
<tr><td style="color:#5c6875;font-size:12px;line-height:19px;padding-top:24px">{}</td></tr>
</table></td></tr></table></body></html>"#,
        html_escape(title),
        html_escape(intro),
        html_escape(btn_url),
        html_escape(btn_label),
        html_escape(note)
    )
}

/// Fire-and-forget send through Resend. Returns false when mail isn't
/// configured or the API rejects it â€” callers must stay silent either way so
/// the response never reveals whether an address exists.
async fn send_mail(state: &AppState, to: &str, subject: &str, text: &str, html: &str) -> bool {
    let (Some(key), Some(from)) = (state.resend_key.as_ref(), state.mail_from.as_ref()) else {
        tracing::info!("[dev] mail not configured; would send '{subject}' to {to}");
        return false;
    };
    let payload = json!({ "from": from, "to": [to], "subject": subject, "text": text, "html": html });
    let body = match serde_json::to_vec(&payload) {
        Ok(b) => b,
        Err(_) => return false,
    };
    match state
        .http
        .post("https://api.resend.com/emails")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => true,
        Ok(r) => {
            tracing::warn!("resend rejected mail to {to}: {}", r.status());
            false
        }
        Err(e) => {
            tracing::warn!("resend send failed for {to}: {e}");
            false
        }
    }
}

/// 32 random bytes, base64url â€” the token shape v1 mails out. Stored as sha256.
fn gen_email_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b)
}

/// Issue a verification link (invalidating any outstanding one) and mail it.
async fn issue_verification(state: &AppState, user_id: &str, email: &str) -> Result<(), ApiError> {
    sqlx::query(
        r#"UPDATE "EmailVerification" SET "consumedAt" = now() WHERE "userId" = $1 AND "consumedAt" IS NULL"#,
    )
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    let raw = gen_email_token();
    sqlx::query(
        r#"INSERT INTO "EmailVerification" ("id","userId","tokenSha","expiresAt","createdAt")
           VALUES ($1,$2,$3,now() + interval '24 hours',now())"#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(sha256_hex(&raw))
    .execute(&state.pool)
    .await?;
    let link = format!("{}/auth/verify?token={}", state.app_base_url, urlencode(&raw));
    let text = format!(
        "Click the link below to verify your email address. The link expires in 24 hours.\n\n{link}\n\nIf you didn't sign up for Query Schema, you can ignore this email."
    );
    let html = render_email(
        "Verify your email",
        "Welcome to Query Schema! Confirm your email address to finish setting up your account. This link expires in 24 hours.",
        "Verify email",
        &link,
        "If you didn't sign up for Query Schema, you can safely ignore this email.",
    );
    send_mail(state, email, "Verify your Query Schema email", &text, &html).await;
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

/// Always answers `{ok:true}` â€” never reveals whether the address exists.
async fn resend_verification(State(state): State<AppState>, Json(body): Json<EmailBody>) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    if let Some(row) = sqlx::query(r#"SELECT "id","emailVerifiedAt" FROM "User" WHERE "email" = $1"#)
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?
    {
        let verified: Option<chrono::NaiveDateTime> =
            row.try_get("emailVerifiedAt").ok().flatten();
        if verified.is_none() {
            if let Ok(id) = row.try_get::<String, _>("id") {
                let _ = issue_verification(&state, &id, &email).await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// Always answers `{ok:true}`. Silent for unknown emails and for OAuth-only
/// accounts (no password to reset).
async fn request_password_reset(State(state): State<AppState>, Json(body): Json<EmailBody>) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    if let Some(row) = sqlx::query(r#"SELECT "id","passwordHash" FROM "User" WHERE "email" = $1"#)
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?
    {
        let has_pw: Option<String> = row.try_get("passwordHash").ok().flatten();
        if has_pw.is_some() {
            if let Ok(id) = row.try_get::<String, _>("id") {
                sqlx::query(
                    r#"UPDATE "PasswordReset" SET "consumedAt" = now() WHERE "userId" = $1 AND "consumedAt" IS NULL"#,
                )
                .bind(&id)
                .execute(&state.pool)
                .await?;
                let raw = gen_email_token();
                sqlx::query(
                    r#"INSERT INTO "PasswordReset" ("id","userId","tokenSha","expiresAt","createdAt")
                       VALUES ($1,$2,$3,now() + interval '1 hour',now())"#,
                )
                .bind(gen_id())
                .bind(&id)
                .bind(sha256_hex(&raw))
                .execute(&state.pool)
                .await?;
                let link = format!("{}/auth/reset?token={}", state.app_base_url, urlencode(&raw));
                let text = format!(
                    "Click the link below to reset your password. The link expires in 1 hour and can only be used once.\n\n{link}\n\nIf you didn't request this, you can safely ignore the email."
                );
                let html = render_email(
                    "Reset your password",
                    "We received a request to reset your Query Schema password. This link expires in 1 hour and can only be used once.",
                    "Reset password",
                    &link,
                    "If you didn't request this, you can safely ignore this email.",
                );
                send_mail(&state, &email, "Reset your Query Schema password", &text, &html).await;
            }
        }
    }
    Ok(Json(json!({ "ok": true })))
}

// â”€â”€ row filters + column masks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// A row filter is a SQL predicate stored verbatim and appended to queries, so
// its validator is a SECURITY control, not a nicety. This is a faithful port of
// v1's tokenizer: whitelist identifiers/numbers/strings/comparison ops/a small
// keyword set/the single `:userId` placeholder, and reject everything else.

fn ident_ok(s: &str) -> bool {
    let mut cs = s.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    s.len() <= 64 && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn validate_predicate(raw: &str) -> Result<(), String> {
    if raw.is_empty() || raw.len() > 1000 {
        return Err("Predicate must be 1..1000 chars".into());
    }
    if raw.contains(';') || raw.contains("--") || raw.contains("/*") || raw.contains("*/") {
        return Err("Disallowed character or comment".into());
    }
    const OPS2: [&str; 4] = ["<>", "!=", "<=", ">="];
    const OPS1: [char; 4] = ['=', '<', '>', '!'];
    const KEYWORDS: [&str; 8] = ["AND", "OR", "NOT", "IS", "NULL", "TRUE", "FALSE", "IN"];

    let b: Vec<char> = raw.chars().collect();
    let n = b.len();
    let mut i = 0usize;
    while i < n {
        while i < n && b[i].is_whitespace() {
            i += 1;
        }
        if i >= n {
            break;
        }
        let ch = b[i];
        if ch == '(' || ch == ')' || ch == ',' {
            i += 1;
            continue;
        }
        if ch == ':' {
            let rest: String = b[i..n.min(i + 7)].iter().collect();
            if rest == ":userId" {
                i += 7;
                continue;
            }
            return Err(format!("Unknown placeholder at position {i}"));
        }
        if i + 1 < n {
            let two: String = b[i..i + 2].iter().collect();
            if OPS2.contains(&two.as_str()) {
                i += 2;
                continue;
            }
        }
        if OPS1.contains(&ch) && ch != '!' {
            i += 1;
            continue;
        }
        if ch == '\'' {
            i += 1;
            while i < n {
                if b[i] == '\'' {
                    if i + 1 < n && b[i + 1] == '\'' {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if ch.is_ascii_digit() {
            while i < n && (b[i].is_ascii_digit() || b[i] == '.') {
                i += 1;
            }
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == '_' || b[i] == '.') {
                i += 1;
            }
            let tok: String = b[start..i].iter().collect();
            if KEYWORDS.contains(&tok.to_uppercase().as_str()) {
                continue;
            }
            if tok.split('.').all(ident_ok) {
                continue;
            }
            return Err(format!("Invalid identifier \"{tok}\""));
        }
        return Err(format!("Unexpected character \"{ch}\" at position {i}"));
    }
    Ok(())
}

/// Only the connection owner may manage filters/masks (v1 @RequireRole('OWNER')
/// on these routes resolves to the owner for this resource).
async fn require_conn_owner(state: &AppState, conn_id: &str, user_id: &str) -> Result<(), ApiError> {
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Connection" WHERE "id" = $1"#)
        .bind(conn_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    match owner {
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found")),
        Some(o) if o == user_id => Ok(()),
        Some(_) => Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection")),
    }
}

async fn row_filters_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_conn_owner(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        r#"SELECT f."id", f."userId", f."schemaName", f."tableName", f."predicate", f."createdAt", u."email"
           FROM "RowFilter" f JOIN "User" u ON u."id" = f."userId"
           WHERE f."connectionId" = $1 ORDER BY f."createdAt" DESC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<String, _>("id").unwrap_or_default(),
                    "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
                    "email": r.try_get::<String, _>("email").unwrap_or_default(),
                    "schemaName": r.try_get::<String, _>("schemaName").unwrap_or_default(),
                    "tableName": r.try_get::<String, _>("tableName").unwrap_or_default(),
                    "predicate": r.try_get::<String, _>("predicate").unwrap_or_default(),
                    "createdAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("createdAt").ok().flatten(),
                })
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
struct CreateRowFilter {
    email: String,
    #[serde(rename = "schemaName")]
    schema_name: String,
    #[serde(rename = "tableName")]
    table_name: String,
    predicate: String,
}

async fn row_filter_create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<CreateRowFilter>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_conn_owner(&state, &id, &user.id).await?;
    if !ident_ok(&body.schema_name) || !ident_ok(&body.table_name) {
        return Err(ApiError::bad("Invalid schema/table identifier"));
    }
    validate_predicate(&body.predicate).map_err(ApiError::bad)?;
    let target: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
        .bind(body.email.trim().to_lowercase())
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let target = target.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    let row = sqlx::query(
        r#"INSERT INTO "RowFilter" ("id","connectionId","userId","schemaName","tableName","predicate","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT ("connectionId","userId","schemaName","tableName")
           DO UPDATE SET "predicate" = EXCLUDED."predicate"
           RETURNING "id","userId","schemaName","tableName","predicate","createdAt""#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&target)
    .bind(&body.schema_name)
    .bind(&body.table_name)
    .bind(&body.predicate)
    .fetch_one(&state.pool)
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "userId": row.try_get::<String, _>("userId").unwrap_or_default(),
            "schemaName": row.try_get::<String, _>("schemaName").unwrap_or_default(),
            "tableName": row.try_get::<String, _>("tableName").unwrap_or_default(),
            "predicate": row.try_get::<String, _>("predicate").unwrap_or_default(),
            "createdAt": row.try_get::<Option<chrono::NaiveDateTime>, _>("createdAt").ok().flatten(),
        })),
    ))
}

async fn row_filter_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, filter_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require_conn_owner(&state, &id, &user.id).await?;
    let r = sqlx::query(r#"DELETE FROM "RowFilter" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&filter_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn column_masks_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_conn_owner(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        r#"SELECT m."id", m."userId", m."schemaName", m."tableName", m."columnName", m."createdAt", u."email"
           FROM "ColumnMask" m JOIN "User" u ON u."id" = m."userId"
           WHERE m."connectionId" = $1 ORDER BY m."createdAt" DESC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<String, _>("id").unwrap_or_default(),
                    "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
                    "email": r.try_get::<String, _>("email").unwrap_or_default(),
                    "schemaName": r.try_get::<String, _>("schemaName").unwrap_or_default(),
                    "tableName": r.try_get::<String, _>("tableName").unwrap_or_default(),
                    "columnName": r.try_get::<String, _>("columnName").unwrap_or_default(),
                    "createdAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("createdAt").ok().flatten(),
                })
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
struct CreateColumnMask {
    email: String,
    #[serde(rename = "schemaName")]
    schema_name: String,
    #[serde(rename = "tableName")]
    table_name: String,
    #[serde(rename = "columnName")]
    column_name: String,
}

async fn column_mask_create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<CreateColumnMask>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_conn_owner(&state, &id, &user.id).await?;
    if !ident_ok(&body.schema_name) || !ident_ok(&body.table_name) || !ident_ok(&body.column_name) {
        return Err(ApiError::bad("Invalid schema/table/column identifier"));
    }
    let target: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
        .bind(body.email.trim().to_lowercase())
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let target = target.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    let row = sqlx::query(
        r#"INSERT INTO "ColumnMask" ("id","connectionId","userId","schemaName","tableName","columnName","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT ("connectionId","userId","schemaName","tableName","columnName") DO NOTHING
           RETURNING "id","userId","schemaName","tableName","columnName","createdAt""#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&target)
    .bind(&body.schema_name)
    .bind(&body.table_name)
    .bind(&body.column_name)
    .fetch_optional(&state.pool)
    .await?;
    let out = match row {
        Some(r) => json!({
            "id": r.try_get::<String, _>("id").unwrap_or_default(),
            "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
            "schemaName": r.try_get::<String, _>("schemaName").unwrap_or_default(),
            "tableName": r.try_get::<String, _>("tableName").unwrap_or_default(),
            "columnName": r.try_get::<String, _>("columnName").unwrap_or_default(),
            "createdAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("createdAt").ok().flatten(),
        }),
        // Already masked â€” idempotent, mirror v1's "nothing changed" answer.
        None => json!({ "ok": true }),
    };
    Ok((StatusCode::CREATED, Json(out)))
}

async fn column_mask_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, mask_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require_conn_owner(&state, &id, &user.id).await?;
    let r = sqlx::query(r#"DELETE FROM "ColumnMask" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&mask_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

// â”€â”€ API keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Token = "dbs_live_" + 32 random bytes base64url. Stored twice, exactly as v1:
// sha256 hex for the O(1) unique-index lookup, plus argon2id as a safety net
// against a hash collision. The raw token is returned ONCE, on create.

const API_KEY_PREFIX: &str = "dbs_live_";
const API_KEY_COLS: &str = r#""id","userId","name","tokenPrefix","connectionIds","expiresAt","revokedAt","lastUsedAt","createdAt""#;

fn api_key_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "tokenPrefix": r.try_get::<String, _>("tokenPrefix").unwrap_or_default(),
        "connectionIds": r.try_get::<Vec<String>, _>("connectionIds").unwrap_or_default(),
        "expiresAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("expiresAt").ok().flatten(),
        "revokedAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("revokedAt").ok().flatten(),
        "lastUsedAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("lastUsedAt").ok().flatten(),
        "createdAt": r.try_get::<Option<chrono::NaiveDateTime>, _>("createdAt").ok().flatten(),
    })
}

async fn api_keys_list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT {API_KEY_COLS} FROM "ApiKey" WHERE "userId" = $1 ORDER BY "createdAt" DESC"#
    ))
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(rows.iter().map(api_key_json).collect())))
}

#[derive(Deserialize)]
struct CreateApiKey {
    name: String,
    #[serde(rename = "connectionIds", default)]
    connection_ids: Vec<String>,
    #[serde(rename = "expiresAt", default)]
    expires_at: Option<chrono::NaiveDateTime>,
}

async fn api_key_create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateApiKey>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::bad("name must be 1-80 chars"));
    }
    let raw = {
        use rand::RngCore;
        let mut b = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut b);
        format!("{API_KEY_PREFIX}{}", B64.encode(b))
    };
    let token_prefix = format!("{}â€¦", &raw[..API_KEY_PREFIX.len() + 6]);
    let row = sqlx::query(&format!(
        r#"INSERT INTO "ApiKey" ("id","userId","name","tokenSha","tokenHash","tokenPrefix","connectionIds","expiresAt","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING {API_KEY_COLS}"#
    ))
    .bind(gen_id())
    .bind(&user.id)
    .bind(name)
    .bind(sha256_hex(&raw))
    .bind(hash_argon2(&raw)?)
    .bind(&token_prefix)
    .bind(&body.connection_ids)
    .bind(body.expires_at)
    .fetch_one(&state.pool)
    .await?;
    let mut out = api_key_json(&row);
    // Only time the caller ever sees the full token.
    out["token"] = json!(raw);
    Ok((StatusCode::CREATED, Json(out)))
}

async fn api_key_revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(&format!(
        r#"UPDATE "ApiKey" SET "revokedAt" = COALESCE("revokedAt", now())
           WHERE "id" = $1 AND "userId" = $2 RETURNING {API_KEY_COLS}"#
    ))
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    Ok(Json(api_key_json(&row)))
}

async fn api_key_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let r = sqlx::query(r#"DELETE FROM "ApiKey" WHERE "id" = $1 AND "userId" = $2"#)
        .bind(&id)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// v1's ensurePersonalWorkspace + startTrial: every user owns a personal
/// workspace (OWNER member) carrying a FREE/TRIALING subscription. Without it
/// the app has nowhere to hang connections or billing.
async fn ensure_personal_workspace(state: &AppState, user_id: &str, email: &str, display: Option<&str>) {
    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT "id" FROM "Workspace" WHERE "ownerId" = $1 AND "isPersonal" = true LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    let ws_id = match existing {
        Some(id) => id,
        None => {
            let base = slugify(&format!(
                "{}-personal",
                display.filter(|d| !d.is_empty()).unwrap_or_else(|| email.split('@').next().unwrap_or("user"))
            ));
            // First free slug, mirroring v1's base, base-2, base-3â€¦ walk.
            let mut slug = base.clone();
            for i in 2..20 {
                let taken: Option<String> =
                    sqlx::query_scalar(r#"SELECT "id" FROM "Workspace" WHERE "slug" = $1"#)
                        .bind(&slug)
                        .fetch_optional(&state.pool)
                        .await
                        .ok()
                        .flatten();
                if taken.is_none() {
                    break;
                }
                slug = format!("{base}-{i}");
            }
            let id = gen_id();
            if sqlx::query(
                r#"INSERT INTO "Workspace" ("id","name","slug","isPersonal","ownerId","createdAt","updatedAt")
                   VALUES ($1,'Personal',$2,true,$3,now(),now())"#,
            )
            .bind(&id)
            .bind(&slug)
            .bind(user_id)
            .execute(&state.pool)
            .await
            .is_err()
            {
                return;
            }
            let _ = sqlx::query(
                r#"INSERT INTO "WorkspaceMember" ("id","workspaceId","userId","role","createdAt")
                   VALUES ($1,$2,$3,'OWNER',now())"#,
            )
            .bind(gen_id())
            .bind(&id)
            .bind(user_id)
            .execute(&state.pool)
            .await;
            id
        }
    };

    // 7-day FREE trial; ON CONFLICT DO NOTHING = v1's upsert-with-empty-update.
    let _ = sqlx::query(
        r#"INSERT INTO "Subscription" ("id","workspaceId","plan","status","periodStart","periodEnd","createdAt","updatedAt")
           VALUES ($1,$2,'FREE','TRIALING',now(),now() + interval '7 days',now(),now())
           ON CONFLICT ("workspaceId") DO NOTHING"#,
    )
    .bind(gen_id())
    .bind(&ws_id)
    .execute(&state.pool)
    .await;
}

#[derive(Deserialize)]
struct SignupBody {
    email: String,
    password: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "inviteCode")]
    invite_code: Option<String>,
}

async fn signup(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<SignupBody>,
) -> ApiResult<Response> {
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Err(ApiError::bad("email must be an email"));
    }
    let pw = &body.password;
    let n = pw.chars().count();
    if n < 12 || n > 128 {
        return Err(ApiError::bad("Password must be 12-128 chars"));
    }
    if !pw.chars().any(|c| c.is_ascii_uppercase()) {
        return Err(ApiError::bad("Password must contain uppercase"));
    }
    if !pw.chars().any(|c| c.is_ascii_lowercase()) {
        return Err(ApiError::bad("Password must contain lowercase"));
    }
    if !pw.chars().any(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad("Password must contain a digit"));
    }
    let meta = req_meta(&headers);

    // Existing address is NOT an error in v1 â€” it returns a throwaway id and a
    // needsVerification flag so signup can't be used to enumerate accounts.
    let taken: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    if taken.is_some() {
        let fake: String = {
            use rand::RngCore;
            let mut b = [0u8; 12];
            rand::thread_rng().fill_bytes(&mut b);
            b.iter().map(|x| format!("{x:02x}")).collect()
        };
        return Ok((StatusCode::CREATED, Json(json!({ "userId": fake, "needsVerification": true })))
            .into_response());
    }

    // Invite gate. v1 enforces this inside AuthService.signup; without it a
    // v2-served signup would silently ignore REQUIRE_INVITE_CODE_ON_SIGNUP and
    // let anyone register on an invite-only instance. Consumed AFTER the
    // duplicate-email check so a repeated signup can't burn someone's code.
    let require_invite = std::env::var("REQUIRE_INVITE_CODE_ON_SIGNUP")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);
    if require_invite {
        let code = body.invite_code.as_deref().unwrap_or("");
        misc::consume_invite_code(&state, code, &email).await?;
    }

    let needs_verify = state.require_email_verification;
    let hash = hash_argon2(pw)?;
    let id = gen_id();
    let display = body.display_name.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty());

    sqlx::query(
        r#"INSERT INTO "User"
           ("id","email","passwordHash","displayName","emailVerifiedAt","isAdmin",
            "approvalStatus","approvedAt","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN NULL ELSE now() END, false,
                   'approved', now(), now(), now())"#,
    )
    .bind(&id)
    .bind(&email)
    .bind(&hash)
    .bind(display)
    .bind(needs_verify)
    .execute(&state.pool)
    .await?;

    ensure_personal_workspace(&state, &id, &email, display).await;
    audit(&state, Some(&id), "SIGNUP", &meta, None).await;

    if needs_verify {
        // A mail failure still leaves the row + token, so "resend" works.
        let _ = issue_verification(&state, &id, &email).await;
        return Ok((StatusCode::CREATED, Json(json!({ "userId": id, "needsVerification": true })))
            .into_response());
    }

    let (access, refresh, expires_at) = issue_tokens(&state, &id, &email, &meta).await?;
    Ok(Response::builder()
        .status(StatusCode::CREATED)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::SET_COOKIE, refresh_cookie(&state, &refresh, expires_at))
        .body(Body::from(
            serde_json::to_vec(&json!({ "accessToken": access, "userId": id })).unwrap_or_default(),
        ))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

/// Argon2id with v1's exact parameters (m=65536, t=3, p=4, len=32, 16-byte
/// salt) so hashes written here are readable by v1 and vice-versa.
fn hash_argon2(password: &str) -> Result<String, ApiError> {
    use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(65536, 3, 4, Some(32)).map_err(|e| ApiError::internal(e.to_string()))?;
    let a = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    a.hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::internal(e.to_string()))
}

#[derive(Deserialize)]
struct ChangePasswordBody {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

/// v1 keeps the CURRENT session alive and revokes every other one.
async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    headers: axum::http::HeaderMap,
    Json(body): Json<ChangePasswordBody>,
) -> ApiResult<Response> {
    if body.new_password.chars().count() < 12 || body.new_password.chars().count() > 128 {
        return Err(ApiError::bad("Password must be 12-128 chars"));
    }
    let meta = req_meta(&headers);
    let row = sqlx::query(r#"SELECT "passwordHash" FROM "User" WHERE "id" = $1"#)
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Unauthorized"))?;
    let hash: Option<String> = row.try_get("passwordHash").ok().flatten();
    let hash = hash.ok_or_else(|| {
        ApiError::bad("This account signs in with a provider and has no password to change.")
    })?;
    if verify_argon2(&body.current_password, &hash).is_err() {
        return Err(ApiError::unauthorized("Current password is incorrect"));
    }
    if verify_argon2(&body.new_password, &hash).is_ok() {
        return Err(ApiError::bad("New password must be different from the current one"));
    }

    let new_hash = hash_argon2(&body.new_password)?;
    sqlx::query(r#"UPDATE "User" SET "passwordHash" = $1, "updatedAt" = now() WHERE "id" = $2"#)
        .bind(&new_hash)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;

    let keep = cookie_from_header(&headers, REFRESH_COOKIE).map(|r| sha256_hex(&r));
    let _ = sqlx::query(
        r#"UPDATE "RefreshToken" SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::text IS NULL OR "tokenHash" <> $2)"#,
    )
    .bind(&user.id)
    .bind(keep.as_deref())
    .execute(&state.pool)
    .await;
    audit(&state, Some(&user.id), "PASSWORD_CHANGED", &meta, None).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn sessions_list(
    State(state): State<AppState>,
    user: AuthUser,
    headers: axum::http::HeaderMap,
) -> ApiResult<Json<Value>> {
    let current = cookie_from_header(&headers, REFRESH_COOKIE).map(|r| sha256_hex(&r));
    let rows = sqlx::query(
        r#"SELECT "id","userAgent","ip","createdAt","expiresAt","tokenHash"
           FROM "RefreshToken"
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND "expiresAt" > now()
           ORDER BY "createdAt" DESC"#,
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            let hash: String = r.try_get("tokenHash").unwrap_or_default();
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "userAgent": r.try_get::<Option<String>, _>("userAgent").ok().flatten(),
                "ip": r.try_get::<Option<String>, _>("ip").ok().flatten(),
                "createdAt": r.try_get::<chrono::NaiveDateTime, _>("createdAt").ok(),
                "expiresAt": r.try_get::<chrono::NaiveDateTime, _>("expiresAt").ok(),
                "current": current.as_deref() == Some(hash.as_str()),
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

/// v1 answers `{ok:true}` even when the id is unknown or belongs to someone
/// else â€” deliberately, so session ids can't be probed.
async fn session_revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = sqlx::query(
        r#"UPDATE "RefreshToken" SET "revokedAt" = now()
           WHERE "id" = $1 AND "userId" = $2 AND "revokedAt" IS NULL"#,
    )
    .bind(&id)
    .bind(&user.id)
    .execute(&state.pool)
    .await;
    Ok(Json(json!({ "ok": true })))
}

async fn sessions_revoke_all(
    State(state): State<AppState>,
    user: AuthUser,
    headers: axum::http::HeaderMap,
) -> ApiResult<Json<Value>> {
    let keep = cookie_from_header(&headers, REFRESH_COOKIE).map(|r| sha256_hex(&r));
    let res = sqlx::query(
        r#"UPDATE "RefreshToken" SET "revokedAt" = now()
           WHERE "userId" = $1 AND "revokedAt" IS NULL AND ($2::text IS NULL OR "tokenHash" <> $2)"#,
    )
    .bind(&user.id)
    .bind(keep.as_deref())
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "revoked": res.rows_affected() })))
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
}

/// Consume an email-verification token. No email is sent here, so this is
/// fully native; issuing/resending still goes to v1 until the mailer lands.
async fn verify_email(State(state): State<AppState>, Json(body): Json<TokenBody>) -> ApiResult<Json<Value>> {
    if body.token.trim().is_empty() {
        return Err(ApiError::bad("Missing token"));
    }
    let sha = sha256_hex(&body.token);
    let row = sqlx::query(
        r#"SELECT "id","userId","expiresAt","consumedAt" FROM "EmailVerification" WHERE "tokenSha" = $1"#,
    )
    .bind(&sha)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Invalid or expired verification link"))?;

    if row.try_get::<Option<chrono::NaiveDateTime>, _>("consumedAt").ok().flatten().is_some() {
        return Err(ApiError::bad("This link has already been used"));
    }
    let expires: chrono::NaiveDateTime =
        row.try_get("expiresAt").map_err(|e| ApiError::internal(e.to_string()))?;
    if expires < chrono::Utc::now().naive_utc() {
        return Err(ApiError::bad("This link has expired"));
    }
    let vid: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let uid: String = row.try_get("userId").map_err(|e| ApiError::internal(e.to_string()))?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(r#"UPDATE "EmailVerification" SET "consumedAt" = now() WHERE "id" = $1"#)
        .bind(&vid)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"UPDATE "User" SET "emailVerifiedAt" = COALESCE("emailVerifiedAt", now()), "updatedAt" = now()
           WHERE "id" = $1"#,
    )
    .bind(&uid)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct CompleteResetBody {
    token: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

/// Consume a password-reset token and set the new password. v1 kills EVERY
/// session on reset (no exception for the caller).
async fn complete_password_reset(
    State(state): State<AppState>,
    Json(body): Json<CompleteResetBody>,
) -> ApiResult<Json<Value>> {
    if body.token.trim().is_empty() {
        return Err(ApiError::bad("Missing token"));
    }
    if body.new_password.chars().count() < 8 {
        return Err(ApiError::bad("Password must be at least 8 characters"));
    }
    let sha = sha256_hex(&body.token);
    let row = sqlx::query(
        r#"SELECT "id","userId","expiresAt","consumedAt" FROM "PasswordReset" WHERE "tokenSha" = $1"#,
    )
    .bind(&sha)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Invalid or expired reset link"))?;

    if row.try_get::<Option<chrono::NaiveDateTime>, _>("consumedAt").ok().flatten().is_some() {
        return Err(ApiError::bad("This link has already been used"));
    }
    let expires: chrono::NaiveDateTime =
        row.try_get("expiresAt").map_err(|e| ApiError::internal(e.to_string()))?;
    if expires < chrono::Utc::now().naive_utc() {
        return Err(ApiError::bad("This link has expired"));
    }
    let rid: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let uid: String = row.try_get("userId").map_err(|e| ApiError::internal(e.to_string()))?;
    let new_hash = hash_argon2(&body.new_password)?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(r#"UPDATE "PasswordReset" SET "consumedAt" = now() WHERE "id" = $1"#)
        .bind(&rid)
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"UPDATE "User" SET "passwordHash" = $1, "updatedAt" = now() WHERE "id" = $2"#)
        .bind(&new_hash)
        .bind(&uid)
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL"#)
        .bind(&uid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// Replay a JSON request to v1 and return its response verbatim (used for the
/// auth flows that are not ported yet, e.g. TOTP logins).
async fn forward_to_v1_json<T: Serialize>(
    state: &AppState,
    path: &str,
    body: &T,
    headers: &axum::http::HeaderMap,
) -> ApiResult<Response> {
    let url = format!("{}{}", state.v1_origin, path);
    // reqwest is built without the `json` feature â€” serialize by hand.
    let payload = serde_json::to_vec(body).map_err(|e| ApiError::internal(e.to_string()))?;
    let mut rb = state
        .http
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload);
    for name in ["user-agent", "x-forwarded-for", "cf-connecting-ip", "cookie"] {
        if let Some(v) = headers.get(name) {
            rb = rb.header(name, v.as_bytes());
        }
    }
    let resp = rb.send().await.map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    let status = resp.status();
    let hdrs = resp.headers().clone();
    let mut builder = Response::builder().status(status.as_u16());
    for (k, v) in hdrs.iter() {
        let n = k.as_str();
        if n.eq_ignore_ascii_case("transfer-encoding")
            || n.eq_ignore_ascii_case("content-length")
            || n.eq_ignore_ascii_case("connection")
        {
            continue;
        }
        builder = builder.header(n, v.as_bytes());
    }
    Ok(builder
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()))
}

/// Rotate a refresh token. Reuse of an already-revoked token revokes every live
/// session for that user (v1's family = the user).
async fn auth_refresh(State(state): State<AppState>, headers: axum::http::HeaderMap) -> ApiResult<Response> {
    let meta = req_meta(&headers);
    let raw = cookie_from_header(&headers, REFRESH_COOKIE)
        .ok_or_else(|| ApiError::unauthorized("Missing refresh token"))?;
    let hash = sha256_hex(&raw);

    let rec = sqlx::query(
        r#"SELECT r."id", r."userId", r."expiresAt", r."revokedAt", u."email"
           FROM "RefreshToken" r JOIN "User" u ON u."id" = r."userId"
           WHERE r."tokenHash" = $1 LIMIT 1"#,
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("Invalid or expired refresh token"))?;

    let user_id: String = rec.try_get("userId").map_err(|e| ApiError::internal(e.to_string()))?;
    let rec_id: String = rec.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let email: String = rec.try_get("email").map_err(|e| ApiError::internal(e.to_string()))?;
    let revoked: Option<chrono::NaiveDateTime> = rec.try_get("revokedAt").ok().flatten();
    let expires: chrono::NaiveDateTime =
        rec.try_get("expiresAt").map_err(|e| ApiError::internal(e.to_string()))?;

    if revoked.is_some() {
        // Reuse detected â€” nuke every live session for this user.
        let _ = sqlx::query(
            r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL"#,
        )
        .bind(&user_id)
        .execute(&state.pool)
        .await;
        audit(
            &state,
            Some(&user_id),
            "LOGIN_FAILED",
            &meta,
            Some(json!({ "reason": "refresh_token_reuse_detected", "revokedAllSessions": true })),
        )
        .await;
        return Err(ApiError::unauthorized("Invalid or expired refresh token"));
    }
    if expires < chrono::Utc::now().naive_utc() {
        return Err(ApiError::unauthorized("Invalid or expired refresh token"));
    }

    let (access, next_raw, next_exp) = issue_tokens(&state, &user_id, &email, &meta).await?;
    let _ = sqlx::query(r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "id" = $1"#)
        .bind(&rec_id)
        .execute(&state.pool)
        .await;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .header(axum::http::header::SET_COOKIE, refresh_cookie(&state, &next_raw, next_exp))
        .body(Body::from(serde_json::to_vec(&json!({ "accessToken": access })).unwrap_or_default()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

async fn auth_logout(State(state): State<AppState>, user: AuthUser, headers: axum::http::HeaderMap) -> ApiResult<Response> {
    let meta = req_meta(&headers);
    if let Some(raw) = cookie_from_header(&headers, REFRESH_COOKIE) {
        let _ = sqlx::query(
            r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "tokenHash" = $1 AND "revokedAt" IS NULL"#,
        )
        .bind(sha256_hex(&raw))
        .execute(&state.pool)
        .await;
    }
    audit(&state, Some(&user.id), "LOGOUT", &meta, None).await;
    Ok(Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(axum::http::header::SET_COOKIE, clear_refresh_cookie(&state))
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

fn verify_argon2(password: &str, hash: &str) -> Result<(), ()> {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;
    let parsed = PasswordHash::new(hash).map_err(|_| ())?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| ())
}

async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        r#"SELECT "id", "email", "displayName", "isAdmin", "density", "theme"
           FROM "User" WHERE "id" = $1 LIMIT 1"#,
    )
    .bind(&user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("User not found"))?;

    Ok(Json(json!({
        "id": row.try_get::<String, _>("id").unwrap_or_default(),
        "email": row.try_get::<String, _>("email").unwrap_or_default(),
        "displayName": row.try_get::<Option<String>, _>("displayName").ok().flatten(),
        "isAdmin": row.try_get::<bool, _>("isAdmin").unwrap_or(false),
    })))
}

// ---------------------------------------------------------------------------
// Health / DB
// ---------------------------------------------------------------------------

async fn health_db(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let start = Instant::now();
    let one: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&state.pool).await?;
    Ok(Json(json!({ "ok": one == 1, "tookMs": ms(start) })))
}

// ---------------------------------------------------------------------------
// Connections (owned by the user)
// ---------------------------------------------------------------------------

async fn list_connections(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT "id", "name", "dialect"::text AS dialect, "readOnly", "createdAt"
           FROM "Connection" WHERE "ownerId" = $1 ORDER BY "createdAt" DESC"#,
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;

    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "dialect": r.try_get::<String, _>("dialect").unwrap_or_default(),
                "readOnly": r.try_get::<bool, _>("readOnly").unwrap_or(false),
            })
        })
        .collect();
    Ok(Json(json!({ "connections": list })))
}

// ---------------------------------------------------------------------------
// Introspection (the shared app Postgres â€” phase 1)
// ---------------------------------------------------------------------------

async fn list_schemas(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog','information_schema')
             AND schema_name NOT LIKE 'pg_%'
           ORDER BY schema_name"#,
    )
    .fetch_all(&state.pool)
    .await?;
    let schemas: Vec<String> = rows.iter().map(|r| r.get::<String, _>("schema_name")).collect();
    Ok(Json(json!({ "schemas": schemas })))
}

async fn list_tables(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(schema): Path<String>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'
           ORDER BY table_name"#,
    )
    .bind(&schema)
    .fetch_all(&state.pool)
    .await?;
    let tables: Vec<String> = rows.iter().map(|r| r.get::<String, _>("table_name")).collect();
    Ok(Json(json!({ "tables": tables })))
}

async fn list_columns(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((schema, table)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT c.column_name, c.data_type, c.is_nullable,
                  COALESCE(pk.is_pk, false) AS is_pk
           FROM information_schema.columns c
           LEFT JOIN (
             SELECT kcu.column_name, true AS is_pk
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY'
               AND tc.table_schema = $1 AND tc.table_name = $2
           ) pk ON pk.column_name = c.column_name
           WHERE c.table_schema = $1 AND c.table_name = $2
           ORDER BY c.ordinal_position"#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(&state.pool)
    .await?;

    let columns: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "name": r.try_get::<String, _>("column_name").unwrap_or_default(),
                "type": r.try_get::<String, _>("data_type").unwrap_or_default(),
                "nullable": r.try_get::<String, _>("is_nullable").map(|s| s == "YES").unwrap_or(true),
                "isPrimaryKey": r.try_get::<bool, _>("is_pk").unwrap_or(false),
            })
        })
        .collect();
    Ok(Json(json!({ "columns": columns })))
}

// ---------------------------------------------------------------------------
// Table rows (paginated) â€” the browse hot path
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RowsParams {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn table_rows(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((schema, table)): Path<(String, String)>,
    Query(params): Query<RowsParams>,
) -> ApiResult<Json<Value>> {
    // Validate the identifiers against the catalog so we can safely inline them
    // (parameters can't be used for identifiers). Rejects anything not a real table.
    ensure_table_exists(&state.pool, &schema, &table).await?;

    let limit = params.limit.unwrap_or(100).clamp(1, state.max_rows);
    let offset = params.offset.unwrap_or(0).max(0);
    let qschema = quote_ident(&schema);
    let qtable = quote_ident(&table);

    let start = Instant::now();
    let rows_json: Value = sqlx::query_scalar(&format!(
        r#"SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
           FROM (SELECT * FROM {qschema}.{qtable} LIMIT {limit} OFFSET {offset}) t"#,
    ))
    .fetch_one(&state.pool)
    .await?;
    let took = ms(start);

    let total: Option<i64> = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM {qschema}.{qtable}"#,
    ))
    .fetch_one(&state.pool)
    .await
    .ok();

    let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(Json(json!({
        "rows": rows_json,
        "rowCount": row_count,
        "total": total,
        "limit": limit,
        "offset": offset,
        "tookMs": took,
    })))
}

async fn ensure_table_exists(pool: &PgPool, schema: &str, table: &str) -> ApiResult<()> {
    let exists: Option<bool> = sqlx::query_scalar(
        r#"SELECT true FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2 LIMIT 1"#,
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await?;
    if exists.unwrap_or(false) {
        Ok(())
    } else {
        Err(ApiError::bad(format!("Unknown table {schema}.{table}")))
    }
}

/// Safely double-quote a Postgres identifier (doubling embedded quotes).
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

// ---------------------------------------------------------------------------
// SQL runner â€” the query hot path
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RunBody {
    sql: String,
}

async fn run_query(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<RunBody>,
) -> ApiResult<Json<Value>> {
    let sql = body.sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let lowered = sql.to_lowercase();
    let is_select = lowered.starts_with("select") || lowered.starts_with("with") || lowered.starts_with("table");

    let start = Instant::now();
    if is_select {
        // Wrap so any column type serializes to JSON, capped by an outer LIMIT.
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {}) t",
            state.max_rows
        );
        let rows_json: Value = sqlx::query_scalar(&wrapped).fetch_one(&state.pool).await?;
        let took = ms(start);
        let columns = derive_columns(&rows_json);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        Ok(Json(json!({
            "columns": columns,
            "rows": rows_json,
            "rowCount": row_count,
            "tookMs": took,
        })))
    } else {
        // DML/DDL â€” execute and report affected rows.
        let res = sqlx::query(sql).execute(&state.pool).await?;
        Ok(Json(json!({
            "columns": [],
            "rows": [],
            "rowsAffected": res.rows_affected(),
            "tookMs": ms(start),
        })))
    }
}

// ---------------------------------------------------------------------------
// Executor-generic core queries â€” run against the app pool OR a live target
// connection, so introspection/rows/SQL is written once and reused for both.
// ---------------------------------------------------------------------------

type Pg = sqlx::Postgres;

const COLUMNS_SQL: &str = r#"SELECT c.column_name, c.data_type, c.is_nullable,
        COALESCE(pk.is_pk, false) AS is_pk
   FROM information_schema.columns c
   LEFT JOIN (
     SELECT kcu.column_name, true AS is_pk
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2
   ) pk ON pk.column_name = c.column_name
   WHERE c.table_schema = $1 AND c.table_name = $2
   ORDER BY c.ordinal_position"#;

async fn core_schemas<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('pg_catalog','information_schema') \
           AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name",
    )
    .fetch_all(exec)
    .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("schema_name")).collect())
}

async fn core_tables<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(exec)
    .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

async fn core_columns<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str, table: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(COLUMNS_SQL).bind(schema).bind(table).fetch_all(exec).await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "name": r.try_get::<String, _>("column_name").unwrap_or_default(),
                "type": r.try_get::<String, _>("data_type").unwrap_or_default(),
                "nullable": r.try_get::<String, _>("is_nullable").map(|s| s == "YES").unwrap_or(true),
                "isPrimaryKey": r.try_get::<bool, _>("is_pk").unwrap_or(false),
            })
        })
        .collect())
}

async fn core_table_exists<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str, table: &str) -> Result<bool, sqlx::Error> {
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(exec)
    .await?;
    Ok(exists.unwrap_or(false))
}

async fn core_rows_json<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, qschema: &str, qtable: &str, limit: i64, offset: i64) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) \
         FROM (SELECT * FROM {qschema}.{qtable} LIMIT {limit} OFFSET {offset}) t",
    ))
    .fetch_one(exec)
    .await
}

async fn core_count<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, qschema: &str, qtable: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {qschema}.{qtable}")).fetch_one(exec).await
}

async fn core_select_json<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str, max: i64) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {max}) t",
    ))
    .fetch_one(exec)
    .await
}

async fn core_exec<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(sql).execute(exec).await?.rows_affected())
}

fn is_select(sql: &str) -> bool {
    let l = sql.to_lowercase();
    l.starts_with("select") || l.starts_with("with") || l.starts_with("table")
}

fn rows_response(rows_json: Value, total: Option<i64>, limit: i64, offset: i64, took: f64) -> Value {
    let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
    json!({ "rows": rows_json, "rowCount": row_count, "total": total, "limit": limit, "offset": offset, "tookMs": took })
}

/// Run arbitrary SQL over any executor (app pool or target connection), timed.
async fn run_on<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str, max: i64) -> ApiResult<Value> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let start = Instant::now();
    if is_select(sql) {
        let rows_json = core_select_json(exec, sql, max).await?;
        let took = ms(start);
        let columns = derive_columns(&rows_json);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        Ok(json!({ "columns": columns, "rows": rows_json, "rowCount": row_count, "tookMs": took }))
    } else {
        let affected = core_exec(exec, sql).await?;
        Ok(json!({ "columns": [], "rows": [], "rowsAffected": affected, "tookMs": ms(start) }))
    }
}

// ---------------------------------------------------------------------------
// Target-database handlers â€” decrypt v1 credentials, connect, run against it.
// ---------------------------------------------------------------------------

async fn connect_target(
    state: &AppState,
    id: &str,
    user_id: &str,
) -> ApiResult<sqlx::pool::PoolConnection<sqlx::Postgres>> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured â€” target connections disabled"))?;
    let row = sqlx::query(
        r#"SELECT c."credentialsCt", c."dialect"::text AS dialect, c."viaAgent", c."agentId"
           FROM "Connection" c
           WHERE c."id" = $1 AND (
             c."ownerId" = $2
             OR EXISTS (SELECT 1 FROM "ConnectionMember" m
                        WHERE m."connectionId" = c."id" AND m."userId" = $2)
           ) LIMIT 1"#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::bad("Connection not found"))?;

    let dialect: String = row.try_get("dialect").unwrap_or_default();
    if !dialect.to_lowercase().contains("postgres") {
        return Err(ApiError::bad(format!("v2 supports Postgres targets only so far (got {dialect})")));
    }
    let ct: String = row.try_get("credentialsCt").map_err(|e| ApiError::internal(e.to_string()))?;
    let json = crypto
        .decrypt(&ct, &crypto::Crypto::conn_purpose(id))
        .map_err(|e| ApiError::bad(format!("credential decrypt failed: {e}")))?;
    let creds: crypto::ConnectionCredentials =
        serde_json::from_str(&json).map_err(|e| ApiError::internal(format!("bad credentials json: {e}")))?;

    // Agent-backed connections: the database is not reachable from here, only
    // from the desktop agent. Open a loopback bridge through the agent's
    // WebSocket and dial that instead of the stored host.
    //
    // Dropping `OpenTunnel` only stops the listener ACCEPTING — the socket we
    // just established keeps being pumped by its own task, so it is safe to let
    // the guard fall out of scope once `connect_with` has returned.
    let via_agent: bool = row.try_get("viaAgent").unwrap_or(false);
    let (dial_host, dial_port, _tunnel) = if via_agent {
        let agent_id: Option<String> = row
            .try_get("agentId")
            .map_err(|e| ApiError::internal(e.to_string()))?;
        let agent_id = agent_id
            .ok_or_else(|| ApiError::bad("Connection is agent-routed but has no agent assigned"))?;
        let t = tunnel::open_tunnel(&agent_id, &creds.host, creds.port).await?;
        (t.local_host.clone(), t.local_port, Some(t))
    } else {
        (creds.host.clone(), creds.port, None)
    };

    // No TLS backend compiled yet â†’ Disable only. TLS target support is a
    // planned follow-up (adds sqlx `tls-rustls`).
    let opts = PgConnectOptions::new()
        .host(&dial_host)
        .port(dial_port)
        .username(&creds.user)
        .password(&creds.password)
        .database(&creds.database)
        .ssl_mode(PgSslMode::Disable);

    // Reuse a pool per connection instead of dialling per request. This is the
    // dominant cost on agent-routed connections: opening a tunnel stream plus a
    // Postgres startup/auth handshake is ~4 sequential round trips to the
    // agent's machine, paid on EVERY request. v1 cached drivers for the same
    // reason. The tunnel guard is parked next to the pool so the loopback
    // listener outlives the connections using it.
    let pool = {
        let mut cache = TARGET_POOLS.get_or_init(Default::default).lock().unwrap();
        cache.retain(|_, v| v.last_used.elapsed() < std::time::Duration::from_secs(300));
        match cache.get_mut(id) {
            Some(entry) => {
                entry.last_used = std::time::Instant::now();
                entry.pool.clone()
            }
            None => {
                let p = PgPoolOptions::new()
                    .max_connections(4)
                    .idle_timeout(std::time::Duration::from_secs(240))
                    .connect_lazy_with(opts);
                cache.insert(
                    id.to_string(),
                    CachedTarget { pool: p.clone(), last_used: std::time::Instant::now(), _tunnel },
                );
                p
            }
        }
    };
    pool.acquire()
        .await
        .map_err(|e| ApiError::bad(format!("connect to target failed: {e}")))
}

/// A connection checked out of a cached target pool. Returns itself to the pool
/// on drop, which is what makes connection reuse work — deref it (`&mut *c`) to
/// get the `&mut PgConnection` sqlx executors want.
pub(crate) type TargetConn = sqlx::pool::PoolConnection<sqlx::Postgres>;

/// A live pool to one customer database, plus the tunnel guard keeping its
/// loopback bridge open (None for directly-reachable databases).
struct CachedTarget {
    pool: PgPool,
    last_used: std::time::Instant,
    _tunnel: Option<tunnel::OpenTunnel>,
}

static TARGET_POOLS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedTarget>>> =
    std::sync::OnceLock::new();

/// Drop any cached pool for a connection — call after its credentials change or
/// it is deleted, so the next request dials with the new details.
pub(crate) fn evict_target_pool(id: &str) {
    if let Some(m) = TARGET_POOLS.get() {
        if let Ok(mut c) = m.lock() {
            c.remove(id);
        }
    }
}

async fn conn_schemas(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "schemas": core_schemas(&mut *c).await? })))
}

async fn conn_tables(State(state): State<AppState>, user: AuthUser, Path((id, schema)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "tables": core_tables(&mut *c, &schema).await? })))
}

async fn conn_columns(State(state): State<AppState>, user: AuthUser, Path((id, schema, table)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "columns": core_columns(&mut *c, &schema, &table).await? })))
}

async fn conn_table_rows(State(state): State<AppState>, user: AuthUser, Path((id, schema, table)): Path<(String, String, String)>, Query(params): Query<RowsParams>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    let limit = params.limit.unwrap_or(100).clamp(1, state.max_rows);
    let offset = params.offset.unwrap_or(0).max(0);
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let start = Instant::now();
    let rows_json = core_rows_json(&mut *c, &qs, &qt, limit, offset).await?;
    let took = ms(start);
    let total = core_count(&mut *c, &qs, &qt).await.ok();
    Ok(Json(rows_response(rows_json, total, limit, offset, took)))
}

async fn conn_query(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<RunBody>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    run_on(&mut *c, &body.sql, state.max_rows).await.map(Json)
}

// ---------------------------------------------------------------------------
// Connections list/get â€” v1-shaped (decrypts credentials for host/port/user/db).
// ---------------------------------------------------------------------------

const CONN_COLS: &str = r#""id","name","dialect"::text AS dialect,"credentialsCt","readOnly","statementTimeoutMs","slowQueryAlertMs","slowQueryAlertEmail","requireReview","workspaceId","viaAgent","agentId","createdAt","updatedAt""#;

fn conn_dto(r: &PgRow, crypto: &crypto::Crypto) -> Value {
    let id: String = r.try_get("id").unwrap_or_default();
    // Decrypt host/port/user/database; password is intentionally omitted.
    let creds = r
        .try_get::<String, _>("credentialsCt")
        .ok()
        .and_then(|ct| crypto.decrypt(&ct, &crypto::Crypto::conn_purpose(&id)).ok())
        .and_then(|j| serde_json::from_str::<crypto::ConnectionCredentials>(&j).ok());
    json!({
        "id": id,
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "dialect": r.try_get::<String, _>("dialect").unwrap_or_default(),
        "host": creds.as_ref().map(|c| c.host.clone()),
        "port": creds.as_ref().map(|c| c.port),
        "user": creds.as_ref().map(|c| c.user.clone()),
        "database": creds.as_ref().map(|c| c.database.clone()),
        "sslMode": creds.as_ref().and_then(|c| c.ssl_mode.clone()),
        "readOnly": r.try_get::<bool, _>("readOnly").unwrap_or(false),
        "statementTimeoutMs": r.try_get::<i32, _>("statementTimeoutMs").ok(),
        "slowQueryAlertMs": r.try_get::<Option<i32>, _>("slowQueryAlertMs").ok().flatten(),
        "slowQueryAlertEmail": r.try_get::<Option<String>, _>("slowQueryAlertEmail").ok().flatten(),
        "requireReview": r.try_get::<bool, _>("requireReview").unwrap_or(false),
        "workspaceId": r.try_get::<Option<String>, _>("workspaceId").ok().flatten(),
        "viaAgent": r.try_get::<bool, _>("viaAgent").unwrap_or(false),
        "agentId": r.try_get::<Option<String>, _>("agentId").ok().flatten(),
        "createdAt": r.try_get::<chrono::NaiveDateTime, _>("createdAt").ok().map(|d| d.and_utc().to_rfc3339()),
        "updatedAt": r.try_get::<chrono::NaiveDateTime, _>("updatedAt").ok().map(|d| d.and_utc().to_rfc3339()),
    })
}

async fn v1_workspaces_list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT DISTINCT w."id", w."name", w."slug", w."isPersonal", w."ownerId", w."createdAt", w."updatedAt"
           FROM "Workspace" w
           LEFT JOIN "WorkspaceMember" m ON m."workspaceId" = w."id" AND m."userId" = $1
           WHERE w."ownerId" = $1 OR m."userId" IS NOT NULL
           ORDER BY w."isPersonal" DESC, w."createdAt" ASC"#,
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "slug": r.try_get::<String, _>("slug").unwrap_or_default(),
                "isPersonal": r.try_get::<bool, _>("isPersonal").unwrap_or(false),
                "ownerId": r.try_get::<String, _>("ownerId").unwrap_or_default(),
                "createdAt": iso(r, "createdAt"),
                "updatedAt": iso(r, "updatedAt"),
            })
        })
        .collect();
    Ok(Json(json!(list)))
}

async fn v1_connections_list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let crypto = state.crypto.as_ref().ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;
    let rows = sqlx::query(&format!(
        r#"SELECT {CONN_COLS} FROM "Connection" c
           WHERE c."ownerId" = $1 OR EXISTS (
             SELECT 1 FROM "ConnectionMember" m WHERE m."connectionId" = c."id" AND m."userId" = $1
           )
           ORDER BY c."createdAt" DESC"#,
    ))
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    let list: Vec<Value> = rows.iter().map(|r| conn_dto(r, crypto)).collect();
    Ok(Json(json!(list)))
}

async fn v1_connection_get(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let crypto = state.crypto.as_ref().ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;
    let row = sqlx::query(&format!(
        r#"SELECT {CONN_COLS} FROM "Connection" c
           WHERE c."id" = $1 AND (c."ownerId" = $2 OR EXISTS (
             SELECT 1 FROM "ConnectionMember" m WHERE m."connectionId" = c."id" AND m."userId" = $2
           )) LIMIT 1"#,
    ))
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    Ok(Json(conn_dto(&row, crypto)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredsIn {
    host: String,
    port: u16,
    #[serde(alias = "username")]
    user: String,
    password: String,
    database: String,
    #[serde(default)]
    ssl_mode: Option<String>,
}
impl CredsIn {
    fn to_json(&self) -> Value {
        json!({ "host": self.host, "port": self.port, "user": self.user, "password": self.password, "database": self.database, "sslMode": self.ssl_mode })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateConnBody {
    name: String,
    dialect: String,
    credentials: CredsIn,
    #[serde(default)]
    read_only: Option<bool>,
    #[serde(default)]
    statement_timeout_ms: Option<i32>,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    via_agent: Option<bool>,
    #[serde(default)]
    agent_id: Option<String>,
}

async fn conn_row_dto(state: &AppState, id: &str, crypto: &crypto::Crypto) -> ApiResult<Json<Value>> {
    let row = sqlx::query(&format!(r#"SELECT {CONN_COLS} FROM "Connection" c WHERE c."id" = $1 LIMIT 1"#))
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(conn_dto(&row, crypto)))
}

async fn v1_connection_create(State(state): State<AppState>, user: AuthUser, Json(body): Json<CreateConnBody>) -> ApiResult<Json<Value>> {
    let crypto = state.crypto.as_ref().ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;
    let id = gen_id();
    let workspace_id: Option<String> = match body.workspace_id {
        Some(w) => {
            let ok: Option<bool> = sqlx::query_scalar(r#"SELECT true FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2 LIMIT 1"#)
                .bind(&w).bind(&user.id).fetch_optional(&state.pool).await?;
            if ok.is_none() {
                return Err(ApiError::bad("You are not a member of that workspace"));
            }
            Some(w)
        }
        None => sqlx::query_scalar::<_, String>(r#"SELECT "id" FROM "Workspace" WHERE "ownerId" = $1 AND "isPersonal" = true LIMIT 1"#)
            .bind(&user.id).fetch_optional(&state.pool).await?,
    };
    let ct = crypto
        .encrypt(&body.credentials.to_json().to_string(), &crypto::Crypto::conn_purpose(&id))
        .map_err(|e| ApiError::internal(e.to_string()))?;
    sqlx::query(
        r#"INSERT INTO "Connection"
             ("id","name","dialect","credentialsCt","readOnly","statementTimeoutMs","ownerId","workspaceId","viaAgent","agentId","requireReview","createdAt","updatedAt")
           VALUES ($1,$2,$3::"Dialect",$4,$5,$6,$7,$8,$9,$10,false,now(),now())"#,
    )
    .bind(&id)
    .bind(&body.name)
    .bind(&body.dialect)
    .bind(&ct)
    .bind(body.read_only.unwrap_or(false))
    .bind(body.statement_timeout_ms.unwrap_or(30000))
    .bind(&user.id)
    .bind(&workspace_id)
    .bind(body.via_agent.unwrap_or(false))
    .bind(&body.agent_id)
    .execute(&state.pool)
    .await?;
    conn_row_dto(&state, &id, crypto).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateConnBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    credentials: Option<CredsIn>,
    #[serde(default)]
    read_only: Option<bool>,
    #[serde(default)]
    statement_timeout_ms: Option<i32>,
}

async fn v1_connection_update(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<UpdateConnBody>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let crypto = state.crypto.as_ref().ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;
    let ct: Option<String> = match &body.credentials {
        Some(cr) => Some(
            crypto
                .encrypt(&cr.to_json().to_string(), &crypto::Crypto::conn_purpose(&id))
                .map_err(|e| ApiError::internal(e.to_string()))?,
        ),
        None => None,
    };
    sqlx::query(
        r#"UPDATE "Connection" SET
             "name" = COALESCE($1, "name"),
             "readOnly" = COALESCE($2, "readOnly"),
             "statementTimeoutMs" = COALESCE($3, "statementTimeoutMs"),
             "credentialsCt" = COALESCE($4, "credentialsCt"),
             "updatedAt" = now()
           WHERE "id" = $5"#,
    )
    .bind(&body.name)
    .bind(body.read_only)
    .bind(body.statement_timeout_ms)
    .bind(&ct)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    conn_row_dto(&state, &id, crypto).await
}

async fn v1_connection_delete(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    if conn_role(&state.pool, &id, &user.id).await?.as_deref() != Some("OWNER") {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the owner can delete a connection"));
    }
    sqlx::query(r#"DELETE FROM "Connection" WHERE "id" = $1 AND "ownerId" = $2"#)
        .bind(&id)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn v1_connection_test(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    match connect_target(&state, &id, &user.id).await {
        Ok(mut c) => match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut *c).await {
            Ok(_) => Ok(Json(json!({ "ok": true }))),
            Err(e) => Ok(Json(json!({ "ok": false, "error": e.to_string() }))),
        },
        Err(e) => Ok(Json(json!({ "ok": false, "error": e.message }))),
    }
}

// ---------------------------------------------------------------------------
// Row editing â€” insert/update/delete on /connections/:id/tables/:name/rows.
// Uses jsonb_populate_record so arbitrary column types map correctly and
// unspecified columns keep their defaults on insert.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RowInsert {
    values: Value,
}
#[derive(Deserialize)]
struct RowUpdate {
    pk: Value,
    values: Value,
}
#[derive(Deserialize)]
struct RowDelete {
    pk: Value,
}

fn json_keys(v: &Value) -> Vec<String> {
    v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
}

async fn row_insert(State(state): State<AppState>, user: AuthUser, Path((id, table)): Path<(String, String)>, Query(q): Query<SchemaQ>, Json(body): Json<RowInsert>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    let keys = json_keys(&body.values);
    if keys.is_empty() {
        return Err(ApiError::bad("No values provided"));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let cols = keys.iter().map(|k| quote_ident(k)).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "WITH ins AS (INSERT INTO {qs}.{qt} ({cols}) SELECT {cols} FROM jsonb_populate_record(NULL::{qs}.{qt}, $1::jsonb) RETURNING *) SELECT to_jsonb(ins) FROM ins",
    );
    let row: Value = sqlx::query_scalar(&sql).bind(&body.values).fetch_one(&mut *c).await?;
    Ok(Json(row))
}

async fn row_update(State(state): State<AppState>, user: AuthUser, Path((id, table)): Path<(String, String)>, Query(q): Query<SchemaQ>, Json(body): Json<RowUpdate>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    let vkeys = json_keys(&body.values);
    let pkeys = json_keys(&body.pk);
    if vkeys.is_empty() || pkeys.is_empty() {
        return Err(ApiError::bad("values and pk are required"));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let set = vkeys.iter().map(|k| { let q = quote_ident(k); format!("{q} = v.{q}") }).collect::<Vec<_>>().join(", ");
    let whr = pkeys.iter().map(|k| { let q = quote_ident(k); format!("o.{q} = k.{q}") }).collect::<Vec<_>>().join(" AND ");
    let sql = format!(
        "WITH upd AS (UPDATE {qs}.{qt} AS o SET {set} \
         FROM jsonb_populate_record(NULL::{qs}.{qt}, $1::jsonb) v, jsonb_populate_record(NULL::{qs}.{qt}, $2::jsonb) k \
         WHERE {whr} RETURNING o.*) SELECT to_jsonb(upd) FROM upd",
    );
    let row: Option<Value> = sqlx::query_scalar(&sql).bind(&body.values).bind(&body.pk).fetch_optional(&mut *c).await?;
    Ok(Json(row.unwrap_or(Value::Null)))
}

async fn row_delete(State(state): State<AppState>, user: AuthUser, Path((id, table)): Path<(String, String)>, Query(q): Query<SchemaQ>, Json(body): Json<RowDelete>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    let pkeys = json_keys(&body.pk);
    if pkeys.is_empty() {
        return Err(ApiError::bad("pk is required"));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let whr = pkeys.iter().map(|k| { let q = quote_ident(k); format!("o.{q} = k.{q}") }).collect::<Vec<_>>().join(" AND ");
    let sql = format!(
        "DELETE FROM {qs}.{qt} AS o USING jsonb_populate_record(NULL::{qs}.{qt}, $1::jsonb) k WHERE {whr}",
    );
    let n = sqlx::query(&sql).bind(&body.pk).execute(&mut *c).await?.rows_affected();
    Ok(Json(json!({ "deleted": n })))
}

#[derive(Deserialize)]
struct BulkDelete {
    pks: Vec<Value>,
}
#[derive(Deserialize)]
struct BulkUpdate {
    pks: Vec<Value>,
    values: Value,
}

fn pk_keys(pks: &[Value]) -> Vec<String> {
    pks.first().map(json_keys).unwrap_or_default()
}

async fn row_bulk_delete(State(state): State<AppState>, user: AuthUser, Path((id, table)): Path<(String, String)>, Query(q): Query<SchemaQ>, Json(body): Json<BulkDelete>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    if body.pks.is_empty() {
        return Ok(Json(json!({ "affectedRows": 0 })));
    }
    let pkeys = pk_keys(&body.pks);
    if pkeys.is_empty() {
        return Err(ApiError::bad("pks entries must have key columns"));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let whr = pkeys.iter().map(|k| { let q = quote_ident(k); format!("o.{q} = k.{q}") }).collect::<Vec<_>>().join(" AND ");
    let sql = format!(
        "DELETE FROM {qs}.{qt} AS o USING jsonb_populate_recordset(NULL::{qs}.{qt}, $1::jsonb) k WHERE {whr}",
    );
    let n = sqlx::query(&sql).bind(Value::Array(body.pks)).execute(&mut *c).await?.rows_affected();
    Ok(Json(json!({ "affectedRows": n })))
}

async fn row_bulk_update(State(state): State<AppState>, user: AuthUser, Path((id, table)): Path<(String, String)>, Query(q): Query<SchemaQ>, Json(body): Json<BulkUpdate>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    if !core_table_exists(&mut *c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    if body.pks.is_empty() {
        return Ok(Json(json!({ "affectedRows": 0 })));
    }
    let pkeys = pk_keys(&body.pks);
    let vkeys = json_keys(&body.values);
    if pkeys.is_empty() || vkeys.is_empty() {
        return Err(ApiError::bad("pks and values are required"));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let set = vkeys.iter().map(|k| { let q = quote_ident(k); format!("{q} = v.{q}") }).collect::<Vec<_>>().join(", ");
    let whr = pkeys.iter().map(|k| { let q = quote_ident(k); format!("o.{q} = k.{q}") }).collect::<Vec<_>>().join(" AND ");
    let sql = format!(
        "UPDATE {qs}.{qt} AS o SET {set} \
         FROM jsonb_populate_record(NULL::{qs}.{qt}, $1::jsonb) v, jsonb_populate_recordset(NULL::{qs}.{qt}, $2::jsonb) k \
         WHERE {whr}",
    );
    let n = sqlx::query(&sql).bind(&body.values).bind(Value::Array(body.pks)).execute(&mut *c).await?.rows_affected();
    Ok(Json(json!({ "affectedRows": n })))
}

// ---------------------------------------------------------------------------
// Read-only introspection: definition (DDL), ER, functions, triggers, indexes.
// No per-user masking/filtering â€” identical output for every reader.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SchemaTableQ {
    schema: Option<String>,
    table: Option<String>,
}

async fn v1_definition(State(state): State<AppState>, user: AuthUser, Path((id, name)): Path<(String, String)>, Query(q): Query<SchemaQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());

    let cols = sqlx::query(
        "SELECT a.attname::text AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, \
                NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr \
           FROM pg_attribute a \
           JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
           LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
          ORDER BY a.attnum",
    ).bind(&schema).bind(&name).fetch_all(&mut *c).await?;
    if cols.is_empty() {
        return Err(ApiError::bad(format!("Unknown table {schema}.{name}")));
    }
    let cons = sqlx::query(
        "SELECT con.conname::text AS name, pg_catalog.pg_get_constraintdef(con.oid, true) AS def \
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = $1 AND c.relname = $2 ORDER BY con.contype DESC, con.conname",
    ).bind(&schema).bind(&name).fetch_all(&mut *c).await?;
    let tablespace: String = sqlx::query_scalar(
        "SELECT COALESCE(t.spcname, 'pg_default')::text FROM pg_class c \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
           LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace \
          WHERE n.nspname = $1 AND c.relname = $2",
    ).bind(&schema).bind(&name).fetch_optional(&mut *c).await?.unwrap_or_else(|| "pg_default".into());
    let idx = sqlx::query(
        "SELECT i.relname::text AS name, pg_catalog.pg_get_indexdef(ix.indexrelid, 0, true) AS def, \
                (con.conname IS NOT NULL) AS is_constraint \
           FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid \
           JOIN pg_class i ON i.oid = ix.indexrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
           LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid \
          WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.relname",
    ).bind(&schema).bind(&name).fetch_all(&mut *c).await?;
    let trig = sqlx::query(
        "SELECT pg_catalog.pg_get_triggerdef(tg.oid, true) AS def \
           FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = $1 AND c.relname = $2 AND NOT tg.tgisinternal ORDER BY tg.tgname",
    ).bind(&schema).bind(&name).fetch_all(&mut *c).await?;

    let qualified = format!("{}.{}", quote_ident(&schema), quote_ident(&name));
    let mut body: Vec<String> = Vec::new();
    for r in &cols {
        let cn: String = r.try_get("name").unwrap_or_default();
        let ty: String = r.try_get("type").unwrap_or_default();
        let nullable: bool = r.try_get("nullable").unwrap_or(true);
        let def: Option<String> = r.try_get("default_expr").ok().flatten();
        let mut s = format!("  {} {}", quote_ident(&cn), ty);
        s.push_str(if nullable { " NULL" } else { " NOT NULL" });
        if let Some(d) = def { s.push_str(&format!(" DEFAULT {d}")); }
        body.push(s);
    }
    for r in &cons {
        let cn: String = r.try_get("name").unwrap_or_default();
        let def: String = r.try_get("def").unwrap_or_default();
        body.push(format!("  CONSTRAINT {} {}", quote_ident(&cn), def));
    }
    let mut out = format!("CREATE TABLE {qualified} (\n{}\n) TABLESPACE {tablespace};", body.join(",\n"));
    let idx_defs: Vec<String> = idx
        .iter()
        .filter(|r| !r.try_get::<bool, _>("is_constraint").unwrap_or(false))
        .map(|r| format!("{};", r.try_get::<String, _>("def").unwrap_or_default()))
        .collect();
    if !idx_defs.is_empty() {
        out.push_str("\n\n");
        out.push_str(&idx_defs.join("\n\n"));
    }
    let trig_defs: Vec<String> = trig.iter().map(|r| format!("{};", r.try_get::<String, _>("def").unwrap_or_default())).collect();
    if !trig_defs.is_empty() {
        out.push_str("\n\n");
        out.push_str(&trig_defs.join("\n\n"));
    }
    Ok(Json(json!({ "sql": out })))
}

async fn v1_er(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Query(q): Query<SchemaQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema;
    let cols = sqlx::query(
        "SELECT n.nspname::text AS schema, cls.relname::text AS tbl, a.attname::text AS name, \
                format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS nullable, \
                COALESCE(pk.is_pk, false) AS is_pk \
           FROM pg_class cls JOIN pg_namespace n ON n.oid = cls.relnamespace \
           JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped \
           LEFT JOIN LATERAL (SELECT true AS is_pk FROM pg_index i WHERE i.indrelid = cls.oid \
                 AND i.indisprimary AND a.attnum = ANY(i.indkey) LIMIT 1) pk ON true \
          WHERE cls.relkind IN ('r','v','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') \
            AND ($1::text IS NULL OR n.nspname = $1) \
          ORDER BY n.nspname, cls.relname, a.attnum",
    ).bind(&schema).fetch_all(&mut *c).await?;

    let mut order: Vec<String> = Vec::new();
    let mut nodes: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for r in &cols {
        let sch: String = r.try_get("schema").unwrap_or_default();
        let tbl: String = r.try_get("tbl").unwrap_or_default();
        let key = format!("{sch}.{tbl}");
        let col = json!({
            "name": r.try_get::<String, _>("name").unwrap_or_default(),
            "type": r.try_get::<String, _>("data_type").unwrap_or_default(),
            "pk": r.try_get::<bool, _>("is_pk").unwrap_or(false),
            "nullable": r.try_get::<bool, _>("nullable").unwrap_or(true),
        });
        let entry = nodes.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            json!({ "id": key, "schema": sch, "name": tbl, "columns": [] })
        });
        entry["columns"].as_array_mut().unwrap().push(col);
    }
    let node_list: Vec<Value> = order.into_iter().filter_map(|k| nodes.remove(&k)).collect();

    let fks = sqlx::query(
        "SELECT con.conname::text AS name, n.nspname::text AS schema, cls.relname::text AS tbl, \
           (SELECT array_agg(att.attname::text ORDER BY ord.pos) FROM unnest(con.conkey) WITH ORDINALITY AS ord(col,pos) \
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.col)::text[] AS columns, \
           rn.nspname::text AS ref_schema, rcls.relname::text AS ref_table, \
           (SELECT array_agg(att.attname::text ORDER BY ord.pos) FROM unnest(con.confkey) WITH ORDINALITY AS ord(col,pos) \
              JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.col)::text[] AS ref_columns \
           FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid \
           JOIN pg_namespace n ON n.oid = cls.relnamespace \
           JOIN pg_class rcls ON rcls.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rcls.relnamespace \
          WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog','information_schema') \
            AND ($1::text IS NULL OR n.nspname = $1)",
    ).bind(&schema).fetch_all(&mut *c).await?;
    let edges: Vec<Value> = fks
        .iter()
        .map(|r| {
            let sch: String = r.try_get("schema").unwrap_or_default();
            let tbl: String = r.try_get("tbl").unwrap_or_default();
            let rsch: String = r.try_get("ref_schema").unwrap_or_default();
            let rtbl: String = r.try_get("ref_table").unwrap_or_default();
            json!({
                "id": r.try_get::<String, _>("name").unwrap_or_default(),
                "source": format!("{sch}.{tbl}"),
                "target": format!("{rsch}.{rtbl}"),
                "columns": r.try_get::<Vec<String>, _>("columns").unwrap_or_default(),
                "refColumns": r.try_get::<Vec<String>, _>("ref_columns").unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "nodes": node_list, "edges": edges })))
}

async fn v1_functions(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Query(q): Query<SchemaQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        "SELECT n.nspname::text AS schema, p.proname::text AS name, l.lanname::text AS language, \
                pg_get_function_result(p.oid) AS ret, pg_get_function_arguments(p.oid) AS args \
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang \
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND ($1::text IS NULL OR n.nspname = $1) \
          ORDER BY n.nspname, p.proname",
    ).bind(&q.schema).fetch_all(&mut *c).await?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "schema": r.try_get::<String, _>("schema").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "language": r.try_get::<String, _>("language").unwrap_or_default(),
        "returnType": r.try_get::<Option<String>, _>("ret").ok().flatten(),
        "arguments": r.try_get::<Option<String>, _>("args").ok().flatten(),
    })).collect();
    Ok(Json(json!(out)))
}

async fn v1_triggers(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Query(q): Query<SchemaQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        "SELECT trigger_schema::text AS schema, event_object_table::text AS \"table\", trigger_name::text AS name, \
                action_timing::text AS timing, event_manipulation::text AS event, action_statement::text AS statement \
           FROM information_schema.triggers WHERE ($1::text IS NULL OR trigger_schema = $1) \
          ORDER BY trigger_schema, event_object_table, trigger_name",
    ).bind(&q.schema).fetch_all(&mut *c).await?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "schema": r.try_get::<String, _>("schema").unwrap_or_default(),
        "table": r.try_get::<String, _>("table").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "timing": r.try_get::<Option<String>, _>("timing").ok().flatten(),
        "event": r.try_get::<Option<String>, _>("event").ok().flatten(),
        "statement": r.try_get::<Option<String>, _>("statement").ok().flatten(),
    })).collect();
    Ok(Json(json!(out)))
}

async fn v1_indexes(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Query(q): Query<SchemaTableQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        "SELECT n.nspname::text AS schema, c.relname::text AS tbl, i.relname::text AS name, \
                ix.indisunique AS is_unique, ix.indisprimary AS is_primary, am.amname::text AS method, \
                array_agg(a.attname::text ORDER BY k.ordinality)::text[] AS columns \
           FROM pg_index ix JOIN pg_class c ON c.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_am am ON am.oid = i.relam \
           JOIN unnest(ix.indkey) WITH ORDINALITY k(attnum, ordinality) ON true \
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum \
          WHERE n.nspname NOT IN ('pg_catalog','information_schema') \
            AND ($1::text IS NULL OR n.nspname = $1) AND ($2::text IS NULL OR c.relname = $2) \
          GROUP BY n.nspname, c.relname, i.relname, ix.indisunique, ix.indisprimary, am.amname \
          ORDER BY n.nspname, c.relname, i.relname",
    ).bind(&q.schema).bind(&q.table).fetch_all(&mut *c).await?;
    let out: Vec<Value> = rows.iter().map(|r| json!({
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "schema": r.try_get::<String, _>("schema").unwrap_or_default(),
        "table": r.try_get::<String, _>("tbl").unwrap_or_default(),
        "columns": r.try_get::<Vec<String>, _>("columns").unwrap_or_default(),
        "isUnique": r.try_get::<bool, _>("is_unique").unwrap_or(false),
        "isPrimary": r.try_get::<bool, _>("is_primary").unwrap_or(false),
        "method": r.try_get::<String, _>("method").unwrap_or_default(),
    })).collect();
    Ok(Json(json!(out)))
}

// ---------------------------------------------------------------------------
// Connection access role + helpers (shared by member-scoped resources).
// ---------------------------------------------------------------------------

/// Returns the user's effective role on a connection ("OWNER" for the owner,
/// else the member role), or None if they have no access.
async fn conn_role(pool: &PgPool, conn_id: &str, user_id: &str) -> ApiResult<Option<String>> {
    // Matches v1 RbacService.effectiveRole precedence: connection owner > direct
    // ConnectionMember grant > workspace membership.
    let role: Option<Option<String>> = sqlx::query_scalar(
        r#"SELECT CASE
               WHEN c."ownerId" = $2 THEN 'OWNER'
               WHEN m."role" IS NOT NULL THEN m."role"::text
               WHEN wm."role" IS NOT NULL THEN wm."role"::text
               ELSE NULL END
           FROM "Connection" c
           LEFT JOIN "ConnectionMember" m ON m."connectionId" = c."id" AND m."userId" = $2
           LEFT JOIN "WorkspaceMember" wm ON wm."workspaceId" = c."workspaceId" AND wm."userId" = $2
           WHERE c."id" = $1 LIMIT 1"#,
    )
    .bind(conn_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    Ok(role.flatten())
}

async fn require_read(pool: &PgPool, conn_id: &str, user_id: &str) -> ApiResult<()> {
    conn_role(pool, conn_id, user_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"))
}

async fn require_write(pool: &PgPool, conn_id: &str, user_id: &str) -> ApiResult<()> {
    match conn_role(pool, conn_id, user_id).await?.as_deref() {
        Some("OWNER") | Some("EDITOR") => Ok(()),
        Some(_) => Err(ApiError::new(StatusCode::FORBIDDEN, "Requires editor access")),
        None => Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection")),
    }
}

/// cuid-like id (starts with 'c'; unique â€” matches Prisma's `@default(cuid())`
/// well enough for a String @id column).
fn gen_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let s: String = (0..24)
        .map(|_| std::char::from_digit(rng.gen_range(0..36), 36).unwrap())
        .collect();
    format!("c{s}")
}

fn iso(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<chrono::NaiveDateTime, _>(col).ok().map(|d| d.and_utc().to_rfc3339())
}

// ---------------------------------------------------------------------------
// Saved queries â€” CRUD under /connections/:id/saved-queries.
// ---------------------------------------------------------------------------

const SQ_COLS: &str = r#""id","name","sqlText","chartConfig","createdAt","updatedAt""#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedQueryBody {
    name: String,
    sql_text: String,
    #[serde(default)]
    chart_config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedQueryPatch {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    sql_text: Option<String>,
    #[serde(default)]
    chart_config: Option<Value>,
}

fn sq_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "sqlText": r.try_get::<String, _>("sqlText").unwrap_or_default(),
        "chartConfig": r.try_get::<Option<Value>, _>("chartConfig").ok().flatten(),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

async fn sq_list(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    require_read(&state.pool, &id, &user.id).await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {SQ_COLS} FROM "SavedQuery" WHERE "connectionId" = $1 ORDER BY "createdAt" DESC"#,
    ))
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.iter().map(sq_dto).collect::<Vec<_>>())))
}

async fn sq_get(State(state): State<AppState>, user: AuthUser, Path((id, qid)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    require_read(&state.pool, &id, &user.id).await?;
    let r = sqlx::query(&format!(
        r#"SELECT {SQ_COLS} FROM "SavedQuery" WHERE "id" = $1 AND "connectionId" = $2 LIMIT 1"#,
    ))
    .bind(&qid)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Saved query not found"))?;
    Ok(Json(sq_dto(&r)))
}

async fn sq_create(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<SavedQueryBody>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let r = sqlx::query(&format!(
        r#"INSERT INTO "SavedQuery" ("id","name","sqlText","chartConfig","userId","connectionId","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,now(),now()) RETURNING {SQ_COLS}"#,
    ))
    .bind(gen_id())
    .bind(&body.name)
    .bind(&body.sql_text)
    .bind(&body.chart_config)
    .bind(&user.id)
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(sq_dto(&r)))
}

async fn sq_update(State(state): State<AppState>, user: AuthUser, Path((id, qid)): Path<(String, String)>, Json(body): Json<SavedQueryPatch>) -> ApiResult<Json<Value>> {
    require_write(&state.pool, &id, &user.id).await?;
    let r = sqlx::query(&format!(
        r#"UPDATE "SavedQuery" SET
             "name" = COALESCE($1, "name"),
             "sqlText" = COALESCE($2, "sqlText"),
             "chartConfig" = COALESCE($3, "chartConfig"),
             "updatedAt" = now()
           WHERE "id" = $4 AND "connectionId" = $5 RETURNING {SQ_COLS}"#,
    ))
    .bind(&body.name)
    .bind(&body.sql_text)
    .bind(&body.chart_config)
    .bind(&qid)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Saved query not found"))?;
    Ok(Json(sq_dto(&r)))
}

async fn sq_delete(State(state): State<AppState>, user: AuthUser, Path((id, qid)): Path<(String, String)>) -> ApiResult<StatusCode> {
    require_write(&state.pool, &id, &user.id).await?;
    sqlx::query(r#"DELETE FROM "SavedQuery" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&qid)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Snippets â€” per-user reusable SQL blocks under /snippets. Owner-scoped only
// (no connection membership), so a straight app-DB CRUD port.
// ---------------------------------------------------------------------------

const SNIPPET_COLS: &str = r#""id","userId","connectionId","name","sqlText","createdAt","updatedAt""#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSnippet {
    name: String,
    sql_text: String,
    #[serde(default)]
    connection_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateSnippet {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    sql_text: Option<String>,
}

#[derive(Deserialize)]
struct SnippetListQ {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
}

fn snippet_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "connectionId": r.try_get::<Option<String>, _>("connectionId").ok().flatten(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "sqlText": r.try_get::<String, _>("sqlText").unwrap_or_default(),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

async fn snippet_list(State(state): State<AppState>, user: AuthUser, Query(q): Query<SnippetListQ>) -> ApiResult<Json<Value>> {
    let rows = match q.connection_id.filter(|s| !s.is_empty()) {
        Some(cid) => sqlx::query(&format!(
            r#"SELECT {SNIPPET_COLS} FROM "Snippet" WHERE "userId" = $1 AND ("connectionId" IS NULL OR "connectionId" = $2) ORDER BY "updatedAt" DESC LIMIT 200"#,
        )).bind(&user.id).bind(cid).fetch_all(&state.pool).await?,
        None => sqlx::query(&format!(
            r#"SELECT {SNIPPET_COLS} FROM "Snippet" WHERE "userId" = $1 ORDER BY "updatedAt" DESC LIMIT 200"#,
        )).bind(&user.id).fetch_all(&state.pool).await?,
    };
    Ok(Json(json!(rows.iter().map(snippet_dto).collect::<Vec<_>>())))
}

async fn snippet_create(State(state): State<AppState>, user: AuthUser, Json(body): Json<CreateSnippet>) -> ApiResult<(StatusCode, Json<Value>)> {
    let r = sqlx::query(&format!(
        r#"INSERT INTO "Snippet" ("id","userId","name","sqlText","connectionId","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,now(),now()) RETURNING {SNIPPET_COLS}"#,
    ))
    .bind(gen_id())
    .bind(&user.id)
    .bind(&body.name)
    .bind(&body.sql_text)
    .bind(&body.connection_id)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(snippet_dto(&r))))
}

async fn snippet_owner(pool: &PgPool, id: &str, user_id: &str) -> ApiResult<()> {
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "userId" FROM "Snippet" WHERE "id" = $1"#)
        .bind(id).fetch_optional(pool).await?;
    match owner {
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "Not found")),
        Some(o) if o != user_id => Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden")),
        _ => Ok(()),
    }
}

async fn snippet_update(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<UpdateSnippet>) -> ApiResult<Json<Value>> {
    snippet_owner(&state.pool, &id, &user.id).await?;
    let r = sqlx::query(&format!(
        r#"UPDATE "Snippet" SET "name" = COALESCE($1,"name"), "sqlText" = COALESCE($2,"sqlText"), "updatedAt" = now()
           WHERE "id" = $3 RETURNING {SNIPPET_COLS}"#,
    ))
    .bind(&body.name)
    .bind(&body.sql_text)
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(snippet_dto(&r)))
}

async fn snippet_delete(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<StatusCode> {
    snippet_owner(&state.pool, &id, &user.id).await?;
    sqlx::query(r#"DELETE FROM "Snippet" WHERE "id" = $1"#).bind(&id).execute(&state.pool).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Users â€” GET/PATCH /users/me (AuthUser shape).
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfile {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    density: Option<String>,
    #[serde(default)]
    theme: Option<String>,
}

async fn me_dto(pool: &PgPool, id: &str) -> ApiResult<Json<Value>> {
    let r = sqlx::query(
        r#"SELECT u."id", u."email", u."displayName", u."density"::text AS density,
                  u."theme"::text AS theme, u."isAdmin", u."createdAt",
                  COALESCE(t."enabled", false) AS totp_enabled
           FROM "User" u LEFT JOIN "TotpSecret" t ON t."userId" = u."id"
           WHERE u."id" = $1 LIMIT 1"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;
    Ok(Json(json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "email": r.try_get::<String, _>("email").unwrap_or_default(),
        "displayName": r.try_get::<Option<String>, _>("displayName").ok().flatten(),
        "density": r.try_get::<String, _>("density").unwrap_or_default(),
        "theme": r.try_get::<String, _>("theme").unwrap_or_default(),
        "isAdmin": r.try_get::<bool, _>("isAdmin").unwrap_or(false),
        "createdAt": r.try_get::<chrono::NaiveDateTime, _>("createdAt").ok().map(|d| d.and_utc().to_rfc3339()),
        "totpEnabled": r.try_get::<bool, _>("totp_enabled").unwrap_or(false),
    })))
}

async fn v1_me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    me_dto(&state.pool, &user.id).await
}

async fn v1_update_me(State(state): State<AppState>, user: AuthUser, Json(body): Json<UpdateProfile>) -> ApiResult<Json<Value>> {
    sqlx::query(
        r#"UPDATE "User" SET
             "displayName" = COALESCE($1, "displayName"),
             "density" = COALESCE($2::"Density", "density"),
             "theme" = COALESCE($3::"Theme", "theme"),
             "updatedAt" = now()
           WHERE "id" = $4"#,
    )
    .bind(&body.display_name)
    .bind(&body.density)
    .bind(&body.theme)
    .bind(&user.id)
    .execute(&state.pool)
    .await?;
    me_dto(&state.pool, &user.id).await
}

// ---------------------------------------------------------------------------
// v1-shaped hot path â€” these match the frontend's exact endpoints/shapes, so
// the perf-critical calls run in Rust instead of proxying to Node.
// ---------------------------------------------------------------------------

async fn v1_schemas(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!(core_schemas(&mut *c).await?)))
}

async fn v1_tables(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%' \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&mut *c)
    .await?;
    let tables: Vec<Value> = rows
        .iter()
        .map(|r| {
            let tt: String = r.get("table_type");
            json!({
                "name": r.get::<String, _>("table_name"),
                "schema": r.get::<String, _>("table_schema"),
                "type": if tt == "VIEW" { "view" } else { "table" },
            })
        })
        .collect();
    Ok(Json(json!(tables)))
}

#[derive(Deserialize)]
struct SchemaQ {
    schema: Option<String>,
}

const COLUMN_INFO_SQL: &str = r#"
SELECT
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default,
  c.character_maximum_length::int AS char_max_length,
  c.numeric_precision::int AS numeric_precision,
  c.numeric_scale::int AS numeric_scale,
  (c.is_identity = 'YES' OR c.column_default LIKE 'nextval%') AS is_identity,
  COALESCE(pk.p, false) AS is_pk,
  COALESCE(uq.u, false) AS is_unique,
  col_description((quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass, c.ordinal_position::int) AS comment,
  fk.ref_schema, fk.ref_table, fk.ref_column
FROM information_schema.columns c
LEFT JOIN (
  SELECT kcu.column_name, true AS p FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
) pk ON pk.column_name = c.column_name
LEFT JOIN (
  SELECT kcu.column_name, true AS u FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1 AND tc.table_name = $2
) uq ON uq.column_name = c.column_name
LEFT JOIN (
  SELECT kcu.column_name, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
) fk ON fk.column_name = c.column_name
WHERE c.table_schema = $1 AND c.table_name = $2
ORDER BY c.ordinal_position
"#;

/// Serialize COLUMN_INFO_SQL rows into v1's ColumnMeta shape (shared by the
/// columns endpoint and the `/data` response's `columns` field).
fn column_infos(rows: &[PgRow]) -> Vec<Value> {
    rows.iter()
        .map(|r| {
            let ref_table: Option<String> = r.try_get("ref_table").ok().flatten();
            let fk = ref_table.map(|t| {
                json!({
                    "table": t,
                    "column": r.try_get::<Option<String>, _>("ref_column").ok().flatten().unwrap_or_default(),
                    "schema": r.try_get::<Option<String>, _>("ref_schema").ok().flatten(),
                })
            });
            json!({
                "name": r.try_get::<String, _>("column_name").unwrap_or_default(),
                "dataType": r.try_get::<String, _>("data_type").unwrap_or_default(),
                "nullable": r.try_get::<String, _>("is_nullable").map(|s| s == "YES").unwrap_or(true),
                "defaultValue": r.try_get::<Option<String>, _>("column_default").ok().flatten(),
                "isPrimaryKey": r.try_get::<bool, _>("is_pk").unwrap_or(false),
                "isUnique": r.try_get::<bool, _>("is_unique").unwrap_or(false),
                "isIdentity": r.try_get::<bool, _>("is_identity").unwrap_or(false),
                "comment": r.try_get::<Option<String>, _>("comment").ok().flatten(),
                "charMaxLength": r.try_get::<Option<i32>, _>("char_max_length").ok().flatten(),
                "numericPrecision": r.try_get::<Option<i32>, _>("numeric_precision").ok().flatten(),
                "numericScale": r.try_get::<Option<i32>, _>("numeric_scale").ok().flatten(),
                "fk": fk,
            })
        })
        .collect()
}

async fn v1_conn_columns(State(state): State<AppState>, user: AuthUser, Path((id, name)): Path<(String, String)>, Query(q): Query<SchemaQ>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    let rows = sqlx::query(COLUMN_INFO_SQL).bind(&schema).bind(&name).fetch_all(&mut *c).await?;
    Ok(Json(json!(column_infos(&rows))))
}

// ---------------------------------------------------------------------------
// Table data â€” the grid's paginated/filtered/sorted rows. The connection OWNER
// bypasses row-level security (no row filters, no column masks â€” same policy as
// v1), so we serve them from Rust. Everyone else forwards to v1, which applies
// their row filter predicate + column masks. Agent connections were already
// short-circuited by `agent_guard` upstream.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct DataQuery {
    schema: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    #[serde(rename = "orderBy")]
    order_by: Option<String>,
    filters: Option<String>,
}

#[derive(Deserialize)]
struct FilterItem {
    column: String,
    op: String,
    #[serde(default)]
    value: Value,
}

/// A filter value as bindable text (NULL-preserving) â€” mirrors node-postgres
/// sending an untyped param that Postgres coerces to the column type via CAST.
fn val_to_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

/// Map column name -> a castable type string (`format_type`), e.g. "integer",
/// "character varying(255)", "public.my_enum", "timestamp with time zone".
async fn column_cast_types(c: &mut PgConnection, schema: &str, table: &str) -> Result<std::collections::HashMap<String, String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS ftype \
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
    ).bind(schema).bind(table).fetch_all(&mut *c).await?;
    Ok(rows.iter().map(|r| (
        r.try_get::<String, _>("name").unwrap_or_default(),
        r.try_get::<String, _>("ftype").unwrap_or_else(|_| "text".into()),
    )).collect())
}

const ALLOWED_FILTER_OPS: &[&str] = &["=", "!=", "<", "<=", ">", ">=", "like", "ilike", "is null", "is not null", "in"];

/// Primary-key column names in key order (empty when the table has no PK).
/// Used as the deterministic ORDER BY tiebreaker for stable pagination.
async fn primary_key_cols(c: &mut PgConnection, schema: &str, table: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT a.attname::text AS name \
           FROM pg_index i \
           JOIN pg_class cl ON cl.oid = i.indrelid \
           JOIN pg_namespace n ON n.oid = cl.relnamespace \
           JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
           JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum \
          WHERE n.nspname = $1 AND cl.relname = $2 AND i.indisprimary \
          ORDER BY k.ord",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *c)
    .await?;
    Ok(rows.iter().filter_map(|r| r.try_get::<String, _>("name").ok()).collect())
}

async fn v1_table_data(State(state): State<AppState>, user: AuthUser, Path((id, name)): Path<(String, String)>, Query(q): Query<DataQuery>, req: Request) -> Result<Response, ApiError> {
    // Owner bypasses masks/row-filters â†’ serve in Rust. Anyone else â†’ v1 (which
    // enforces their row predicate + column masks). Missing/other â†’ v1 decides.
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Connection" WHERE "id" = $1"#)
        .bind(&id).fetch_optional(&state.pool).await?;
    if owner.as_deref() != Some(user.id.as_str()) {
        return Ok(proxy(State(state), req).await);
    }

    let mut c = connect_target(&state, &id, &user.id).await?;
    let schema = q.schema.clone().unwrap_or_else(|| "public".into());
    let casts = column_cast_types(&mut c, &schema, &name).await?;
    if casts.is_empty() {
        return Err(ApiError::bad(format!("No such table {schema}.{name}")));
    }
    let (qs, qt) = (quote_ident(&schema), quote_ident(&name));
    let fqtn = format!("{qs}.{qt}");

    // Filters â†’ WHERE, binding untyped-then-cast params (v1 op whitelist).
    let filters: Vec<FilterItem> = match &q.filters {
        Some(s) if !s.trim().is_empty() => serde_json::from_str(s).map_err(|_| ApiError::bad("Invalid filters"))?,
        _ => vec![],
    };
    let mut where_parts: Vec<String> = Vec::new();
    let mut binds: Vec<Option<String>> = Vec::new();
    for f in &filters {
        let cast = casts.get(&f.column).ok_or_else(|| ApiError::bad(format!("Unknown column {}", f.column)))?;
        let op = f.op.to_lowercase();
        if !ALLOWED_FILTER_OPS.contains(&op.as_str()) {
            return Err(ApiError::bad(format!("Disallowed filter op {op}")));
        }
        let qcol = quote_ident(&f.column);
        if op == "is null" || op == "is not null" {
            where_parts.push(format!("{qcol} {}", op.to_uppercase()));
        } else if op == "in" {
            match f.value.as_array() {
                Some(arr) if !arr.is_empty() => {
                    let mut phs = Vec::new();
                    for el in arr {
                        binds.push(val_to_text(el));
                        phs.push(format!("CAST(${} AS {cast})", binds.len()));
                    }
                    where_parts.push(format!("{qcol} IN ({})", phs.join(",")));
                }
                _ => where_parts.push("false".into()),
            }
        } else if op == "like" || op == "ilike" {
            // Text pattern match â€” column must be text-comparable (as in v1).
            binds.push(val_to_text(&f.value));
            where_parts.push(format!("{qcol} {} ${}", op.to_uppercase(), binds.len()));
        } else {
            binds.push(val_to_text(&f.value));
            where_parts.push(format!("{qcol} {} CAST(${} AS {cast})", op.to_uppercase(), binds.len()));
        }
    }
    let where_sql = if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };

    // ORDER BY (whitelist against real columns).
    let mut order_cols: Vec<String> = Vec::new();
    let mut sorted_names: Vec<String> = Vec::new();
    if let Some(ob) = &q.order_by {
        for part in ob.split(',').filter(|s| !s.is_empty()) {
            let mut it = part.splitn(2, ':');
            let col = it.next().unwrap_or("");
            let dir = it.next().unwrap_or("asc");
            if col.is_empty() { continue; }
            if !casts.contains_key(col) {
                return Err(ApiError::bad(format!("Unknown column {col}")));
            }
            let d = if dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
            order_cols.push(format!("{} {}", quote_ident(col), d));
            sorted_names.push(col.to_string());
        }
    }
    // STABLE PAGINATION. Postgres returns rows in physical heap order when no
    // ORDER BY is given, and an UPDATE writes a NEW tuple version (usually at
    // the end of the heap) â€” so editing a row made it jump to a different
    // position in the grid, and an index-keyed selection then pointed at the
    // wrong row. Always append the primary key as a tiebreaker so the ordering
    // is total and deterministic: it fixes the unsorted case AND ties within a
    // user sort on a non-unique column. PK is indexed, so LIMIT/OFFSET stays a
    // cheap index scan. Tables with no PK fall back to ctid (physical order â€”
    // same as today's behaviour, the best available without a unique key).
    for pk in primary_key_cols(&mut c, &schema, &name).await? {
        if !sorted_names.contains(&pk) {
            order_cols.push(format!("{} ASC", quote_ident(&pk)));
        }
    }
    if order_cols.is_empty() {
        order_cols.push("ctid ASC".into());
    }
    let order_sql = format!("ORDER BY {}", order_cols.join(", "));

    let limit = q.limit.as_deref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(50).clamp(1, 1000);
    let offset = q.offset.as_deref().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).max(0);

    // Cheap pagination count: reltuples estimate; exact only when small.
    const EXACT_COUNT_THRESHOLD: i64 = 50_000;
    let estimate: i64 = sqlx::query_scalar(
        "SELECT GREATEST(0, c.reltuples)::bigint FROM pg_class c \
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
    ).bind(&schema).bind(&name).fetch_optional(&mut *c).await?.unwrap_or(0);

    let mut total: Option<i64>;
    let mut total_is_estimate = false;
    if where_parts.is_empty() {
        if estimate < EXACT_COUNT_THRESHOLD {
            total = Some(sqlx::query_scalar::<_, i64>(&format!("SELECT count(*)::bigint FROM {fqtn}")).fetch_one(&mut *c).await?);
        } else {
            total = Some(estimate);
            total_is_estimate = true;
        }
    } else if estimate < EXACT_COUNT_THRESHOLD {
        let sql = format!("SELECT count(*)::bigint FROM {fqtn} {where_sql}");
        let mut cq = sqlx::query_scalar::<_, i64>(&sql);
        for b in &binds { cq = cq.bind(b.as_deref()); }
        total = Some(cq.fetch_one(&mut *c).await?);
    } else {
        total = None;
    }

    // Rows as a jsonb array (order-preserving; serde_json preserve_order on).
    let rows_sql = format!(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM \
         (SELECT * FROM {fqtn} {where_sql} {order_sql} LIMIT {limit} OFFSET {offset}) t",
    );
    let mut rq = sqlx::query_scalar::<_, Value>(&rows_sql);
    for b in &binds { rq = rq.bind(b.as_deref()); }
    let rows_json: Value = rq.fetch_one(&mut *c).await?;

    // Columns (ColumnMeta shape) for the response.
    let colrows = sqlx::query(COLUMN_INFO_SQL).bind(&schema).bind(&name).fetch_all(&mut *c).await?;
    let cols = column_infos(&colrows);

    // `total: null` when unknown â€” keep the field present.
    Ok(Json(json!({
        "columns": cols,
        "rows": rows_json,
        "total": total,
        "totalIsEstimate": total_is_estimate,
    })).into_response())
}

async fn v1_lookup(State(state): State<AppState>, user: AuthUser, Path((id, name)): Path<(String, String)>, Query(q): Query<LookupQuery>, req: Request) -> Result<Response, ApiError> {
    // Same owner-bypass rule: masks apply to non-owners, so they go to v1.
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Connection" WHERE "id" = $1"#)
        .bind(&id).fetch_optional(&state.pool).await?;
    if owner.as_deref() != Some(user.id.as_str()) {
        return Ok(proxy(State(state), req).await);
    }
    let (schema, column, value) = match (q.schema.clone(), q.column.clone(), q.value.clone()) {
        (Some(s), Some(col), Some(v)) => (s, col, v),
        _ => return Err(ApiError::bad("schema, column and value are required")),
    };
    let mut c = connect_target(&state, &id, &user.id).await?;
    let casts = column_cast_types(&mut c, &schema, &name).await?;
    let cast = casts.get(&column).ok_or_else(|| ApiError::bad(format!("Unknown column {column}")))?;
    let (qs, qt) = (quote_ident(&schema), quote_ident(&name));
    let sql = format!(
        "SELECT to_jsonb(t) FROM (SELECT * FROM {qs}.{qt} WHERE {} = CAST($1 AS {cast}) LIMIT 1) t",
        quote_ident(&column),
    );
    let row: Option<Value> = sqlx::query_scalar(&sql).bind(&value).fetch_optional(&mut *c).await?;
    Ok(Json(json!({ "row": row })).into_response())
}

#[derive(Deserialize)]
struct LookupQuery {
    schema: Option<String>,
    column: Option<String>,
    value: Option<String>,
}

#[derive(Deserialize)]
struct V1QueryBody {
    sql: String,
    #[serde(rename = "maxRows")]
    max_rows: Option<i64>,
}

async fn v1_query(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<V1QueryBody>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let sql = body.sql.trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let max = body.max_rows.unwrap_or(state.max_rows).clamp(1, 100_000);
    let command = sql.split_whitespace().next().unwrap_or("").to_uppercase();
    let start = Instant::now();

    if is_select(&sql) {
        // Column names + types via describe (works even for zero-row results).
        let fields: Vec<Value> = match (&mut c).describe(sql.as_str()).await {
            Ok(d) => d
                .columns()
                .iter()
                .map(|col| json!({ "name": col.name(), "dataType": col.type_info().name() }))
                .collect(),
            Err(_) => vec![],
        };
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {max}) t",
        );
        let rows_json: Value = sqlx::query_scalar(&wrapped).fetch_one(&mut *c).await?;
        let dur = ms(start);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        let fields = if fields.is_empty() {
            derive_columns(&rows_json).into_iter().map(|n| json!({ "name": n })).collect()
        } else {
            fields
        };
        Ok(Json(json!({
            "rows": rows_json,
            "rowCount": row_count,
            "fields": fields,
            "command": command,
            "durationMs": dur,
            "truncated": row_count as i64 >= max,
            "appliedLimit": max,
        })))
    } else {
        let affected = sqlx::query(&sql).execute(&mut *c).await?.rows_affected();
        Ok(Json(json!({
            "rows": [],
            "rowCount": affected,
            "fields": [],
            "command": command,
            "durationMs": ms(start),
        })))
    }
}

// ---------------------------------------------------------------------------
// Strangler proxy â€” forward any unported endpoint to the v1 Node API.
// ---------------------------------------------------------------------------

/// Pull the `{id}` out of `/api/connections/{id}[/...]`, else `None`.
fn conn_id_from_path(path: &str) -> Option<&str> {
    let mut it = path.split('/').filter(|s| !s.is_empty());
    match (it.next(), it.next(), it.next()) {
        (Some("api"), Some("connections"), Some(id)) => Some(id),
        _ => None,
    }
}

/// Is this connection reached through the owner's local tunnel agent?
/// True when this connection is agent-routed AND its agent is NOT currently
/// attached to THIS process — i.e. the request has to go to whoever holds the
/// agent's socket.
///
/// The registry is per-process in both stacks, so during the cutover the agent
/// is attached to exactly one of them. Deciding per-request on live presence
/// makes the switch self-healing instead of a flag day: while /agent-ws still
/// points at Node the agent is absent here and we forward; the moment it
/// reconnects to this process we serve it natively. No coordinated restart, and
/// repointing nginx back rolls it straight back.
async fn via_agent(pool: &PgPool, id: &str) -> bool {
    let row = sqlx::query(r#"SELECT "viaAgent", "agentId" FROM "Connection" WHERE "id" = $1"#)
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    let Some(row) = row else { return false };
    if !row.try_get::<bool, _>("viaAgent").unwrap_or(false) {
        return false;
    }
    match row.try_get::<Option<String>, _>("agentId").ok().flatten() {
        Some(agent_id) => !tunnel::is_online(&agent_id),
        None => true, // agent-routed but unassigned — let v1 produce its error
    }
}

/// Agent-backed connections MUST be served by v1 â€” the tunnel (local TCP proxy
/// fed by the agent WS) lives only in the Node backend. Rust's `connect_target`
/// dials the stored host/port directly, which for a firewalled DB behind an
/// agent can never work. So for any `/api/connections/{id}/*` where the
/// connection is `viaAgent`, short-circuit to the v1 proxy instead of routing
/// to the Rust handler.
async fn agent_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    // Managing the connection ROW is app-DB work — it never touches the target
    // database, so it must not be shipped down the agent tunnel. Without this
    // exemption a viaAgent connection could be created in Rust but never edited
    // here (and agent routing could never be turned off), because the guard
    // matched the bare /api/connections/:id path too.
    let path = req.uri().path();
    let is_bare_connection_route = conn_id_from_path(path)
        .map(|id| path.trim_end_matches('/') == format!("/api/connections/{id}"))
        .unwrap_or(false);
    if is_bare_connection_route && matches!(req.method(), &axum::http::Method::PATCH) {
        return next.run(req).await;
    }

    let id = conn_id_from_path(path).map(|s| s.to_string());
    if let Some(id) = id {
        if via_agent(&state.pool, &id).await {
            return proxy(State(state), req).await;
        }
    }
    next.run(req).await
}

/// The NestJS backend was removed on 2026-08-03 — this process serves the whole
/// product. Anything still calling `proxy` is an endpoint that was never ported
/// (BullMQ schedule writes, federated query, audit revert, SQL transpile,
/// /metrics). Attempting the old HTTP hop would hang until DNS/connect failed
/// and surface as a confusing 502, so answer immediately and say why.
///
/// Set V1_ORIGIN_ENABLED=true to restore forwarding if v1 is ever brought back.
async fn proxy(State(state): State<AppState>, req: Request) -> Response {
    if std::env::var("V1_ORIGIN_ENABLED").map(|v| v != "true").unwrap_or(true) {
        let path = req.uri().path().to_string();
        tracing::warn!("unported endpoint hit after v1 removal: {} {}", req.method(), path);
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({
                "statusCode": 501,
                "message": "This endpoint is not available: it was served by the legacy backend, which has been removed.",
                "error": "Not Implemented",
                "path": path,
            })),
        )
            .into_response();
    }
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, 26_214_400).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };
    let path = parts.uri.path();
    let query = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{}{}{}", state.v1_origin, path, query);
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    let mut rb = state.http.request(method, &url).body(bytes.to_vec());
    for (k, v) in parts.headers.iter() {
        if k == axum::http::header::HOST {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_bytes());
    }
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("v1 proxy error: {e}")).into_response(),
    };

    let status = resp.status();
    let headers = resp.headers().clone();
    let mut builder = Response::builder().status(status.as_u16());
    for (k, v) in headers.iter() {
        let name = k.as_str();
        if name.eq_ignore_ascii_case("set-cookie") {
            // v1 scopes the refresh cookie to /api; the browser is at /v2/api.
            let cookie = String::from_utf8_lossy(v.as_bytes()).replace("Path=/api", "Path=/v2/api");
            builder = builder.header("set-cookie", cookie);
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("connection")
        {
            // hop-by-hop / recomputed by axum
        } else {
            builder = builder.header(name, v.as_bytes());
        }
    }
    // STREAM the upstream body straight through â€” never buffer it.
    //
    // This used to be `resp.bytes().await`, which waited for the ENTIRE upstream
    // response before sending the client a single byte. For `pg_dump` backups
    // that meant: dump runs to completion (minutes on a multi-GB database) with
    // the browser showing 0 B and no progress, the whole dump held in this
    // container's memory (capped at 384 MB, so large dumps could not complete at
    // all), and only then did the download start. It also swallowed errors via
    // `unwrap_or_default()`, which turned a failed read into an empty body with a
    // success status â€” a silently corrupt "backup".
    //
    // Streaming makes time-to-first-byte immediate (which also keeps us under
    // Cloudflare's ~100s first-byte limit), makes memory use constant regardless
    // of dump size, and surfaces a mid-transfer failure as an aborted download
    // instead of a truncated file that looks fine.
    builder
        .body(Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Column names from the first row's keys (order preserved by serde_json's
/// preserve-order isn't enabled, so we read from the JSON object as-is).
fn derive_columns(rows_json: &Value) -> Vec<String> {
    rows_json
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_micros() as f64) / 1000.0
}

// Silence unused-import warning for PgRow (kept for readability of row handlers).
#[allow(dead_code)]
fn _type_anchor(_r: &PgRow) {}
