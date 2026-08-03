//! Operator panel, compliance, abuse triage and query exports — Rust port of
//! v1's `backend/src/operator/`, `backend/src/compliance/`, `backend/src/abuse/`
//! and `backend/src/exports/`.
//!
//! Wire-compatible with v1: same paths, same JSON field names, same status
//! codes and the same human error strings, because the same two frontends
//! (`admin-frontend/src/lib/api.ts` for `/api/operator/*`, `frontend/` for the
//! export button) drive both stacks.
//!
//! ## Access control — three different universes, reproduced exactly
//!
//! 1. `/api/operator/*` — **NOT** `User.isAdmin`. v1 gates every one of these
//!    with `OperatorGuard` (`backend/src/operator/operator.guard.ts`), which is
//!    a completely separate credential system:
//!      * a bearer token from the `Authorization` header **or** the
//!        `operator_access` cookie;
//!      * verified against `OPERATOR_JWT_SECRET` — a *different* secret from the
//!        customer `JWT_ACCESS_SECRET`, so a stolen/forged customer token can
//!        never reach the admin panel;
//!      * payload must carry `kind === "operator"` (defence in depth);
//!      * the `Operator` row (its own table — never joined to `User`) must still
//!        exist and have `disabledAt IS NULL`.
//!    Mutating routes additionally require `SuperOperatorGuard` (`isSuper`).
//!
//!    **Fail-safe**: `OPERATOR_JWT_SECRET` has a *committed dev default* in v1
//!    (`config.service.ts`), which v1 refuses to boot with in production. v2
//!    must never adopt that default — a forgeable operator token hands over the
//!    whole admin panel. So the operator routes are only *registered* when the
//!    env var is present in this process; when it is absent they are simply not
//!    in the router and fall through to main.rs's `.fallback(proxy)`, i.e. v1
//!    keeps serving them exactly as before. There is no code path in which v2
//!    validates an operator token against a guessed or defaulted secret.
//!
//! 2. `/api/admin/compliance/*` — v1 stacks `JwtAuthGuard` + `AdminGuard`, i.e.
//!    the ordinary customer JWT plus a live `User.isAdmin` lookup (never a token
//!    claim). `require_admin` below reproduces that lookup verbatim, same 403
//!    string as `admin.rs`.
//!
//! 3. `POST /api/connections/:id/export` — v1's `RbacGuard` with
//!    `@RequireRole('VIEWER')`: the customer JWT plus an effective-role check on
//!    the connection, and the resolved role decides whether the target session
//!    is read-only.
//!
//! ## Timestamps
//!
//! Every Prisma `DateTime` is `TIMESTAMP(3)` = `timestamp WITHOUT time zone`, so
//! every read/bind goes through `chrono::NaiveDateTime`. Decoding one as
//! `DateTime<Utc>` fails at runtime, and with `.ok().flatten()` that failure
//! becomes a silent `None` — which on a column like `Operator.disabledAt` would
//! mean "not disabled". Security-relevant columns therefore use a typed
//! `try_get` whose error is propagated.
//!
//! ## Not ported (left proxying to v1)
//!
//! * The operator *bootstrap* seed (`OperatorAuthService.bootstrapIfEmpty`) —
//!   not an HTTP route; v1 owns it and both stacks share the database.
//! * Per-route throttling (`@Throttle` on operator login / export). v2 has no
//!   throttler; the per-email lockout that actually stops password guessing IS
//!   ported and shares v1's semantics.
//! * `/api/operator/feedback`, `/announcements`, `/email-templates`,
//!   `/analytics`, `/workspaces/:id/adjustments`, `/invite-codes`, … — these
//!   live in *other* v1 modules (feedback, announcement, …), outside the four
//!   modules in scope, and keep proxying.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Instant;

use axum::body::{to_bytes, Body};
use axum::extract::{FromRequestParts, Path, Query, Request, State};
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{async_trait, Json, Router};
use base64::engine::general_purpose::{STANDARD as B64_STD, URL_SAFE_NO_PAD as B64_URL};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use sqlx::postgres::{PgConnectOptions, PgRow, PgSslMode};
use sqlx::{Connection, PgConnection, PgPool, Row};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::{conn_role, gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn routes() -> Router<AppState> {
    let mut r = Router::new()
        // --- compliance: JwtAuthGuard + AdminGuard -------------------------
        .route("/api/admin/compliance/retention/sweep", post(compliance_sweep))
        .route("/api/admin/compliance/audit/export", get(compliance_audit_export))
        .route("/api/admin/compliance/users/:id/export", get(compliance_export_user))
        .route("/api/admin/compliance/users/:id", delete(compliance_delete_user))
        // --- exports: RbacGuard @RequireRole('VIEWER') ---------------------
        .route("/api/connections/:id/export", post(export_run));

    // SECURITY: only serve the operator panel from Rust when this process was
    // given the real operator signing secret. Without it there is nothing to
    // verify tokens against, and guessing/defaulting would be catastrophic —
    // so leave the routes unregistered and let the v1 proxy keep them.
    if operator_secret().is_some() {
        r = r.merge(operator_routes());
    }
    r
}

fn operator_routes() -> Router<AppState> {
    Router::new()
        // auth (@Public, no OperatorGuard except on `me`)
        .route("/api/operator/auth/login", post(op_login))
        .route("/api/operator/auth/refresh", post(op_refresh))
        .route("/api/operator/auth/logout", post(op_logout))
        .route("/api/operator/auth/me", get(op_me))
        // users
        .route("/api/operator/users", get(op_users_list))
        .route("/api/operator/users/subscriptions/:workspaceId", patch(op_subscription_override))
        .route("/api/operator/users/:id", get(op_user_get).delete(op_user_delete))
        .route("/api/operator/users/:id/approve", post(op_user_approve))
        .route("/api/operator/users/:id/reject", post(op_user_reject))
        .route("/api/operator/users/:id/suspend", post(op_user_suspend))
        .route("/api/operator/users/:id/unsuspend", post(op_user_unsuspend))
        // dashboard
        .route("/api/operator/dashboard/overview", get(op_dashboard_overview))
        // workspaces
        .route("/api/operator/workspaces", get(op_workspaces_list))
        .route("/api/operator/workspaces/:id", get(op_workspace_get))
        // billing
        .route("/api/operator/billing/plans", get(op_plans_get))
        .route("/api/operator/billing/plans/:tier", patch(op_plan_patch))
        .route("/api/operator/billing/settings", get(op_settings_get).patch(op_settings_patch))
        // audit
        .route("/api/operator/audit", get(op_audit_list))
        .route("/api/operator/audit/export", get(op_audit_export))
        // operators
        .route("/api/operator/operators", get(op_operators_list).post(op_operator_create))
        .route("/api/operator/operators/:id/disable", post(op_operator_disable))
        .route("/api/operator/operators/:id/enable", post(op_operator_enable))
        // abuse
        .route("/api/operator/abuse", get(abuse_list))
        .route("/api/operator/abuse/blocked-ips", get(abuse_blocked_list))
        .route("/api/operator/abuse/block-ip", post(abuse_block))
        .route("/api/operator/abuse/block-ip/:ip", delete(abuse_unblock))
        .route("/api/operator/abuse/ack-ip/:ip", post(abuse_ack_ip))
        .route("/api/operator/abuse/:id/ack", post(abuse_ack))
}

// ---------------------------------------------------------------------------
// Small row helpers
// ---------------------------------------------------------------------------

fn s(r: &PgRow, c: &str) -> String {
    r.try_get::<String, _>(c).unwrap_or_default()
}
fn os(r: &PgRow, c: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(c).ok().flatten()
}
fn ob(r: &PgRow, c: &str) -> bool {
    r.try_get::<bool, _>(c).unwrap_or(false)
}
fn oi32(r: &PgRow, c: &str) -> Option<i32> {
    r.try_get::<Option<i32>, _>(c).ok().flatten()
}
fn i32v(r: &PgRow, c: &str) -> i32 {
    r.try_get::<i32, _>(c).unwrap_or(0)
}
fn i64v(r: &PgRow, c: &str) -> i64 {
    r.try_get::<i64, _>(c).unwrap_or(0)
}
fn ojson(r: &PgRow, c: &str) -> Option<Value> {
    r.try_get::<Option<Value>, _>(c).ok().flatten()
}

/// `parseInt(s, 10)` semantics: optional sign then leading digits, trailing
/// junk ignored; `None` when nothing parses (v1's `|| default` then applies).
fn parse_int(v: Option<&str>) -> Option<i64> {
    let t = v?.trim_start();
    let mut out = String::new();
    for (i, c) in t.chars().enumerate() {
        if i == 0 && (c == '-' || c == '+') {
            out.push(c);
        } else if c.is_ascii_digit() {
            out.push(c);
        } else {
            break;
        }
    }
    out.parse::<i64>().ok()
}

/// v1: `Math.min(parseInt(raw,10) || def, max)` / `Math.max(parseInt(raw,10) || 0, 0)`.
/// The extra `.max(0)` on the limit has no v1 counterpart: v1 hands a negative
/// `take` to Prisma, but `LIMIT -1` is a hard Postgres error, so a nonsense
/// `?limit=-1` would surface as a 400 with a raw driver message instead of an
/// empty page. Clamping keeps it a well-formed (if empty) response.
fn limit_offset(limit: Option<&str>, offset: Option<&str>, def: i64, max: i64) -> (i64, i64) {
    let l = parse_int(limit).filter(|v| *v != 0).unwrap_or(def).min(max).max(0);
    let o = parse_int(offset).filter(|v| *v != 0).unwrap_or(0).max(0);
    (l, o)
}

/// JS `new Date().toISOString().slice(0, 10)` — the UTC calendar day.
fn utc_day() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

fn now_naive() -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// v1 `parseTtlToMs`: `<n>[smhd]`, anything else = 24h.
fn parse_ttl_secs(ttl: &str) -> i64 {
    let t = ttl.trim();
    if t.len() < 2 {
        return 24 * 3600;
    }
    let (num, unit) = t.split_at(t.len() - 1);
    let n: i64 = match num.parse() {
        Ok(v) => v,
        Err(_) => return 24 * 3600,
    };
    match unit {
        "s" => n,
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86_400,
        _ => 24 * 3600,
    }
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

// ---------------------------------------------------------------------------
// OperatorGuard  (v1 `operator.guard.ts`)
// ---------------------------------------------------------------------------

/// The operator signing secret. `None` = this process was not given one, which
/// (see `routes()`) means the operator routes are not served here at all.
fn operator_secret() -> Option<String> {
    env_opt("OPERATOR_JWT_SECRET")
}

/// v1's `req.operator` — `{ id, email, isSuper }`, attached by the guard.
struct OperatorCtx {
    id: String,
    /// Carried to mirror v1's `req.operator` shape. No handler in this module
    /// reads it (each one re-reads what it needs from the DB), but dropping it
    /// would make the guard's contract diverge from v1's.
    #[allow(dead_code)]
    email: String,
    is_super: bool,
}

impl OperatorCtx {
    /// v1 `SuperOperatorGuard`.
    fn require_super(&self) -> ApiResult<()> {
        if self.is_super {
            Ok(())
        } else {
            Err(ApiError::new(StatusCode::FORBIDDEN, "Super operator only"))
        }
    }
}

/// HS256 verify + expiry check against the operator secret. Returns the claims.
///
/// v1 signs with `@nestjs/jwt` (jsonwebtoken) using a string secret, which only
/// ever permits HMAC algorithms — an `alg: none` token is rejected there and
/// here. The signature comparison is constant-time.
fn operator_jwt_verify(token: &str, secret: &str) -> Option<Value> {
    let mut it = token.splitn(3, '.');
    let h = it.next()?;
    let p = it.next()?;
    let sig = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let header: Value = serde_json::from_slice(&B64_URL.decode(h).ok()?).ok()?;
    if header.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
        return None;
    }
    let expected = crate::jwt_sign(&format!("{h}.{p}"), secret);
    if !crate::ct_eq(expected.as_bytes(), sig.as_bytes()) {
        return None;
    }
    let claims: Value = serde_json::from_slice(&B64_URL.decode(p).ok()?).ok()?;
    // jsonwebtoken checks `exp`/`nbf` when present. Our signer always sets exp.
    if let Some(exp) = claims.get("exp").and_then(|v| v.as_i64()) {
        if exp < chrono::Utc::now().timestamp() {
            return None;
        }
    }
    if let Some(nbf) = claims.get("nbf").and_then(|v| v.as_i64()) {
        if nbf > chrono::Utc::now().timestamp() {
            return None;
        }
    }
    Some(claims)
}

#[async_trait]
impl FromRequestParts<AppState> for OperatorCtx {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        // v1 `extractToken`: Authorization: Bearer …, else the operator_access
        // cookie (so the admin SPA can run on httpOnly sessions).
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|v| v.to_string())
            .or_else(|| crate::cookie_from_header(&parts.headers, "operator_access"))
            .ok_or_else(|| ApiError::unauthorized("Operator token required"))?;

        let secret =
            operator_secret().ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;
        let claims = operator_jwt_verify(&token, &secret)
            .ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;
        if claims.get("kind").and_then(|v| v.as_str()) != Some("operator") {
            return Err(ApiError::unauthorized("Not an operator token"));
        }
        let sub = claims
            .get("sub")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;

        let row = sqlx::query(
            r#"SELECT "id","email","isSuper","disabledAt" FROM "Operator" WHERE "id" = $1"#,
        )
        .bind(sub)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Operator not found"))?;

        // No `.ok().flatten()` here: a decode error on the disable flag must
        // fail the request, never read as "still enabled".
        let disabled: Option<chrono::NaiveDateTime> = row
            .try_get("disabledAt")
            .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;
        if disabled.is_some() {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "Operator disabled"));
        }
        let is_super: bool = row
            .try_get("isSuper")
            .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;

        Ok(OperatorCtx { id: s(&row, "id"), email: s(&row, "email"), is_super })
    }
}

/// v1 `AdminGuard.canActivate` — live `User.isAdmin` lookup, never a claim.
async fn require_admin(state: &AppState, user_id: &str) -> ApiResult<()> {
    let row = sqlx::query(r#"SELECT "isAdmin" FROM "User" WHERE "id" = $1"#)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let is_admin = match row {
        Some(r) => r
            .try_get::<bool, _>("isAdmin")
            .map_err(|e| ApiError::internal(format!("admin check failed: {e}")))?,
        None => false,
    };
    if !is_admin {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Admin access required"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// OperatorAuditService
// ---------------------------------------------------------------------------

/// Append-only operator audit row. v1 swallows write failures on purpose — an
/// audit hiccup must never roll back the business action.
async fn op_audit(
    pool: &PgPool,
    operator_id: &str,
    action: &str,
    target_type: Option<&str>,
    target_id: Option<&str>,
    reason: Option<&str>,
    metadata: Option<Value>,
) {
    let _ = sqlx::query(
        r#"INSERT INTO "OperatorAuditLog"
             ("id","operatorId","action","targetType","targetId","reason","metadata","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,now())"#,
    )
    .bind(gen_id())
    .bind(operator_id)
    .bind(action)
    .bind(target_type)
    .bind(target_id)
    .bind(reason)
    .bind(metadata)
    .execute(pool)
    .await;
}

// ---------------------------------------------------------------------------
// /api/operator/auth
// ---------------------------------------------------------------------------

fn cookie_opts(state: &AppState) -> String {
    // v1 `cookieOpts`: httpOnly, sameSite lax, secure per config, path=/.
    // Deliberately no Domain — v1 doesn't set one on operator cookies.
    let mut s = String::from("; Path=/; HttpOnly; SameSite=Lax");
    if state.cookie_secure {
        s.push_str("; Secure");
    }
    s
}

fn http_date(d: chrono::NaiveDateTime) -> String {
    d.format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

fn set_operator_cookies(state: &AppState, access: &str, refresh: &str, refresh_exp: chrono::NaiveDateTime) -> [String; 2] {
    [
        format!("operator_access={access}{}; Max-Age=1800", cookie_opts(state)),
        format!(
            "operator_refresh={refresh}{}; Expires={}",
            cookie_opts(state),
            http_date(refresh_exp)
        ),
    ]
}

fn clear_operator_cookies(state: &AppState) -> [String; 2] {
    let expired = "Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    [
        format!("operator_access={}; {expired}", cookie_opts(state)),
        format!("operator_refresh={}; {expired}", cookie_opts(state)),
    ]
}

fn json_with_cookies(status: StatusCode, body: Value, cookies: &[String]) -> Response {
    let mut b = Response::builder()
        .status(status)
        .header(axum::http::header::CONTENT_TYPE, "application/json");
    for c in cookies {
        b = b.header(axum::http::header::SET_COOKIE, c.as_str());
    }
    b.body(Body::from(serde_json::to_vec(&body).unwrap_or_default()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// v1 `issueTokens`: a `kind=operator` HS256 access token signed with
/// OPERATOR_JWT_SECRET plus an opaque 48-byte refresh token stored as an
/// unsalted sha256 hex digest (the exact digest v1 writes).
async fn op_issue_tokens(
    state: &AppState,
    operator_id: &str,
    email: &str,
    meta: &crate::ReqMeta,
) -> ApiResult<(String, String, chrono::NaiveDateTime)> {
    let secret = operator_secret().ok_or_else(|| ApiError::internal("OPERATOR_JWT_SECRET missing"))?;
    let ttl = parse_ttl_secs(&std::env::var("OPERATOR_JWT_TTL").unwrap_or_else(|_| "30m".into()));
    let now = chrono::Utc::now().timestamp();
    let payload = json!({ "sub": operator_id, "email": email, "kind": "operator", "iat": now, "exp": now + ttl });
    let header = B64_URL.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let body = B64_URL.encode(serde_json::to_vec(&payload).map_err(|e| ApiError::internal(e.to_string()))?);
    let signing_input = format!("{header}.{body}");
    let access = format!("{signing_input}.{}", crate::jwt_sign(&signing_input, &secret));

    let raw: String = {
        use rand::RngCore;
        let mut b = [0u8; 48];
        rand::thread_rng().fill_bytes(&mut b);
        B64_URL.encode(b)
    };
    let refresh_ttl =
        parse_ttl_secs(&std::env::var("OPERATOR_REFRESH_TTL").unwrap_or_else(|_| "1d".into()));
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(refresh_ttl)).naive_utc();
    sqlx::query(
        r#"INSERT INTO "OperatorRefreshToken"
             ("id","operatorId","tokenHash","expiresAt","userAgent","ip","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,now())"#,
    )
    .bind(gen_id())
    .bind(operator_id)
    .bind(crate::sha256_hex(&raw))
    .bind(expires_at)
    .bind(meta.user_agent.as_deref())
    .bind(meta.ip.as_deref())
    .execute(&state.pool)
    .await?;
    Ok((access, raw, expires_at))
}

#[derive(Deserialize)]
struct OpLoginBody {
    email: String,
    password: String,
}

/// `POST /api/operator/auth/login` — 201 (Nest's default for POST).
async fn op_login(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<OpLoginBody>,
) -> ApiResult<Response> {
    if !body.email.contains('@') {
        return Err(ApiError::bad("email must be an email"));
    }
    if body.password.is_empty() {
        return Err(ApiError::bad("password must be longer than or equal to 1 characters"));
    }
    let meta = crate::req_meta(&headers);
    // v1 keys the shared LoginCooldownService on the normalized email, but
    // looks the operator up with the raw address — reproduce both.
    let key = body.email.trim().to_lowercase();

    // SECURITY: check the lockout before any argon2 work so a locked account
    // can't burn CPU (v1's comment, and its ordering).
    if let Some(secs) = crate::cooldown_locked_for(&state, &key) {
        return Err(ApiError {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: format!("Too many failed logins. Try again in {} minute(s).", (secs + 59) / 60),
            body: Some(json!({
                "code": "EMAIL_LOCKED",
                "message": format!("Too many failed logins. Try again in {} minute(s).", (secs + 59) / 60),
                "retryAfter": secs,
            })),
        });
    }

    let row = sqlx::query(
        r#"SELECT "id","email","passwordHash","displayName","isSuper","disabledAt"
             FROM "Operator" WHERE "email" = $1"#,
    )
    .bind(&body.email)
    .fetch_optional(&state.pool)
    .await?;

    // Same generic error regardless of cause — never leak which field was wrong.
    let Some(row) = row else {
        crate::cooldown_record_failure(&state, &key);
        return Err(ApiError::unauthorized("Invalid credentials"));
    };
    let id = s(&row, "id");
    let disabled: Option<chrono::NaiveDateTime> = row
        .try_get("disabledAt")
        .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;
    if disabled.is_some() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Operator account disabled"));
    }
    // A corrupt stored hash counts as a failed login (401), not a 500.
    if crate::verify_argon2(&body.password, &s(&row, "passwordHash")).is_err() {
        crate::cooldown_record_failure(&state, &key);
        // A password-guessing run against the admin panel must leave a trace.
        op_audit(
            &state.pool,
            &id,
            "OPERATOR_LOGIN_FAILED",
            Some("Operator"),
            Some(&id),
            Some("Invalid password"),
            Some(json!({ "ip": meta.ip, "userAgent": meta.user_agent })),
        )
        .await;
        return Err(ApiError::unauthorized("Invalid credentials"));
    }

    crate::cooldown_record_success(&state, &key);
    let _ = sqlx::query(r#"UPDATE "Operator" SET "lastLoginAt" = now(), "updatedAt" = now() WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await;

    let email = s(&row, "email");
    let (access, refresh, exp) = op_issue_tokens(&state, &id, &email, &meta).await?;
    let out = json!({
        "operator": {
            "id": id,
            "email": email,
            "isSuper": ob(&row, "isSuper"),
            "displayName": os(&row, "displayName"),
        },
        "accessToken": access,
    });
    Ok(json_with_cookies(StatusCode::CREATED, out, &set_operator_cookies(&state, &access, &refresh, exp)))
}

/// `POST /api/operator/auth/refresh` — 201. Rotates: revoke old, issue new.
async fn op_refresh(State(state): State<AppState>, headers: axum::http::HeaderMap) -> ApiResult<Response> {
    let token = crate::cookie_from_header(&headers, "operator_refresh")
        .ok_or_else(|| ApiError::unauthorized("No refresh cookie"))?;
    let meta = crate::req_meta(&headers);

    let row = sqlx::query(
        r#"SELECT t."id", t."revokedAt", t."expiresAt", o."id" AS "operatorId", o."email",
                  o."disabledAt"
             FROM "OperatorRefreshToken" t
             JOIN "Operator" o ON o."id" = t."operatorId"
            WHERE t."tokenHash" = $1"#,
    )
    .bind(crate::sha256_hex(&token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("Refresh token invalid"))?;

    let revoked: Option<chrono::NaiveDateTime> = row
        .try_get("revokedAt")
        .map_err(|e| ApiError::internal(format!("refresh check failed: {e}")))?;
    let expires: chrono::NaiveDateTime = row
        .try_get("expiresAt")
        .map_err(|e| ApiError::internal(format!("refresh check failed: {e}")))?;
    if revoked.is_some() || expires < now_naive() {
        return Err(ApiError::unauthorized("Refresh token invalid"));
    }
    let disabled: Option<chrono::NaiveDateTime> = row
        .try_get("disabledAt")
        .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;
    if disabled.is_some() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Operator account disabled"));
    }

    sqlx::query(r#"UPDATE "OperatorRefreshToken" SET "revokedAt" = now() WHERE "id" = $1"#)
        .bind(s(&row, "id"))
        .execute(&state.pool)
        .await?;

    let op_id = s(&row, "operatorId");
    let email = s(&row, "email");
    let (access, refresh, exp) = op_issue_tokens(&state, &op_id, &email, &meta).await?;
    Ok(json_with_cookies(
        StatusCode::CREATED,
        json!({ "accessToken": access }),
        &set_operator_cookies(&state, &access, &refresh, exp),
    ))
}

/// `POST /api/operator/auth/logout` — 201, always `{ok:true}`.
async fn op_logout(State(state): State<AppState>, headers: axum::http::HeaderMap) -> ApiResult<Response> {
    if let Some(token) = crate::cookie_from_header(&headers, "operator_refresh") {
        let _ = sqlx::query(
            r#"UPDATE "OperatorRefreshToken" SET "revokedAt" = now()
                WHERE "tokenHash" = $1 AND "revokedAt" IS NULL"#,
        )
        .bind(crate::sha256_hex(&token))
        .execute(&state.pool)
        .await;
    }
    Ok(json_with_cookies(StatusCode::CREATED, json!({ "ok": true }), &clear_operator_cookies(&state)))
}

/// `GET /api/operator/auth/me` — 200, OperatorGuard.
async fn op_me(State(state): State<AppState>, op: OperatorCtx) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        r#"SELECT "id","email","displayName","isSuper","lastLoginAt","createdAt"
             FROM "Operator" WHERE "id" = $1"#,
    )
    .bind(&op.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("Unauthorized"))?;
    Ok(Json(json!({
        "id": s(&row, "id"),
        "email": s(&row, "email"),
        "displayName": os(&row, "displayName"),
        "isSuper": ob(&row, "isSuper"),
        "lastLoginAt": iso(&row, "lastLoginAt"),
        "createdAt": iso(&row, "createdAt"),
    })))
}

// ---------------------------------------------------------------------------
// /api/operator/users
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

/// v1's Prisma status filter, as SQL. Values are matched against a fixed set
/// before being interpolated, so nothing user-supplied reaches the statement.
fn user_status_clause(status: Option<&str>) -> &'static str {
    match status {
        Some("suspended") => r#" AND u."suspendedAt" IS NOT NULL"#,
        Some("active") => r#" AND u."suspendedAt" IS NULL AND u."approvalStatus" = 'approved'"#,
        Some("pending") => r#" AND u."approvalStatus" = 'pending'"#,
        Some("approved") => r#" AND u."approvalStatus" = 'approved'"#,
        Some("rejected") => r#" AND u."approvalStatus" = 'rejected'"#,
        _ => "",
    }
}

const USER_Q: &str =
    r#"($1::text IS NULL OR u."email" ILIKE '%'||$1||'%' OR u."displayName" ILIKE '%'||$1||'%')"#;

async fn op_users_list(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Query(qp): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = limit_offset(qp.limit.as_deref(), qp.offset.as_deref(), 50, 200);
    let q = qp.q.filter(|v| !v.is_empty());
    let status = user_status_clause(qp.status.as_deref());

    let sql = format!(
        r#"SELECT u."id", u."email", u."displayName", u."isAdmin", u."suspendedAt",
                  u."suspendedReason", u."approvalStatus"::text AS "approvalStatus",
                  u."approvalNote", u."approvedAt", u."rejectedAt", u."emailVerifiedAt",
                  u."createdAt",
                  (SELECT count(*) FROM "Connection" c WHERE c."ownerId" = u."id") AS "connections",
                  (SELECT count(*) FROM "Workspace" w WHERE w."ownerId" = u."id") AS "workspacesOwned",
                  (SELECT count(*) FROM "WorkspaceMember" m WHERE m."userId" = u."id") AS "workspacesJoined"
             FROM "User" u
            WHERE {USER_Q}{status}
            ORDER BY u."createdAt" DESC
            LIMIT $2 OFFSET $3"#
    );
    let rows = sqlx::query(&sql)
        .bind(q.as_deref())
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.pool)
        .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM "User" u WHERE {USER_Q}{status}"#
    ))
    .bind(q.as_deref())
    .fetch_one(&state.pool)
    .await?;

    let out: Vec<Value> = rows
        .iter()
        .map(|u| {
            json!({
                "id": s(u, "id"),
                "email": s(u, "email"),
                "displayName": os(u, "displayName"),
                "isAdmin": ob(u, "isAdmin"),
                "suspendedAt": iso(u, "suspendedAt"),
                "suspendedReason": os(u, "suspendedReason"),
                "approvalStatus": s(u, "approvalStatus"),
                "approvalNote": os(u, "approvalNote"),
                "approvedAt": iso(u, "approvedAt"),
                "rejectedAt": iso(u, "rejectedAt"),
                "emailVerified": iso(u, "emailVerifiedAt").is_some(),
                "createdAt": iso(u, "createdAt"),
                "connections": i64v(u, "connections"),
                "workspacesOwned": i64v(u, "workspacesOwned"),
                "workspacesJoined": i64v(u, "workspacesJoined"),
            })
        })
        .collect();
    Ok(Json(json!({ "rows": out, "total": total })))
}

async fn op_user_get(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let u = sqlx::query(
        r#"SELECT "id","email","displayName","isAdmin","suspendedAt","suspendedReason",
                  "approvalStatus"::text AS "approvalStatus","approvalNote","approvedAt",
                  "rejectedAt","approvedByOperatorId","emailVerifiedAt","createdAt"
             FROM "User" WHERE "id" = $1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    let ws = sqlx::query(
        r#"SELECT w."id", w."name", w."slug",
                  (SELECT count(*) FROM "WorkspaceMember" m WHERE m."workspaceId" = w."id") AS seats,
                  sub."status"::text AS "subStatus", sub."periodStart", sub."periodEnd",
                  sub."aiTopUpPacks", (sub."workspaceId" IS NOT NULL) AS "hasSub"
             FROM "Workspace" w
             LEFT JOIN "Subscription" sub ON sub."workspaceId" = w."id"
            WHERE w."ownerId" = $1"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let usage: Option<i32> = sqlx::query_scalar(
        r#"SELECT "callsUsed" FROM "AiUsageDay" WHERE "userId" = $1 AND "day" = $2"#,
    )
    .bind(&id)
    .bind(utc_day())
    .fetch_optional(&state.pool)
    .await?;

    let workspaces: Vec<Value> = ws
        .iter()
        .map(|w| {
            json!({
                "id": s(w, "id"),
                "name": s(w, "name"),
                "slug": s(w, "slug"),
                "seats": i64v(w, "seats"),
                "subscription": if ob(w, "hasSub") {
                    json!({
                        "status": s(w, "subStatus"),
                        "periodStart": iso(w, "periodStart"),
                        "periodEnd": iso(w, "periodEnd"),
                        "aiTopUpPacks": i32v(w, "aiTopUpPacks"),
                    })
                } else {
                    Value::Null
                },
            })
        })
        .collect();

    Ok(Json(json!({
        "user": {
            "id": s(&u, "id"),
            "email": s(&u, "email"),
            "displayName": os(&u, "displayName"),
            "isAdmin": ob(&u, "isAdmin"),
            "suspendedAt": iso(&u, "suspendedAt"),
            "suspendedReason": os(&u, "suspendedReason"),
            "approvalStatus": s(&u, "approvalStatus"),
            "approvalNote": os(&u, "approvalNote"),
            "approvedAt": iso(&u, "approvedAt"),
            "rejectedAt": iso(&u, "rejectedAt"),
            "approvedByOperatorId": os(&u, "approvedByOperatorId"),
            "emailVerified": iso(&u, "emailVerifiedAt").is_some(),
            "createdAt": iso(&u, "createdAt"),
        },
        "workspaces": workspaces,
        "aiUsageToday": usage.unwrap_or(0),
    })))
}

/// v1 zod `z.string().min(1).max(n)` / `.max(n).optional()`.
fn req_str(body: &Value, field: &str, max: usize) -> ApiResult<String> {
    let v = body
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad(format!("{field} is required")))?;
    if v.is_empty() || v.chars().count() > max {
        return Err(ApiError::bad(format!(
            "{field} must be between 1 and {max} characters"
        )));
    }
    Ok(v.to_string())
}

fn opt_str(body: &Value, field: &str, max: usize) -> ApiResult<Option<String>> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) => {
            if v.chars().count() > max {
                Err(ApiError::bad(format!("{field} must be at most {max} characters")))
            } else {
                Ok(Some(v.clone()))
            }
        }
        Some(_) => Err(ApiError::bad(format!("{field} must be a string"))),
    }
}

/// `POST /api/operator/users/:id/approve` — 201. Idempotent.
async fn op_user_approve(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> ApiResult<Response> {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let note = opt_str(&body, "note", 500)?;

    let u = sqlx::query(r#"SELECT "email","approvalStatus"::text AS st FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    if s(&u, "st") == "approved" {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true, "alreadyApproved": true }))).into_response());
    }
    sqlx::query(
        r#"UPDATE "User" SET "approvalStatus" = 'approved', "approvalNote" = $2,
                  "approvedAt" = now(), "rejectedAt" = NULL, "approvedByOperatorId" = $3,
                  "updatedAt" = now()
            WHERE "id" = $1"#,
    )
    .bind(&id)
    .bind(note.as_deref())
    .bind(&op.id)
    .execute(&state.pool)
    .await?;
    op_audit(
        &state.pool,
        &op.id,
        "USER_APPROVED",
        Some("User"),
        Some(&id),
        note.as_deref(),
        Some(json!({ "email": s(&u, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `POST /api/operator/users/:id/reject` — 201. Only valid from `pending`.
async fn op_user_reject(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let reason = req_str(&body, "reason", 500)?;
    let u = sqlx::query(r#"SELECT "email","approvalStatus"::text AS st FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    if s(&u, "st") != "pending" {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Only pending accounts can be rejected. Suspend an approved account instead.",
        ));
    }
    sqlx::query(
        r#"UPDATE "User" SET "approvalStatus" = 'rejected', "approvalNote" = $2,
                  "rejectedAt" = now(), "approvedByOperatorId" = $3, "updatedAt" = now()
            WHERE "id" = $1"#,
    )
    .bind(&id)
    .bind(&reason)
    .bind(&op.id)
    .execute(&state.pool)
    .await?;
    // Kill any open sessions (e.g. an OAuth signup that got tokens first).
    sqlx::query(r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    op_audit(
        &state.pool,
        &op.id,
        "USER_REJECTED",
        Some("User"),
        Some(&id),
        Some(&reason),
        Some(json!({ "email": s(&u, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `POST /api/operator/users/:id/suspend` — 201, SuperOperatorGuard.
async fn op_user_suspend(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    op.require_super()?;
    let reason = req_str(&body, "reason", 500)?;
    let u = sqlx::query(r#"SELECT "email" FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    sqlx::query(
        r#"UPDATE "User" SET "suspendedAt" = now(), "suspendedReason" = $2, "updatedAt" = now()
            WHERE "id" = $1"#,
    )
    .bind(&id)
    .bind(&reason)
    .execute(&state.pool)
    .await?;
    // Revoke live sessions — otherwise the access JWT keeps working until exp.
    sqlx::query(r#"UPDATE "RefreshToken" SET "revokedAt" = now() WHERE "userId" = $1 AND "revokedAt" IS NULL"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    op_audit(
        &state.pool,
        &op.id,
        "USER_SUSPENDED",
        Some("User"),
        Some(&id),
        Some(&reason),
        Some(json!({ "email": s(&u, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `POST /api/operator/users/:id/unsuspend` — 201, SuperOperatorGuard.
async fn op_user_unsuspend(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    op.require_super()?;
    let u = sqlx::query(r#"SELECT "email","suspendedAt" FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let suspended: Option<chrono::NaiveDateTime> = u
        .try_get("suspendedAt")
        .map_err(|e| ApiError::internal(format!("suspend check failed: {e}")))?;
    if suspended.is_none() {
        return Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response());
    }
    sqlx::query(
        r#"UPDATE "User" SET "suspendedAt" = NULL, "suspendedReason" = NULL, "updatedAt" = now()
            WHERE "id" = $1"#,
    )
    .bind(&id)
    .execute(&state.pool)
    .await?;
    op_audit(
        &state.pool,
        &op.id,
        "USER_UNSUSPENDED",
        Some("User"),
        Some(&id),
        None,
        Some(json!({ "email": s(&u, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `DELETE /api/operator/users/:id` — 200, SuperOperatorGuard.
async fn op_user_delete(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    op.require_super()?;
    let u = sqlx::query(r#"SELECT "email" FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    // FK cascades clean refresh tokens, memberships, AI usage and owned
    // connections (whose credentials are encrypted per-connection anyway).
    sqlx::query(r#"DELETE FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    op_audit(
        &state.pool,
        &op.id,
        "USER_DELETED",
        Some("User"),
        Some(&id),
        Some("GDPR / account deletion"),
        Some(json!({ "email": s(&u, "email") })),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

const SUB_STATUSES: [&str; 5] = ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED"];

/// `PATCH /api/operator/users/subscriptions/:workspaceId` — 200, SuperOperatorGuard.
async fn op_subscription_override(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(workspace_id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    op.require_super()?;
    let note = opt_str(&body, "note", 500)?;
    let has_note = matches!(body.get("note"), Some(Value::String(_)));
    let status = match body.get("status") {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) if SUB_STATUSES.contains(&v.as_str()) => Some(v.clone()),
        Some(_) => {
            return Err(ApiError::bad(
                "status must be one of the following values: TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED",
            ))
        }
    };
    let period_end = match body.get("periodEnd") {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) => Some(
            chrono::DateTime::parse_from_rfc3339(v)
                .map_err(|_| ApiError::bad("periodEnd must be an ISO 8601 datetime"))?
                .naive_utc(),
        ),
        Some(_) => return Err(ApiError::bad("periodEnd must be an ISO 8601 datetime")),
    };
    let packs = match body.get("aiTopUpPacks") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let n = v
                .as_i64()
                .filter(|n| (0..=1000).contains(n))
                .ok_or_else(|| ApiError::bad("aiTopUpPacks must be an integer between 0 and 1000"))?;
            Some(n as i32)
        }
    };

    let exists: Option<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Subscription" WHERE "workspaceId" = $1"#)
            .bind(&workspace_id)
            .fetch_optional(&state.pool)
            .await?;

    if exists.is_some() {
        sqlx::query(
            r#"UPDATE "Subscription" SET
                   "status" = COALESCE($2::"SubscriptionStatus", "status"),
                   "periodEnd" = COALESCE($3::timestamp, "periodEnd"),
                   "aiTopUpPacks" = COALESCE($4::int, "aiTopUpPacks"),
                   "manualOverrideNote" = CASE WHEN $5 THEN $6::text ELSE "manualOverrideNote" END,
                   "updatedAt" = now()
                WHERE "workspaceId" = $1"#,
        )
        .bind(&workspace_id)
        .bind(status.as_deref())
        .bind(period_end)
        .bind(packs)
        .bind(has_note)
        .bind(note.as_deref())
        .execute(&state.pool)
        .await?;
    } else {
        // Sensible defaults for a brand-new manual sub: 30-day window, trialing.
        sqlx::query(
            r#"INSERT INTO "Subscription"
                 ("id","workspaceId","status","periodStart","periodEnd","aiTopUpPacks",
                  "manualOverrideNote","createdAt","updatedAt")
               VALUES ($1,$2,COALESCE($3::"SubscriptionStatus",'TRIALING'),now(),
                       COALESCE($4::timestamp, now() + interval '30 days'),
                       COALESCE($5::int,0),$6,now(),now())"#,
        )
        .bind(gen_id())
        .bind(&workspace_id)
        .bind(status.as_deref())
        .bind(period_end)
        .bind(packs)
        .bind(note.as_deref())
        .execute(&state.pool)
        .await?;
    }

    op_audit(
        &state.pool,
        &op.id,
        "SUBSCRIPTION_OVERRIDE",
        Some("Workspace"),
        Some(&workspace_id),
        note.as_deref(),
        Some(body.clone()),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// /api/operator/dashboard/overview
// ---------------------------------------------------------------------------

async fn billing_settings(state: &AppState) -> ApiResult<Option<PgRow>> {
    Ok(
        sqlx::query(r#"SELECT * FROM "BillingSettings" WHERE "id" = 'singleton'"#)
            .fetch_optional(&state.pool)
            .await?,
    )
}

async fn op_dashboard_overview(State(state): State<AppState>, _op: OperatorCtx) -> ApiResult<Json<Value>> {
    let settings = billing_settings(&state).await?;
    let seat_price = settings.as_ref().map(|r| i32v(r, "pricePerSeatCents")).unwrap_or(0) as i64;
    let topup_price = settings.as_ref().map(|r| i32v(r, "aiTopUpPriceCents")).unwrap_or(0) as i64;

    // MRR = active subs: sum(seats * seatPrice + packs * packPrice). Seats are
    // derived from WorkspaceMember live, so they can never drift.
    let subs = sqlx::query(
        r#"SELECT s."status"::text AS status, s."aiTopUpPacks",
                  (SELECT count(*) FROM "WorkspaceMember" m WHERE m."workspaceId" = s."workspaceId") AS seats
             FROM "Subscription" s
            WHERE s."status" IN ('ACTIVE','TRIALING','PAST_DUE')"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let mut mrr_cents: i64 = 0;
    let mut active_seats: i64 = 0;
    let mut active_packs: i64 = 0;
    let mut by_status: Map<String, Value> = Map::new();
    for r in &subs {
        let seats = i64v(r, "seats");
        let packs = i32v(r, "aiTopUpPacks") as i64;
        active_seats += seats;
        active_packs += packs;
        mrr_cents += seats * seat_price + packs * topup_price;
        let k = s(r, "status");
        let prev = by_status.get(&k).and_then(|v| v.as_i64()).unwrap_or(0);
        by_status.insert(k, json!(prev + 1));
    }

    let week_ago = now_naive() - chrono::Duration::days(7);
    let month_ago = now_naive() - chrono::Duration::days(30);
    let counts = sqlx::query(
        r#"SELECT
             (SELECT count(*) FROM "User") AS "totalUsers",
             (SELECT count(*) FROM "User" WHERE "createdAt" >= $1) AS "usersThisWeek",
             (SELECT count(*) FROM "User" WHERE "createdAt" >= $2) AS "usersThisMonth",
             (SELECT count(*) FROM "User" WHERE "suspendedAt" IS NOT NULL) AS "suspendedUsers",
             (SELECT count(*) FROM "Workspace") AS "totalWorkspaces",
             (SELECT count(*) FROM "Subscription" WHERE "status" = 'CANCELLED' AND "updatedAt" >= $2) AS "cancelledThisMonth",
             (SELECT COALESCE(sum("callsUsed"),0)::bigint FROM "AiUsageDay" WHERE "day" = $3) AS "aiCallsToday""#,
    )
    .bind(week_ago)
    .bind(month_ago)
    .bind(utc_day())
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "mrrCents": mrr_cents,
        "currency": settings.as_ref().map(|r| s(r, "currency")).unwrap_or_else(|| "USD".into()),
        "activeSubscriptions": subs.len(),
        "activeSeats": active_seats,
        "activeTopUpPacks": active_packs,
        "byStatus": Value::Object(by_status),
        "totalUsers": i64v(&counts, "totalUsers"),
        "suspendedUsers": i64v(&counts, "suspendedUsers"),
        "usersThisWeek": i64v(&counts, "usersThisWeek"),
        "usersThisMonth": i64v(&counts, "usersThisMonth"),
        "cancelledThisMonth": i64v(&counts, "cancelledThisMonth"),
        "totalWorkspaces": i64v(&counts, "totalWorkspaces"),
        "aiCallsToday": i64v(&counts, "aiCallsToday"),
    })))
}

// ---------------------------------------------------------------------------
// /api/operator/workspaces
// ---------------------------------------------------------------------------

const WS_WHERE: &str = r#"($1::text IS NULL
        OR w."name" ILIKE '%'||$1||'%'
        OR w."slug" ILIKE '%'||$1||'%'
        OR o."email" ILIKE '%'||$1||'%')
      AND ($2::text IS NULL OR sub."status"::text = $2)"#;

async fn op_workspaces_list(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Query(qp): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = limit_offset(qp.limit.as_deref(), qp.offset.as_deref(), 50, 200);
    let q = qp.q.filter(|v| !v.is_empty());
    let status = qp.status.filter(|v| !v.is_empty());

    let settings = billing_settings(&state).await?;
    let seat_price = settings.as_ref().map(|r| i32v(r, "pricePerSeatCents")).unwrap_or(0) as i64;
    let topup_price = settings.as_ref().map(|r| i32v(r, "aiTopUpPriceCents")).unwrap_or(0) as i64;

    let rows = sqlx::query(&format!(
        r#"SELECT w."id", w."name", w."slug", w."isPersonal", w."createdAt",
                  o."id" AS "ownerId", o."email" AS "ownerEmail",
                  o."displayName" AS "ownerDisplayName", o."suspendedAt" AS "ownerSuspendedAt",
                  (SELECT count(*) FROM "WorkspaceMember" m WHERE m."workspaceId" = w."id") AS seats,
                  (SELECT count(*) FROM "Connection" c WHERE c."workspaceId" = w."id") AS connections,
                  sub."status"::text AS "subStatus", sub."periodStart", sub."periodEnd",
                  sub."aiTopUpPacks", sub."manualOverrideNote",
                  (sub."workspaceId" IS NOT NULL) AS "hasSub"
             FROM "Workspace" w
             JOIN "User" o ON o."id" = w."ownerId"
             LEFT JOIN "Subscription" sub ON sub."workspaceId" = w."id"
            WHERE {WS_WHERE}
            ORDER BY w."createdAt" DESC
            LIMIT $3 OFFSET $4"#
    ))
    .bind(q.as_deref())
    .bind(status.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM "Workspace" w
             JOIN "User" o ON o."id" = w."ownerId"
             LEFT JOIN "Subscription" sub ON sub."workspaceId" = w."id"
            WHERE {WS_WHERE}"#
    ))
    .bind(q.as_deref())
    .bind(status.as_deref())
    .fetch_one(&state.pool)
    .await?;

    let out: Vec<Value> = rows
        .iter()
        .map(|w| {
            let seats = i64v(w, "seats");
            let packs = if ob(w, "hasSub") { i32v(w, "aiTopUpPacks") as i64 } else { 0 };
            json!({
                "id": s(w, "id"),
                "name": s(w, "name"),
                "slug": s(w, "slug"),
                "isPersonal": ob(w, "isPersonal"),
                "createdAt": iso(w, "createdAt"),
                "owner": {
                    "id": s(w, "ownerId"),
                    "email": s(w, "ownerEmail"),
                    "displayName": os(w, "ownerDisplayName"),
                    "suspendedAt": iso(w, "ownerSuspendedAt"),
                },
                "seats": seats,
                "connections": i64v(w, "connections"),
                "subscription": if ob(w, "hasSub") {
                    json!({
                        "status": s(w, "subStatus"),
                        "periodStart": iso(w, "periodStart"),
                        "periodEnd": iso(w, "periodEnd"),
                        "aiTopUpPacks": i32v(w, "aiTopUpPacks"),
                        "manualOverrideNote": os(w, "manualOverrideNote"),
                    })
                } else {
                    Value::Null
                },
                "monthlyCents": seats * seat_price + packs * topup_price,
            })
        })
        .collect();
    Ok(Json(json!({ "rows": out, "total": total })))
}

fn subscription_dto(r: &PgRow) -> Value {
    json!({
        "id": s(r, "subId"),
        "workspaceId": s(r, "subWorkspaceId"),
        "plan": s(r, "subPlan"),
        "status": s(r, "subStatus"),
        "periodStart": iso(r, "periodStart"),
        "periodEnd": iso(r, "periodEnd"),
        "seats": i32v(r, "subSeats"),
        "manualOverrideNote": os(r, "manualOverrideNote"),
        "aiTopUpPacks": i32v(r, "aiTopUpPacks"),
        "createdAt": iso(r, "subCreatedAt"),
        "updatedAt": iso(r, "subUpdatedAt"),
    })
}

async fn op_workspace_get(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let w = sqlx::query(
        r#"SELECT w."id", w."name", w."slug", w."isPersonal", w."createdAt",
                  o."id" AS "ownerId", o."email" AS "ownerEmail", o."displayName" AS "ownerDisplayName",
                  (SELECT count(*) FROM "Connection" c WHERE c."workspaceId" = w."id") AS connections,
                  sub."id" AS "subId", sub."workspaceId" AS "subWorkspaceId",
                  sub."plan"::text AS "subPlan", sub."status"::text AS "subStatus",
                  sub."periodStart", sub."periodEnd", sub."seats" AS "subSeats",
                  sub."manualOverrideNote", sub."aiTopUpPacks",
                  sub."createdAt" AS "subCreatedAt", sub."updatedAt" AS "subUpdatedAt",
                  (sub."workspaceId" IS NOT NULL) AS "hasSub"
             FROM "Workspace" w
             JOIN "User" o ON o."id" = w."ownerId"
             LEFT JOIN "Subscription" sub ON sub."workspaceId" = w."id"
            WHERE w."id" = $1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    let members = sqlx::query(
        r#"SELECT m."role"::text AS role, m."createdAt",
                  u."id" AS "userId", u."email", u."displayName", u."suspendedAt"
             FROM "WorkspaceMember" m
             JOIN "User" u ON u."id" = m."userId"
            WHERE m."workspaceId" = $1"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": s(&w, "id"),
        "name": s(&w, "name"),
        "slug": s(&w, "slug"),
        "isPersonal": ob(&w, "isPersonal"),
        "createdAt": iso(&w, "createdAt"),
        "owner": {
            "id": s(&w, "ownerId"),
            "email": s(&w, "ownerEmail"),
            "displayName": os(&w, "ownerDisplayName"),
        },
        "members": members.iter().map(|m| json!({
            "role": s(m, "role"),
            "createdAt": iso(m, "createdAt"),
            "user": {
                "id": s(m, "userId"),
                "email": s(m, "email"),
                "displayName": os(m, "displayName"),
                "suspendedAt": iso(m, "suspendedAt"),
            },
        })).collect::<Vec<_>>(),
        "_count": { "connections": i64v(&w, "connections") },
        "subscription": if ob(&w, "hasSub") { subscription_dto(&w) } else { Value::Null },
    })))
}

// ---------------------------------------------------------------------------
// /api/operator/billing
// ---------------------------------------------------------------------------

const PLAN_TIERS: [&str; 3] = ["FREE", "PRO", "TEAM"];

/// v1 `billing/plans.ts` DEFAULT_PLANS — the coded fallback `PlanService.all()`
/// substitutes for any tier with no row yet.
fn default_plan(tier: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let (name, seat, conns, ai, daily, sched, hooks, seats) = match tier {
        "FREE" => ("Trial", 0, 1, false, 0, 0, 0, json!(1)),
        "PRO" => ("Pro", 15000, 25, true, 50, 25, 10, json!(5)),
        _ => ("Team", 25000, 100, true, 200, 100, 25, Value::Null),
    };
    json!({
        "tier": tier,
        "name": name,
        "seatPriceIqd": seat,
        "maxConnections": conns,
        "aiEnabled": ai,
        "dailyAiCalls": daily,
        "maxScheduledQueries": sched,
        "maxWebhooksPerConnection": hooks,
        "maxSeats": seats,
        "updatedByOperatorId": Value::Null,
        "updatedAt": now,
        "createdAt": now,
    })
}

fn plan_dto(r: &PgRow) -> Value {
    json!({
        "tier": s(r, "tier"),
        "name": s(r, "name"),
        "seatPriceIqd": i32v(r, "seatPriceIqd"),
        "maxConnections": i32v(r, "maxConnections"),
        "aiEnabled": ob(r, "aiEnabled"),
        "dailyAiCalls": i32v(r, "dailyAiCalls"),
        "maxScheduledQueries": i32v(r, "maxScheduledQueries"),
        "maxWebhooksPerConnection": i32v(r, "maxWebhooksPerConnection"),
        "maxSeats": oi32(r, "maxSeats"),
        "updatedByOperatorId": os(r, "updatedByOperatorId"),
        "updatedAt": iso(r, "updatedAt"),
        "createdAt": iso(r, "createdAt"),
    })
}

const PLAN_COLS: &str = r#""tier"::text AS tier,"name","seatPriceIqd","maxConnections","aiEnabled",
    "dailyAiCalls","maxScheduledQueries","maxWebhooksPerConnection","maxSeats",
    "updatedByOperatorId","updatedAt","createdAt""#;

/// `GET /api/operator/billing/plans` — all tiers in display order.
async fn op_plans_get(State(state): State<AppState>, _op: OperatorCtx) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(r#"SELECT {PLAN_COLS} FROM "PlanConfig""#))
        .fetch_all(&state.pool)
        .await?;
    let out: Vec<Value> = PLAN_TIERS
        .iter()
        .map(|t| {
            rows.iter()
                .find(|r| s(r, "tier") == *t)
                .map(plan_dto)
                .unwrap_or_else(|| default_plan(t))
        })
        .collect();
    Ok(Json(json!(out)))
}

/// `PATCH /api/operator/billing/plans/:tier` — 200, SuperOperatorGuard.
async fn op_plan_patch(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(tier): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    op.require_super()?;
    let t = tier.to_uppercase();
    if !PLAN_TIERS.contains(&t.as_str()) {
        return Err(ApiError::bad(format!("Unknown plan tier: {tier}")));
    }
    let reason = req_str(&body, "reason", 500)?;

    let name = opt_str(&body, "name", 40)?;
    let int_field = |k: &str, lo: i64, hi: i64| -> ApiResult<Option<i32>> {
        match body.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_i64()
                .filter(|n| (lo..=hi).contains(n))
                .map(|n| Some(n as i32))
                .ok_or_else(|| ApiError::bad(format!("{k} must be an integer between {lo} and {hi}"))),
        }
    };
    let seat_price = int_field("seatPriceIqd", 0, 100_000_000)?;
    let max_conns = int_field("maxConnections", 0, 100_000)?;
    let daily_ai = int_field("dailyAiCalls", 0, 1_000_000)?;
    let max_sched = int_field("maxScheduledQueries", 0, 100_000)?;
    let max_hooks = int_field("maxWebhooksPerConnection", 0, 100_000)?;
    let ai_enabled = match body.get("aiEnabled") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(ApiError::bad("aiEnabled must be a boolean")),
    };
    // `maxSeats` is nullable-optional: absent = leave alone, null = unlimited.
    let has_max_seats = body.get("maxSeats").is_some();
    let max_seats = match body.get("maxSeats") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .filter(|n| (1..=1_000_000).contains(n))
                .ok_or_else(|| ApiError::bad("maxSeats must be an integer between 1 and 1000000"))?
                as i32,
        ),
    };

    let before = sqlx::query(&format!(
        r#"SELECT {PLAN_COLS} FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#
    ))
    .bind(&t)
    .fetch_optional(&state.pool)
    .await?;

    // create defaults mirror the Prisma schema defaults, since v1's `create`
    // spreads only the supplied patch fields.
    let after = sqlx::query(&format!(
        r#"INSERT INTO "PlanConfig"
             ("tier","name","seatPriceIqd","maxConnections","aiEnabled","dailyAiCalls",
              "maxScheduledQueries","maxWebhooksPerConnection","maxSeats",
              "updatedByOperatorId","updatedAt","createdAt")
           VALUES ($1::"PlanTier", COALESCE($2,$1), COALESCE($3::int,0), COALESCE($4::int,3),
                   COALESCE($5::bool,false), COALESCE($6::int,0), COALESCE($7::int,2),
                   COALESCE($8::int,1), $9::int, $11, now(), now())
           ON CONFLICT ("tier") DO UPDATE SET
             "name" = COALESCE($2, "PlanConfig"."name"),
             "seatPriceIqd" = COALESCE($3::int, "PlanConfig"."seatPriceIqd"),
             "maxConnections" = COALESCE($4::int, "PlanConfig"."maxConnections"),
             "aiEnabled" = COALESCE($5::bool, "PlanConfig"."aiEnabled"),
             "dailyAiCalls" = COALESCE($6::int, "PlanConfig"."dailyAiCalls"),
             "maxScheduledQueries" = COALESCE($7::int, "PlanConfig"."maxScheduledQueries"),
             "maxWebhooksPerConnection" = COALESCE($8::int, "PlanConfig"."maxWebhooksPerConnection"),
             "maxSeats" = CASE WHEN $10 THEN $9::int ELSE "PlanConfig"."maxSeats" END,
             "updatedByOperatorId" = $11,
             "updatedAt" = now()
           RETURNING {PLAN_COLS}"#
    ))
    .bind(&t)
    .bind(name.as_deref())
    .bind(seat_price)
    .bind(max_conns)
    .bind(ai_enabled)
    .bind(daily_ai)
    .bind(max_sched)
    .bind(max_hooks)
    .bind(max_seats)
    .bind(has_max_seats)
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;

    let mut patch = body.clone();
    if let Some(o) = patch.as_object_mut() {
        o.remove("reason");
    }
    op_audit(
        &state.pool,
        &op.id,
        "BILLING_PRICE_CHANGED",
        Some("PlanConfig"),
        Some(&t),
        Some(&reason),
        Some(json!({ "before": before.as_ref().map(plan_dto), "after": patch })),
    )
    .await;
    Ok(Json(plan_dto(&after)))
}

fn settings_dto(r: &PgRow) -> Value {
    json!({
        "id": s(r, "id"),
        "pricePerSeatCents": i32v(r, "pricePerSeatCents"),
        "currency": s(r, "currency"),
        "dailyFreeAiCalls": i32v(r, "dailyFreeAiCalls"),
        "aiTopUpCallsPerPack": i32v(r, "aiTopUpCallsPerPack"),
        "aiTopUpPriceCents": i32v(r, "aiTopUpPriceCents"),
        "updatedByOperatorId": os(r, "updatedByOperatorId"),
        "updatedAt": iso(r, "updatedAt"),
        "createdAt": iso(r, "createdAt"),
    })
}

/// `GET /api/operator/billing/settings` — upserts the singleton, as v1 does.
async fn op_settings_get(State(state): State<AppState>, _op: OperatorCtx) -> ApiResult<Json<Value>> {
    let r = sqlx::query(
        r#"INSERT INTO "BillingSettings" ("id","updatedAt","createdAt")
           VALUES ('singleton', now(), now())
           ON CONFLICT ("id") DO UPDATE SET "updatedAt" = now()
           RETURNING *"#,
    )
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(settings_dto(&r)))
}

/// `PATCH /api/operator/billing/settings` — 200, SuperOperatorGuard.
async fn op_settings_patch(
    State(state): State<AppState>,
    op: OperatorCtx,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    op.require_super()?;
    let reason = req_str(&body, "reason", 500)?;
    let int_field = |k: &str, lo: i64, hi: i64| -> ApiResult<Option<i32>> {
        match body.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_i64()
                .filter(|n| (lo..=hi).contains(n))
                .map(|n| Some(n as i32))
                .ok_or_else(|| ApiError::bad(format!("{k} must be an integer between {lo} and {hi}"))),
        }
    };
    let seat = int_field("pricePerSeatCents", 0, 1_000_000)?;
    let daily = int_field("dailyFreeAiCalls", 0, 10_000)?;
    let per_pack = int_field("aiTopUpCallsPerPack", 1, 10_000)?;
    let pack_price = int_field("aiTopUpPriceCents", 0, 1_000_000)?;
    let currency = match body.get("currency") {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) if v.chars().count() == 3 => Some(v.clone()),
        Some(_) => return Err(ApiError::bad("currency must be exactly 3 characters")),
    };

    let before = billing_settings(&state).await?;
    let after = sqlx::query(
        r#"INSERT INTO "BillingSettings"
             ("id","pricePerSeatCents","currency","dailyFreeAiCalls","aiTopUpCallsPerPack",
              "aiTopUpPriceCents","updatedByOperatorId","updatedAt","createdAt")
           VALUES ('singleton', COALESCE($1::int,1000), COALESCE($2,'USD'), COALESCE($3::int,10),
                   COALESCE($4::int,10), COALESCE($5::int,100), $6, now(), now())
           ON CONFLICT ("id") DO UPDATE SET
             "pricePerSeatCents" = COALESCE($1::int, "BillingSettings"."pricePerSeatCents"),
             "currency" = COALESCE($2, "BillingSettings"."currency"),
             "dailyFreeAiCalls" = COALESCE($3::int, "BillingSettings"."dailyFreeAiCalls"),
             "aiTopUpCallsPerPack" = COALESCE($4::int, "BillingSettings"."aiTopUpCallsPerPack"),
             "aiTopUpPriceCents" = COALESCE($5::int, "BillingSettings"."aiTopUpPriceCents"),
             "updatedByOperatorId" = $6,
             "updatedAt" = now()
           RETURNING *"#,
    )
    .bind(seat)
    .bind(currency.as_deref())
    .bind(daily)
    .bind(per_pack)
    .bind(pack_price)
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;

    let mut patch = body.clone();
    if let Some(o) = patch.as_object_mut() {
        o.remove("reason");
    }
    op_audit(
        &state.pool,
        &op.id,
        "BILLING_PRICE_CHANGED",
        Some("BillingSettings"),
        Some("singleton"),
        Some(&reason),
        Some(json!({ "before": before.as_ref().map(settings_dto), "after": patch })),
    )
    .await;
    Ok(Json(settings_dto(&after)))
}

// ---------------------------------------------------------------------------
// /api/operator/audit
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AuditQuery {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default, rename = "operatorId")]
    operator_id: Option<String>,
}

async fn op_audit_list(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Query(qp): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = limit_offset(qp.limit.as_deref(), qp.offset.as_deref(), 50, 200);
    let action = qp.action.filter(|v| !v.is_empty());
    let operator_id = qp.operator_id.filter(|v| !v.is_empty());
    const W: &str = r#"($1::text IS NULL OR a."action" = $1)
                   AND ($2::text IS NULL OR a."operatorId" = $2)"#;

    let rows = sqlx::query(&format!(
        r#"SELECT a."id", a."operatorId", a."action", a."targetType", a."targetId",
                  a."reason", a."metadata", a."createdAt",
                  o."email" AS "opEmail", o."displayName" AS "opDisplayName"
             FROM "OperatorAuditLog" a
             JOIN "Operator" o ON o."id" = a."operatorId"
            WHERE {W}
            ORDER BY a."createdAt" DESC
            LIMIT $3 OFFSET $4"#
    ))
    .bind(action.as_deref())
    .bind(operator_id.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM "OperatorAuditLog" a WHERE {W}"#
    ))
    .bind(action.as_deref())
    .bind(operator_id.as_deref())
    .fetch_one(&state.pool)
    .await?;

    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": s(r, "id"),
                "operatorId": s(r, "operatorId"),
                "action": s(r, "action"),
                "targetType": os(r, "targetType"),
                "targetId": os(r, "targetId"),
                "reason": os(r, "reason"),
                "metadata": ojson(r, "metadata"),
                "createdAt": iso(r, "createdAt"),
                "operator": { "email": s(r, "opEmail"), "displayName": os(r, "opDisplayName") },
            })
        })
        .collect();
    Ok(Json(json!({ "rows": out, "total": total })))
}

#[derive(Deserialize)]
struct ExportQuery {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

/// v1 `csvEscape`.
fn csv_escape(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    if v.contains('"') || v.contains(',') || v.contains('\n') {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

/// `GET /api/operator/audit/export` — streaming SIEM export, keyset-paginated
/// in batches of 1000 so a multi-million-row audit log never lands in memory.
async fn op_audit_export(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Query(qp): Query<ExportQuery>,
) -> ApiResult<Response> {
    let jsonl = qp.format.as_deref() == Some("jsonl");
    let from = parse_iso_opt(qp.from.as_deref())?;
    let to = parse_iso_opt(qp.to.as_deref())?;

    let pool = state.pool.clone();
    let (mut wtr, rdr) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        if !jsonl && wtr
            .write_all(b"id,createdAt,operatorId,operatorEmail,action,targetType,targetId,reason,metadata\n")
            .await
            .is_err()
        {
            return;
        }
        let batch: i64 = 1000;
        let mut last_id: Option<String> = None;
        loop {
            let page = sqlx::query(
                r#"SELECT a."id", a."createdAt", a."operatorId", a."action", a."targetType",
                          a."targetId", a."reason", a."metadata", o."email" AS "opEmail"
                     FROM "OperatorAuditLog" a
                     JOIN "Operator" o ON o."id" = a."operatorId"
                    WHERE ($1::timestamp IS NULL OR a."createdAt" >= $1)
                      AND ($2::timestamp IS NULL OR a."createdAt" <= $2)
                      AND ($3::text IS NULL OR a."id" > $3)
                    ORDER BY a."id" ASC
                    LIMIT $4"#,
            )
            .bind(from)
            .bind(to)
            .bind(last_id.as_deref())
            .bind(batch)
            .fetch_all(&pool)
            .await;
            let page = match page {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("operator audit export failed: {e}");
                    return;
                }
            };
            if page.is_empty() {
                return;
            }
            let mut buf = String::new();
            for r in &page {
                let created = iso(r, "createdAt").unwrap_or_default();
                if jsonl {
                    let line = json!({
                        "id": s(r, "id"),
                        "createdAt": created,
                        "operatorId": s(r, "operatorId"),
                        "operatorEmail": s(r, "opEmail"),
                        "action": s(r, "action"),
                        "targetType": os(r, "targetType"),
                        "targetId": os(r, "targetId"),
                        "reason": os(r, "reason"),
                        "metadata": ojson(r, "metadata"),
                    });
                    buf.push_str(&line.to_string());
                    buf.push('\n');
                } else {
                    let meta = ojson(r, "metadata").map(|m| m.to_string()).unwrap_or_default();
                    buf.push_str(&csv_escape(&s(r, "id")));
                    buf.push(',');
                    buf.push_str(&created);
                    buf.push(',');
                    buf.push_str(&csv_escape(&s(r, "operatorId")));
                    buf.push(',');
                    buf.push_str(&csv_escape(&s(r, "opEmail")));
                    buf.push(',');
                    buf.push_str(&csv_escape(&s(r, "action")));
                    buf.push(',');
                    buf.push_str(&csv_escape(&os(r, "targetType").unwrap_or_default()));
                    buf.push(',');
                    buf.push_str(&csv_escape(&os(r, "targetId").unwrap_or_default()));
                    buf.push(',');
                    buf.push_str(&csv_escape(&os(r, "reason").unwrap_or_default()));
                    buf.push(',');
                    buf.push_str(&csv_escape(&meta));
                    buf.push('\n');
                }
            }
            if wtr.write_all(buf.as_bytes()).await.is_err() {
                return; // client hung up
            }
            let n = page.len() as i64;
            last_id = Some(s(&page[page.len() - 1], "id"));
            if n < batch {
                return;
            }
        }
    });

    let suffix = if jsonl { "jsonl" } else { "csv" };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::CONTENT_TYPE,
            if jsonl { "application/x-ndjson" } else { "text/csv; charset=utf-8" },
        )
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"audit-{}.{suffix}\"", utc_day()),
        )
        .body(Body::from_stream(ReaderStream::new(rdr)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

fn parse_iso_opt(v: Option<&str>) -> ApiResult<Option<chrono::NaiveDateTime>> {
    match v.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|d| Some(d.naive_utc()))
            .map_err(|_| ApiError::bad("Invalid date")),
    }
}

// ---------------------------------------------------------------------------
// /api/operator/operators
// ---------------------------------------------------------------------------

async fn op_operators_list(State(state): State<AppState>, _op: OperatorCtx) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT "id","email","displayName","isSuper","disabledAt","lastLoginAt","createdAt"
             FROM "Operator" ORDER BY "createdAt" ASC"#,
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": s(r, "id"),
            "email": s(r, "email"),
            "displayName": os(r, "displayName"),
            "isSuper": ob(r, "isSuper"),
            "disabledAt": iso(r, "disabledAt"),
            "lastLoginAt": iso(r, "lastLoginAt"),
            "createdAt": iso(r, "createdAt"),
        }))
        .collect::<Vec<_>>())))
}

/// `POST /api/operator/operators` — 201, SuperOperatorGuard.
async fn op_operator_create(
    State(state): State<AppState>,
    op: OperatorCtx,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    op.require_super()?;
    let email = body
        .get("email")
        .and_then(|v| v.as_str())
        .filter(|v| v.contains('@'))
        .ok_or_else(|| ApiError::bad("Invalid email"))?
        .to_string();
    let password = body
        .get("password")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad("Operator passwords must be at least 12 characters"))?;
    if password.chars().count() < 12 {
        return Err(ApiError::bad("Operator passwords must be at least 12 characters"));
    }
    let display_name = opt_str(&body, "displayName", 100)?;
    let is_super = match body.get("isSuper") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(ApiError::bad("isSuper must be a boolean")),
    };

    let existing: Option<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Operator" WHERE "email" = $1"#)
            .bind(&email)
            .fetch_optional(&state.pool)
            .await?;
    if existing.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Operator email already exists"));
    }

    let id = gen_id();
    sqlx::query(
        r#"INSERT INTO "Operator" ("id","email","passwordHash","displayName","isSuper","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,now(),now())"#,
    )
    .bind(&id)
    .bind(&email)
    .bind(crate::hash_argon2(password)?)
    .bind(display_name.as_deref())
    .bind(is_super)
    .execute(&state.pool)
    .await?;

    op_audit(
        &state.pool,
        &op.id,
        "OPERATOR_CREATED",
        Some("Operator"),
        Some(&id),
        None,
        Some(json!({ "email": email, "isSuper": is_super })),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": id, "email": email, "isSuper": is_super })),
    )
        .into_response())
}

/// `POST /api/operator/operators/:id/disable` — 201, SuperOperatorGuard.
async fn op_operator_disable(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    op.require_super()?;
    if id == op.id {
        return Err(ApiError::bad("Cannot disable yourself"));
    }
    let row = sqlx::query(r#"SELECT "email" FROM "Operator" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    sqlx::query(r#"UPDATE "Operator" SET "disabledAt" = now(), "updatedAt" = now() WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    sqlx::query(
        r#"UPDATE "OperatorRefreshToken" SET "revokedAt" = now()
            WHERE "operatorId" = $1 AND "revokedAt" IS NULL"#,
    )
    .bind(&id)
    .execute(&state.pool)
    .await?;
    op_audit(
        &state.pool,
        &op.id,
        "OPERATOR_DISABLED",
        Some("Operator"),
        Some(&id),
        None,
        Some(json!({ "email": s(&row, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `POST /api/operator/operators/:id/enable` — 201, SuperOperatorGuard.
async fn op_operator_enable(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    op.require_super()?;
    let row = sqlx::query(r#"SELECT "email" FROM "Operator" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    sqlx::query(r#"UPDATE "Operator" SET "disabledAt" = NULL, "updatedAt" = now() WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    op_audit(
        &state.pool,
        &op.id,
        "OPERATOR_ENABLED",
        Some("Operator"),
        Some(&id),
        None,
        Some(json!({ "email": s(&row, "email") })),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

// ---------------------------------------------------------------------------
// /api/operator/abuse  (v1 `abuse/abuse.controller.ts` + `abuse.service.ts`)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AbuseQuery {
    #[serde(default)]
    acked: Option<String>,
    #[serde(default)]
    rule: Option<String>,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

async fn abuse_list(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Query(qp): Query<AbuseQuery>,
) -> ApiResult<Json<Value>> {
    let (limit, offset) = limit_offset(qp.limit.as_deref(), qp.offset.as_deref(), 100, 500);
    let acked = match qp.acked.as_deref() {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let rule = qp.rule.filter(|v| !v.is_empty());
    let ip = qp.ip.filter(|v| !v.is_empty());
    const W: &str = r#"($1::bool IS NULL
                        OR ($1 AND e."ackedAt" IS NOT NULL)
                        OR (NOT $1 AND e."ackedAt" IS NULL))
                   AND ($2::text IS NULL OR e."rule" = $2)
                   AND ($3::text IS NULL OR e."ip" = $3)"#;

    let rows = sqlx::query(&format!(
        r#"SELECT e."id", e."rule", e."ip", e."userId", e."path", e."metadata",
                  e."ackedAt", e."ackedByOperatorId", e."createdAt",
                  u."email" AS "userEmail", (u."id" IS NOT NULL) AS "hasUser"
             FROM "AbuseEvent" e
             LEFT JOIN "User" u ON u."id" = e."userId"
            WHERE {W}
            ORDER BY e."createdAt" DESC
            LIMIT $4 OFFSET $5"#
    ))
    .bind(acked)
    .bind(rule.as_deref())
    .bind(ip.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;

    let total: i64 = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM "AbuseEvent" e WHERE {W}"#
    ))
    .bind(acked)
    .bind(rule.as_deref())
    .bind(ip.as_deref())
    .fetch_one(&state.pool)
    .await?;

    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": s(r, "id"),
                "rule": s(r, "rule"),
                "ip": os(r, "ip"),
                "userId": os(r, "userId"),
                "path": os(r, "path"),
                "metadata": ojson(r, "metadata"),
                "ackedAt": iso(r, "ackedAt"),
                "ackedByOperatorId": os(r, "ackedByOperatorId"),
                "createdAt": iso(r, "createdAt"),
                "user": if ob(r, "hasUser") {
                    json!({ "email": s(r, "userEmail"), "id": os(r, "userId") })
                } else {
                    Value::Null
                },
            })
        })
        .collect();
    Ok(Json(json!({ "rows": out, "total": total })))
}

/// `POST /api/operator/abuse/:id/ack` — 201.
async fn abuse_ack(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let n = sqlx::query(
        r#"UPDATE "AbuseEvent" SET "ackedAt" = now(), "ackedByOperatorId" = $2 WHERE "id" = $1"#,
    )
    .bind(&id)
    .bind(&op.id)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if n == 0 {
        // v1 uses prisma.update(), whose P2025 is not an HttpException — the
        // global filter turns it into a bare 500. Reproduced.
        return Err(ApiError::internal("Internal server error"));
    }
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

/// `POST /api/operator/abuse/ack-ip/:ip` — 201.
async fn abuse_ack_ip(
    State(state): State<AppState>,
    op: OperatorCtx,
    Path(ip): Path<String>,
) -> ApiResult<Response> {
    sqlx::query(
        r#"UPDATE "AbuseEvent" SET "ackedAt" = now(), "ackedByOperatorId" = $2
            WHERE "ip" = $1 AND "ackedAt" IS NULL"#,
    )
    .bind(&ip)
    .bind(&op.id)
    .execute(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))).into_response())
}

fn blocked_ip_dto(r: &PgRow) -> Value {
    json!({
        "ip": s(r, "ip"),
        "reason": os(r, "reason"),
        "createdByOperatorId": s(r, "createdByOperatorId"),
        "createdAt": iso(r, "createdAt"),
    })
}

async fn abuse_blocked_list(State(state): State<AppState>, _op: OperatorCtx) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(r#"SELECT * FROM "BlockedIp" ORDER BY "createdAt" DESC"#)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(json!(rows.iter().map(blocked_ip_dto).collect::<Vec<_>>())))
}

/// `POST /api/operator/abuse/block-ip` — 201, returns the BlockedIp row.
async fn abuse_block(
    State(state): State<AppState>,
    op: OperatorCtx,
    Json(body): Json<Value>,
) -> ApiResult<Response> {
    let ip = body
        .get("ip")
        .and_then(|v| v.as_str())
        .filter(|v| (3..=64).contains(&v.chars().count()))
        .ok_or_else(|| {
            ApiError::bad("ip must be longer than or equal to 3 and shorter than or equal to 64 characters")
        })?
        .to_string();
    let reason = match body.get("reason") {
        None | Some(Value::Null) => None,
        Some(Value::String(v)) => Some(v.clone()),
        Some(_) => return Err(ApiError::bad("reason must be a string")),
    };
    let row = sqlx::query(
        r#"INSERT INTO "BlockedIp" ("ip","reason","createdByOperatorId","createdAt")
           VALUES ($1,$2,$3,now())
           ON CONFLICT ("ip") DO UPDATE SET "reason" = $2, "createdByOperatorId" = $3
           RETURNING *"#,
    )
    .bind(&ip)
    .bind(reason.as_deref())
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(blocked_ip_dto(&row))).into_response())
}

/// `DELETE /api/operator/abuse/block-ip/:ip` — 200, always `{ok:true}`.
async fn abuse_unblock(
    State(state): State<AppState>,
    _op: OperatorCtx,
    Path(ip): Path<String>,
) -> ApiResult<Json<Value>> {
    let _ = sqlx::query(r#"DELETE FROM "BlockedIp" WHERE "ip" = $1"#)
        .bind(&ip)
        .execute(&state.pool)
        .await;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// /api/admin/compliance   (JwtAuthGuard + AdminGuard)
// ---------------------------------------------------------------------------

/// `POST /api/admin/compliance/retention/sweep` — @HttpCode(200).
async fn compliance_sweep(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    let audit_days: i64 = std::env::var("RETENTION_AUDIT_DAYS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v: &i64| *v > 0)
        .unwrap_or(365);

    let audit_cut = now_naive() - chrono::Duration::days(audit_days);
    let d30 = now_naive() - chrono::Duration::days(30);
    let d90 = now_naive() - chrono::Duration::days(90);
    let d7 = now_naive() - chrono::Duration::days(7);

    let del = |sql: &'static str, cut: chrono::NaiveDateTime| {
        let pool = state.pool.clone();
        async move {
            sqlx::query(sql).bind(cut).execute(&pool).await.map(|r| r.rows_affected() as i64)
        }
    };

    let audit_log = del(r#"DELETE FROM "AuditLog" WHERE "createdAt" < $1"#, audit_cut).await?;
    // Revoked AND expired refresh tokens.
    let refresh_token = del(
        r#"DELETE FROM "RefreshToken" WHERE "expiresAt" < $1 OR "revokedAt" < $1"#,
        d30,
    )
    .await?;
    let webhook_delivery =
        del(r#"DELETE FROM "WebhookDelivery" WHERE "startedAt" < $1"#, d30).await?;
    let scheduled_query_run =
        del(r#"DELETE FROM "ScheduledQueryRun" WHERE "startedAt" < $1"#, d90).await?;
    let email_verification =
        del(r#"DELETE FROM "EmailVerification" WHERE "createdAt" < $1"#, d7).await?;
    let password_reset = del(r#"DELETE FROM "PasswordReset" WHERE "createdAt" < $1"#, d7).await?;

    tracing::info!(
        "Retention applied: auditLog={audit_log} refreshToken={refresh_token} webhookDelivery={webhook_delivery} scheduledQueryRun={scheduled_query_run} emailVerification={email_verification} passwordReset={password_reset}"
    );
    Ok(Json(json!({
        "auditLog": audit_log,
        "refreshToken": refresh_token,
        "webhookDelivery": webhook_delivery,
        "scheduledQueryRun": scheduled_query_run,
        "emailVerification": email_verification,
        "passwordReset": password_reset,
    })))
}

#[derive(Deserialize)]
struct SinceQuery {
    #[serde(default, rename = "sinceMs")]
    since_ms: Option<String>,
}

/// `GET /api/admin/compliance/audit/export` — HMAC-chained NDJSON, streamed.
///
/// The chain seed is `HMAC-SHA256(ENCRYPTION_KEY_BYTES, "audit-export")`, and
/// every line carries the previous line's digest, so a removed or edited line is
/// detectable downstream. Paged 1000 rows at a time and written straight to the
/// socket — a multi-million-row log must never be buffered in a 384 MB container.
async fn compliance_audit_export(
    State(state): State<AppState>,
    user: AuthUser,
    Query(qp): Query<SinceQuery>,
) -> ApiResult<Response> {
    require_admin(&state, &user.id).await?;

    let key_b64 = env_opt("ENCRYPTION_KEY")
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured — signed audit export unavailable"))?;
    let key = B64_STD
        .decode(key_b64.trim())
        .map_err(|_| ApiError::internal("ENCRYPTION_KEY is not valid base64"))?;
    let mut seed = <Hmac<Sha256>>::new_from_slice(&key)
        .map_err(|_| ApiError::internal("bad ENCRYPTION_KEY"))?;
    seed.update(b"audit-export");
    let secret = seed.finalize().into_bytes().to_vec();

    let since = parse_int(qp.since_ms.as_deref())
        .map(|ms| chrono::Utc::now().naive_utc() - chrono::Duration::milliseconds(ms));

    let pool = state.pool.clone();
    let (mut wtr, rdr) = tokio::io::duplex(64 * 1024);
    tokio::spawn(async move {
        let page_size: i64 = 1000;
        let mut cursor: Option<(chrono::NaiveDateTime, String)> = None;
        let mut prev_hash =
            String::from("0000000000000000000000000000000000000000000000000000000000000000");
        loop {
            let rows = sqlx::query(
                r#"SELECT "id","createdAt","userId","connectionId","action"::text AS action,
                          "sqlText","affectedRows","ip","userAgent","metadata"
                     FROM "AuditLog"
                    WHERE ($1::timestamp IS NULL OR "createdAt" >= $1)
                      AND ($2::timestamp IS NULL
                           OR ("createdAt", "id") > ($2::timestamp, $3::text))
                    ORDER BY "createdAt" ASC, "id" ASC
                    LIMIT $4"#,
            )
            .bind(since)
            .bind(cursor.as_ref().map(|c| c.0))
            .bind(cursor.as_ref().map(|c| c.1.clone()))
            .bind(page_size)
            .fetch_all(&pool)
            .await;
            let rows = match rows {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("compliance audit export failed: {e}");
                    return;
                }
            };
            if rows.is_empty() {
                return;
            }
            let mut buf = String::new();
            for r in &rows {
                let payload = json!({
                    "id": s(r, "id"),
                    "at": iso(r, "createdAt"),
                    "userId": os(r, "userId"),
                    "connectionId": os(r, "connectionId"),
                    "action": s(r, "action"),
                    "sqlText": os(r, "sqlText"),
                    "affectedRows": oi32(r, "affectedRows"),
                    "ip": os(r, "ip"),
                    "userAgent": os(r, "userAgent"),
                    "metadata": ojson(r, "metadata"),
                    "prevHash": prev_hash,
                });
                let body = payload.to_string();
                let mut mac = match <Hmac<Sha256>>::new_from_slice(&secret) {
                    Ok(m) => m,
                    Err(_) => return,
                };
                mac.update(prev_hash.as_bytes());
                mac.update(body.as_bytes());
                let hash: String =
                    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
                prev_hash = hash.clone();
                let mut out = payload;
                if let Some(o) = out.as_object_mut() {
                    o.insert("hmac".into(), json!(hash));
                }
                buf.push_str(&out.to_string());
                buf.push('\n');
            }
            if wtr.write_all(buf.as_bytes()).await.is_err() {
                return;
            }
            let n = rows.len() as i64;
            let last = &rows[rows.len() - 1];
            let created: Option<chrono::NaiveDateTime> = last.try_get("createdAt").ok();
            match created {
                Some(c) => cursor = Some((c, s(last, "id"))),
                None => return,
            }
            if n < page_size {
                return;
            }
        }
    });

    let stamp = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/x-ndjson")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"audit-{stamp}.ndjson\""),
        )
        .body(Body::from_stream(ReaderStream::new(rdr)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

/// Collect a relation into a JSON array using an explicit column → key mapping.
async fn rel(
    pool: &PgPool,
    sql: &str,
    id: &str,
    keys: &[(&str, Kind)],
) -> ApiResult<Value> {
    let rows = sqlx::query(sql).bind(id).fetch_all(pool).await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                let mut o = Map::new();
                for (k, kind) in keys {
                    let v = match kind {
                        Kind::Text => os(r, k).map(Value::from).unwrap_or(Value::Null),
                        Kind::TextReq => Value::from(s(r, k)),
                        Kind::Ts => iso(r, k).map(Value::from).unwrap_or(Value::Null),
                    };
                    o.insert((*k).to_string(), v);
                }
                Value::Object(o)
            })
            .collect(),
    ))
}

enum Kind {
    /// Nullable text column.
    Text,
    /// NOT NULL text column (includes `::text`-cast enums).
    TextReq,
    /// `timestamp WITHOUT time zone`.
    Ts,
}

/// `GET /api/admin/compliance/users/:id/export` — GDPR Article 15.
async fn compliance_export_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    let u = sqlx::query(
        r#"SELECT "id","email","displayName","density"::text AS density,"theme"::text AS theme,
                  "oauthProvider","oauthId","emailVerifiedAt","isAdmin","suspendedAt",
                  "suspendedReason","approvalStatus"::text AS "approvalStatus","approvalNote",
                  "approvedAt","rejectedAt","approvedByOperatorId","createdAt","updatedAt"
             FROM "User" WHERE "id" = $1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    let p = &state.pool;
    // `passwordHash` is never selected — redacted exactly as v1 does.
    let out = json!({
        "id": s(&u, "id"),
        "email": s(&u, "email"),
        "displayName": os(&u, "displayName"),
        "density": s(&u, "density"),
        "theme": s(&u, "theme"),
        "oauthProvider": os(&u, "oauthProvider"),
        "oauthId": os(&u, "oauthId"),
        "emailVerifiedAt": iso(&u, "emailVerifiedAt"),
        "isAdmin": ob(&u, "isAdmin"),
        "suspendedAt": iso(&u, "suspendedAt"),
        "suspendedReason": os(&u, "suspendedReason"),
        "approvalStatus": s(&u, "approvalStatus"),
        "approvalNote": os(&u, "approvalNote"),
        "approvedAt": iso(&u, "approvedAt"),
        "rejectedAt": iso(&u, "rejectedAt"),
        "approvedByOperatorId": os(&u, "approvedByOperatorId"),
        "createdAt": iso(&u, "createdAt"),
        "updatedAt": iso(&u, "updatedAt"),
        "refreshTokens": rel(p,
            r#"SELECT "id","userAgent","ip","createdAt","expiresAt","revokedAt"
                 FROM "RefreshToken" WHERE "userId" = $1"#, &id,
            &[("id", Kind::TextReq), ("userAgent", Kind::Text), ("ip", Kind::Text),
              ("createdAt", Kind::Ts), ("expiresAt", Kind::Ts), ("revokedAt", Kind::Ts)]).await?,
        "workspaceMembers": rel(p,
            r#"SELECT "workspaceId","role"::text AS role,"createdAt"
                 FROM "WorkspaceMember" WHERE "userId" = $1"#, &id,
            &[("workspaceId", Kind::TextReq), ("role", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "ownedWorkspaces": rel(p,
            r#"SELECT "id","name","slug","createdAt" FROM "Workspace" WHERE "ownerId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("slug", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "connections": rel(p,
            r#"SELECT "id","name","dialect"::text AS dialect,"createdAt"
                 FROM "Connection" WHERE "ownerId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("dialect", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "memberships": rel(p,
            r#"SELECT "connectionId","role"::text AS role,"createdAt"
                 FROM "ConnectionMember" WHERE "userId" = $1"#, &id,
            &[("connectionId", Kind::TextReq), ("role", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "savedQueries": rel(p,
            r#"SELECT "id","name","sqlText","createdAt" FROM "SavedQuery" WHERE "userId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("sqlText", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "comments": rel(p,
            r#"SELECT "id","body","target","createdAt" FROM "Comment" WHERE "userId" = $1"#, &id,
            &[("id", Kind::TextReq), ("body", Kind::TextReq), ("target", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "scheduledQueries": rel(p,
            r#"SELECT "id","name","cron","sqlText","createdAt"
                 FROM "ScheduledQuery" WHERE "ownerId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("cron", Kind::TextReq),
              ("sqlText", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "apiKeys": rel(p,
            r#"SELECT "id","name","tokenPrefix","createdAt","revokedAt","lastUsedAt"
                 FROM "ApiKey" WHERE "userId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("tokenPrefix", Kind::TextReq),
              ("createdAt", Kind::Ts), ("revokedAt", Kind::Ts), ("lastUsedAt", Kind::Ts)]).await?,
        "dashboards": rel(p,
            r#"SELECT "id","name","createdAt" FROM "Dashboard" WHERE "ownerId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "notebooks": rel(p,
            r#"SELECT "id","name","createdAt" FROM "Notebook" WHERE "ownerId" = $1"#, &id,
            &[("id", Kind::TextReq), ("name", Kind::TextReq), ("createdAt", Kind::Ts)]).await?,
        "schemaDocs": rel(p,
            r#"SELECT "id","schemaName","tableName","columnName","updatedAt"
                 FROM "SchemaDoc" WHERE "updatedById" = $1"#, &id,
            &[("id", Kind::TextReq), ("schemaName", Kind::TextReq), ("tableName", Kind::TextReq),
              ("columnName", Kind::TextReq), ("updatedAt", Kind::Ts)]).await?,
        "auditLogs": rel(p,
            r#"SELECT "id","action"::text AS action,"sqlText","createdAt","ip","userAgent"
                 FROM "AuditLog" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1000"#, &id,
            &[("id", Kind::TextReq), ("action", Kind::TextReq), ("sqlText", Kind::Text),
              ("createdAt", Kind::Ts), ("ip", Kind::Text), ("userAgent", Kind::Text)]).await?,
    });

    Ok(Json(json!({
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "schemaVersion": 1,
        "user": out,
    })))
}

/// `DELETE /api/admin/compliance/users/:id` — @HttpCode(200). GDPR Article 17.
async fn compliance_delete_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    if user.id == id {
        return Err(ApiError::bad("Admins cannot delete themselves via this endpoint"));
    }
    let exists: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    }
    // Owned connections/workspaces cascade; the audit trail's optional FK is
    // SET NULL, so the event log survives the deletion.
    sqlx::query(r#"DELETE FROM "User" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    tracing::info!("User {id} deleted by admin {}", user.id);
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// SSRF guard — v1 `common/ssrf-guard.service.ts` (same approach as collab.rs)
// ---------------------------------------------------------------------------
//
// SECURITY: `https://` alone does not stop a webhook target pointing at our own
// internals, and a non-2xx reply reflects 200 characters of the internal
// response body back in the error message — a *readable* SSRF, not a blind one.

fn allow_private_hosts() -> bool {
    std::env::var("ALLOW_PRIVATE_HOSTS").map(|v| v == "true").unwrap_or(false)
}

/// Minimal absolute-URL split: everything v1 reads off `new URL(...)`.
fn parse_url(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    let colon = raw.find(':')?;
    let scheme = raw[..colon].to_ascii_lowercase();
    if !scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    let rest = &raw[colon + 1..];
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip userinfo: everything up to and including the LAST '@'.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or("").to_string(),
        None => authority.split(':').next().unwrap_or("").to_string(),
    };
    if (scheme == "http" || scheme == "https") && host.is_empty() {
        return None;
    }
    Some((scheme, host))
}

fn is_blocked_v4(a: Ipv4Addr) -> bool {
    let [x, y, ..] = a.octets();
    x == 0
        || x == 10
        || x == 127
        || (x == 169 && y == 254) // link-local — cloud metadata (169.254.169.254)
        || (x == 172 && (16..=31).contains(&y))
        || (x == 192 && y == 168)
        || (x == 100 && (64..=127).contains(&y))
        || (x == 192 && y == 0)
        || (x == 198 && (y == 18 || y == 19))
        || x >= 224
}

fn is_blocked_v6(a: Ipv6Addr) -> bool {
    if a.is_unspecified() || a.is_loopback() {
        return true;
    }
    if let Some(v4) = a.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    let s = a.to_string();
    s.starts_with("fe80") || s.starts_with("fc") || s.starts_with("fd") || s.starts_with("ff")
}

fn is_blocked(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(a) => is_blocked_v4(a),
        IpAddr::V6(a) => is_blocked_v6(a),
    }
}

/// v1 `assertPublicHost`: validate the RESOLVED addresses, not the name.
async fn assert_public_host(host: &str, label: &str) -> ApiResult<()> {
    if allow_private_hosts() {
        return Ok(());
    }
    let cleaned = host.trim().trim_start_matches('[').trim_end_matches(']');
    if cleaned.is_empty() {
        return Err(ApiError::bad(format!("{label} is required")));
    }
    let addrs: Vec<IpAddr> = match cleaned.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => {
            let resolved = tokio::net::lookup_host((cleaned, 80u16))
                .await
                .map(|it| it.map(|s| s.ip()).collect::<Vec<_>>())
                .unwrap_or_default();
            if resolved.is_empty() {
                return Err(ApiError::bad(format!(
                    "{label} \"{cleaned}\" could not be resolved to a public address"
                )));
            }
            resolved
        }
    };
    for addr in addrs {
        if is_blocked(addr) {
            return Err(ApiError::bad(format!(
                "{label} \"{cleaned}\" resolves to a private or internal address ({addr}), which isn't allowed. \
                 To reach a database on your own network, route the connection through a local agent instead."
            )));
        }
    }
    Ok(())
}

async fn assert_public_url(raw: &str, label: &str) -> ApiResult<()> {
    let (scheme, host) =
        parse_url(raw).ok_or_else(|| ApiError::bad(format!("{label} is not a valid URL")))?;
    if scheme != "http" && scheme != "https" {
        return Err(ApiError::bad(format!("{label} must be http(s)")));
    }
    assert_public_host(&host, label).await
}

// ---------------------------------------------------------------------------
// POST /api/connections/:id/export   (v1 `exports/`)
// ---------------------------------------------------------------------------

const MAX_EXPORT_ROWS: i64 = 50_000;
const MAX_SLACK_PREVIEW_ROWS: usize = 20;

/// v1 `toCsv`'s value stringifier: `null`/`undefined` → "", objects/arrays →
/// `JSON.stringify`, everything else → `String(v)`.
fn cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// v1 `toCsv`'s escape: quote when the value contains `"`, `,`, CR or LF.
fn csv_cell(v: &Value) -> String {
    let s = cell(v);
    if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

fn to_csv(rows: &[Value]) -> String {
    let Some(first) = rows.first().and_then(|r| r.as_object()) else {
        return String::new();
    };
    let headers: Vec<String> = first.keys().cloned().collect();
    let mut lines = vec![headers.join(",")];
    for r in rows {
        let o = r.as_object();
        lines.push(
            headers
                .iter()
                .map(|h| csv_cell(o.and_then(|m| m.get(h)).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    lines.join("\n")
}

fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// v1 `previewMarkdownTable`.
fn preview_markdown_table(rows: &[Value], limit: usize) -> String {
    let Some(first) = rows.first().and_then(|r| r.as_object()) else {
        return "_(no rows)_".to_string();
    };
    let headers: Vec<String> = first.keys().cloned().collect();
    let fmt = |v: &Value| -> String {
        let s = cell(v);
        if s.chars().count() > 60 {
            format!("{}...", truncate_chars(&s, 57))
        } else {
            s
        }
    };
    let mut out = vec![
        format!("| {} |", headers.join(" | ")),
        format!("| {} |", headers.iter().map(|_| "---").collect::<Vec<_>>().join(" | ")),
    ];
    for r in rows.iter().take(limit) {
        let o = r.as_object();
        out.push(format!(
            "| {} |",
            headers
                .iter()
                .map(|h| fmt(o.and_then(|m| m.get(h)).unwrap_or(&Value::Null)))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }
    if rows.len() > limit {
        out.push(format!("_…and {} more_", rows.len() - limit));
    }
    out.join("\n")
}

#[derive(Deserialize)]
struct ExportDto {
    sql: String,
    target: String,
    to: String,
    #[serde(default)]
    name: Option<String>,
}

/// `POST /api/connections/:id/export` — @HttpCode(200), RbacGuard VIEWER.
async fn export_run(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    // --- RbacGuard.require(user, id, VIEWER) -------------------------------
    let role = match conn_role(&state.pool, &id, &user.id).await? {
        Some(r) => r,
        None => {
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                    .bind(&id)
                    .fetch_optional(&state.pool)
                    .await?;
            return Err(if exists.is_none() {
                ApiError::new(StatusCode::NOT_FOUND, "Connection not found")
            } else {
                ApiError::new(StatusCode::FORBIDDEN, "No access to this connection")
            });
        }
    };

    // Anything Rust can't execute faithfully (agent tunnel, non-Postgres
    // dialect, no ENCRYPTION_KEY) goes to v1 rather than erroring.
    let conn = sqlx::query(
        r#"SELECT "credentialsCt", "dialect"::text AS dialect, "statementTimeoutMs", "viaAgent"
             FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let dialect = s(&conn, "dialect").to_lowercase();
    if ob(&conn, "viaAgent") || !dialect.contains("postgres") || state.crypto.is_none() {
        return Ok(crate::proxy(State(state.clone()), req).await);
    }

    // --- body --------------------------------------------------------------
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, 26_214_400)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))?;
    let dto: ExportDto =
        serde_json::from_slice(&bytes).map_err(|e| ApiError::bad(format!("Invalid body: {e}")))?;
    let headers = parts.headers;

    let sql_len = dto.sql.chars().count();
    if sql_len < 1 || sql_len > 100_000 {
        return Err(ApiError::bad(
            "sql must be longer than or equal to 1 and shorter than or equal to 100000 characters",
        ));
    }
    if !matches!(dto.target.as_str(), "email" | "slack" | "webhook") {
        return Err(ApiError::bad(
            "target must be one of the following values: email, slack, webhook",
        ));
    }
    let to_len = dto.to.chars().count();
    if to_len < 1 || to_len > 2_000 {
        return Err(ApiError::bad(
            "to must be longer than or equal to 1 and shorter than or equal to 2000 characters",
        ));
    }
    if let Some(n) = dto.name.as_ref() {
        let l = n.chars().count();
        if l < 1 || l > 200 {
            return Err(ApiError::bad(
                "name must be longer than or equal to 1 and shorter than or equal to 200 characters",
            ));
        }
    }

    if dto.sql.trim().is_empty() {
        return Err(ApiError::bad("SQL is required"));
    }
    if dto.to.trim().is_empty() {
        return Err(ApiError::bad("Destination is required"));
    }
    let mail_enabled = state.resend_key.is_some() && state.mail_from.is_some();
    if dto.target == "email" && !mail_enabled {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Email is not configured on this server",
        ));
    }
    if dto.target == "slack" && !dto.to.starts_with("https://hooks.slack.com/") {
        return Err(ApiError::bad("Slack target requires a hooks.slack.com webhook URL"));
    }
    if dto.target == "webhook" && !dto.to.starts_with("https://") {
        return Err(ApiError::bad("Webhook target requires an https:// URL"));
    }
    if dto.target == "webhook" {
        assert_public_url(&dto.to, "Webhook target").await?;
    }

    // --- run against the target -------------------------------------------
    let crypto = state.crypto.as_ref().expect("checked above");
    let creds_json = crypto
        .decrypt(&s(&conn, "credentialsCt"), &crate::crypto::Crypto::conn_purpose(&id))
        .map_err(|e| ApiError::bad(format!("credential decrypt failed: {e}")))?;
    let creds: crate::crypto::ConnectionCredentials = serde_json::from_str(&creds_json)
        .map_err(|e| ApiError::internal(format!("bad credentials json: {e}")))?;
    let opts = PgConnectOptions::new()
        .host(&creds.host)
        .port(creds.port)
        .username(&creds.user)
        .password(&creds.password)
        .database(&creds.database)
        .ssl_mode(PgSslMode::Disable);
    let mut c = PgConnection::connect_with(&opts)
        .await
        .map_err(|e| ApiError::bad(format!("connect to target failed: {e}")))?;

    let timeout_ms = oi32(&conn, "statementTimeoutMs").unwrap_or(30_000);
    let _ = sqlx::query(&format!("SET statement_timeout = {timeout_ms}")).execute(&mut c).await;
    // v1 `buildDriverForRole`: VIEWER always gets a read-only driver.
    if role == "VIEWER" {
        let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut c)
            .await;
    }

    let started = Instant::now();
    let trimmed = dto.sql.trim().trim_end_matches(';').trim().to_string();
    let mut rows: Vec<Value> = if crate::is_select(&trimmed) {
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) \
             FROM (SELECT * FROM ({trimmed}) _q LIMIT {MAX_EXPORT_ROWS}) t"
        );
        let v: Value = sqlx::query_scalar(&wrapped).fetch_one(&mut c).await?;
        v.as_array().cloned().unwrap_or_default()
    } else {
        sqlx::query(&trimmed).execute(&mut c).await?;
        Vec::new()
    };
    let _ = c.close().await;

    // SECURITY: apply this user's column masks to the export too — a masked
    // column must not be exfiltrable via email/slack/webhook. Same conservative
    // name-match as the query path (owners have no masks, so this is a no-op
    // for them).
    let masked: Vec<String> = sqlx::query_scalar(
        r#"SELECT DISTINCT "columnName" FROM "ColumnMask" WHERE "connectionId" = $1 AND "userId" = $2"#,
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    if !masked.is_empty() {
        for r in rows.iter_mut() {
            if let Some(o) = r.as_object_mut() {
                for col in &masked {
                    if o.contains_key(col.as_str()) {
                        o.insert(col.clone(), Value::Null);
                    }
                }
            }
        }
    }

    let title = dto
        .name
        .as_deref()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Query result".to_string());

    match dto.target.as_str() {
        "email" => send_export_email(&state, &dto.to, &title, &rows).await?,
        "slack" => send_slack(&state, &dto.to, &title, &rows, &dto.sql).await?,
        _ => send_webhook(&state, &dto.to, &title, &rows, &dto.sql).await?,
    }

    let meta = crate::req_meta(&headers);
    let _ = sqlx::query(
        r#"INSERT INTO "AuditLog"
             ("id","userId","connectionId","action","sqlText","affectedRows","ip","userAgent","metadata","createdAt")
           VALUES ($1,$2,$3,'QUERY_RUN'::"AuditAction",$4,$5,$6,$7,$8,now())"#,
    )
    .bind(gen_id())
    .bind(&user.id)
    .bind(&id)
    .bind(&dto.sql)
    .bind(rows.len() as i32)
    .bind(meta.ip.as_deref())
    .bind(meta.user_agent.as_deref())
    .bind(json!({
        "export": {
            "target": dto.target,
            "rowCount": rows.len(),
            "durationMs": started.elapsed().as_millis() as i64,
        }
    }))
    .execute(&state.pool)
    .await;

    Ok(Json(json!({ "rowCount": rows.len(), "delivered": true })).into_response())
}

/// v1 `sendEmail` — CSV attached, base64, through the Resend HTTP API.
async fn send_export_email(state: &AppState, to: &str, title: &str, rows: &[Value]) -> ApiResult<()> {
    let recipients: Vec<String> = to
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if recipients.is_empty() {
        return Err(ApiError::bad("At least one email recipient required"));
    }
    let (Some(key), Some(from)) = (state.resend_key.as_ref(), state.mail_from.as_ref()) else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Email is not configured on this server",
        ));
    };
    let csv = to_csv(rows);
    let filename: String = {
        // JS: title.replace(/[^a-z0-9-_]+/gi, '_')
        let mut out = String::new();
        let mut prev_repl = false;
        for ch in title.chars() {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                out.push(ch);
                prev_repl = false;
            } else if !prev_repl {
                out.push('_');
                prev_repl = true;
            }
        }
        format!("{out}.csv")
    };
    let payload = json!({
        "from": from,
        "to": recipients,
        "subject": format!("[Query Schema] {title} — {} rows", rows.len()),
        "text": format!("{title}\n\nRows: {}\n\nSee attachment for the full CSV.", rows.len()),
        "attachments": [{ "filename": filename, "content": B64_STD.encode(csv.as_bytes()) }],
    });
    let body = serde_json::to_vec(&payload).map_err(|e| ApiError::internal(e.to_string()))?;
    let res = state
        .http
        .post("https://api.resend.com/emails")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| ApiError::internal(format!("Resend send failed: {e}")))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(ApiError::internal(format!(
            "Resend send failed: {status} {}",
            truncate_chars(&text, 200)
        )));
    }
    Ok(())
}

async fn send_slack(
    state: &AppState,
    webhook: &str,
    title: &str,
    rows: &[Value],
    sql: &str,
) -> ApiResult<()> {
    let preview = preview_markdown_table(rows, MAX_SLACK_PREVIEW_ROWS);
    let head = format!("*{title}* — {} rows", rows.len());
    let payload = json!({
        "text": head,
        "blocks": [
            { "type": "section", "text": { "type": "mrkdwn", "text": head } },
            { "type": "section", "text": { "type": "mrkdwn",
              "text": format!("```\n{}\n```", truncate_chars(sql, 500)) } },
            { "type": "section", "text": { "type": "mrkdwn",
              "text": truncate_chars(&preview, 2500) } },
        ],
    });
    post_json(state, webhook, payload, "Slack webhook").await
}

async fn send_webhook(
    state: &AppState,
    url: &str,
    title: &str,
    rows: &[Value],
    sql: &str,
) -> ApiResult<()> {
    let payload = json!({ "title": title, "sql": sql, "rowCount": rows.len(), "rows": rows });
    post_json(state, url, payload, "Webhook").await
}

/// reqwest is built without the `json` feature — serialize and set the header
/// by hand, exactly like the rest of v2's outbound calls.
async fn post_json(state: &AppState, url: &str, payload: Value, label: &str) -> ApiResult<()> {
    let body = serde_json::to_vec(&payload).map_err(|e| ApiError::internal(e.to_string()))?;
    let res = state
        .http
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| ApiError::bad(format!("{label} request failed: {e}")))?;
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        return Err(ApiError::bad(format!(
            "{label} returned {status}: {}",
            truncate_chars(&text, 200)
        )));
    }
    Ok(())
}
