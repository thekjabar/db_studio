//! Small customer + operator modules — Rust port of six v1 Nest modules:
//! `announcements/`, `feedback/`, `feature-flags/`, `invite-codes/`,
//! `usage-analytics/` and `retention/` (all under `backend/src/`).
//!
//! Wire-compatible with v1 by design: same paths, same HTTP status codes
//! (Nest's 201-on-POST included), the same human error strings and the same
//! JSON field names, so a client cannot tell which backend answered.
//!
//! ## Access control — these are OPERATOR routes, not `AdminGuard` routes
//!
//! Every `/api/operator/*` controller in these modules is `@Public()` +
//! `@UseGuards(OperatorGuard)`. `@Public()` here does *not* mean unauthenticated:
//! it only disables the customer `JwtAuthGuard`, and `OperatorGuard`
//! (`backend/src/operator/operator.guard.ts`) then requires an operator session.
//! `require_operator` below reproduces that guard verbatim:
//!
//!   1. `Authorization: Bearer …`, else the `operator_access` cookie.
//!   2. HS256 verify against `OPERATOR_JWT_SECRET` (a *customer* JWT fails here —
//!      the two secrets are deliberately different) + expiry.
//!   3. `kind === 'operator'` (defence in depth).
//!   4. The `Operator` row still exists and `disabledAt` is null — re-read from
//!      the database on **every** request, exactly like the `User.isAdmin` lookup
//!      in `admin.rs::require_admin`, so revoking an operator takes effect
//!      immediately and a stolen token cannot outlive the row.
//!
//! Same failure strings as v1: 401 `Operator token required` /
//! `Operator token invalid` / `Not an operator token` / `Operator not found`,
//! 403 `Operator disabled`.
//!
//! ### Fail-closed when `OPERATOR_JWT_SECRET` is absent
//!
//! v1's config gives `OPERATOR_JWT_SECRET` a committed *development* default and
//! refuses to boot in production while that default is still in place — if v2
//! accepted it, anyone could mint an operator token and reach these endpoints.
//! v2's own `.env.example` does not carry the variable at all, so
//! `operator_secret()` treats "absent", "shorter than 32 chars" and "the dev
//! default" as *unconfigured*, and `routes()` then does not register the
//! operator routes at all. Unregistered paths fall through to `main.rs`'s
//! `.fallback(proxy)` and are served by v1 exactly as they are today — no
//! lockout, no forgeable operator session. Set `OPERATOR_JWT_SECRET` (the same
//! value v1 uses) to move them onto the Rust path.
//!
//! ## Timestamps
//!
//! Every Prisma `DateTime` is `TIMESTAMP(3)` — `timestamp WITHOUT time zone` —
//! so every read/write goes through `chrono::NaiveDateTime`. Decoding one as
//! `DateTime<Utc>` fails at runtime and (with `.ok()`) silently nulls the column.
//! `@updatedAt` is a *client-side* Prisma feature with no DB default, so every
//! INSERT/UPDATE here sets `"updatedAt"` explicitly.
//!
//! ## Faithful reproduction of v1 quirks (deliberate, not bugs to fix here)
//!
//! * `POST /api/feedback` is `@Public()`, and v1's `JwtAuthGuard` returns early
//!   for public routes without running passport — so `req.user` is *always*
//!   undefined there and the row is always written with `userId = NULL`, even
//!   when the caller sends a valid bearer token. `GET /api/feedback/mine`
//!   therefore returns `[]` in practice. Both are reproduced exactly.
//! * `GET /api/feedback/mine` fetches the newest 20 rows **globally** and then
//!   filters them to the caller — it is not "your newest 20".
//! * `parseInt(raw, 10) || default` treats `"0"` as falsy, so `?limit=0` means
//!   the default, not zero.
//! * Prisma `update`/`delete` on a missing row throws `P2025`, which Nest renders
//!   as a bare 500 `Internal server error`; the handful of places where that is
//!   reachable return exactly that (see `internal_error`).
//!
//! ## Not reproducible / intentionally different
//!
//! * `FeedbackService.reply` sends through v1's `EmailService` (SMTP or Resend)
//!   and returns the thrown exception's message in `error`. v2's `send_mail`
//!   (Resend only) collapses every failure into `false` + a log line, so `error`
//!   carries a fixed `"Email send failed"` string instead of the provider text.
//! * `InviteCodesService.consume` is not an HTTP route — it is called by v1's
//!   `AuthService.signup`. It is ported below as `consume_invite_code` because
//!   it is the security-critical half of this module; **v2's own `signup` in
//!   `main.rs` does not call it yet**, so a v2-served signup ignores
//!   `REQUIRE_INVITE_CODE_ON_SIGNUP`.

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, patch, post},
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgRow;
use sqlx::Row;
use std::collections::HashMap;

use crate::{gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    // ---- customer side (v1: @UseGuards(JwtAuthGuard), or @Public) ----
    let mut r = Router::new()
        // AnnouncementsController
        .route("/api/announcements/active", get(ann_active))
        .route("/api/announcements/:id/seen", post(ann_seen))
        .route("/api/announcements/:id/dismiss", post(ann_dismiss))
        // FlagsController
        .route("/api/flags/my", get(flags_my))
        // FeedbackController
        .route("/api/feedback", post(feedback_submit))
        .route("/api/feedback/mine", get(feedback_mine))
        // WaitlistController (@Public, no guard at all)
        .route("/api/waitlist", post(waitlist_add));

    // ---- operator side (v1: @UseGuards(OperatorGuard)) ----
    // Registered only when a real OPERATOR_JWT_SECRET is configured; otherwise
    // these paths stay unrouted and main.rs's fallback proxies them to v1.
    if operator_secret().is_some() {
        r = r
            // OperatorAnnouncementsController
            .route(
                "/api/operator/announcements",
                get(op_ann_list).post(op_ann_create),
            )
            .route(
                "/api/operator/announcements/:id",
                patch(op_ann_update).delete(op_ann_delete),
            )
            // OperatorFeedbackController
            .route("/api/operator/feedback", get(op_feedback_list))
            .route("/api/operator/feedback/:id", get(op_feedback_get))
            .route("/api/operator/feedback/:id/status", patch(op_feedback_status))
            .route("/api/operator/feedback/:id/note", patch(op_feedback_note))
            .route("/api/operator/feedback/:id/reply", post(op_feedback_reply))
            // OperatorFlagsController
            .route("/api/operator/flags", get(op_flags_list).post(op_flags_upsert))
            .route("/api/operator/flags/:key", delete(op_flags_remove))
            // OperatorInviteCodesController
            .route(
                "/api/operator/invite-codes",
                get(op_codes_list).post(op_codes_create),
            )
            .route("/api/operator/invite-codes/:code", delete(op_codes_remove))
            // OperatorWaitlistController
            .route("/api/operator/waitlist", get(op_waitlist_list))
            .route("/api/operator/waitlist/:id/invite", post(op_waitlist_invite))
            // OperatorAnalyticsController
            .route("/api/operator/analytics/platform", get(op_analytics_platform))
            .route("/api/operator/analytics/users/:id", get(op_analytics_user))
            .route(
                "/api/operator/analytics/users/:id/support",
                get(op_analytics_support),
            )
            // OperatorRetentionController
            .route("/api/operator/retention", get(op_retention_list))
            .route("/api/operator/retention/sweep", post(op_retention_sweep))
            .route("/api/operator/retention/:resource", patch(op_retention_update));
    }
    r
}

// ---------------------------------------------------------------------------
// OperatorGuard
// ---------------------------------------------------------------------------

/// The committed dev default from v1's config (`DEV_OPERATOR_SECRET`). Treated
/// as "unconfigured" here — see the module docs.
const DEV_OPERATOR_SECRET: &str = "dev-operator-secret-change-me-0000000000000000";

/// `OPERATOR_JWT_SECRET`, or `None` when it is missing / too short / still the
/// development default. Read once; the process env does not change at runtime.
fn operator_secret() -> Option<&'static str> {
    static SECRET: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    SECRET
        .get_or_init(|| {
            let v = std::env::var("OPERATOR_JWT_SECRET").ok()?;
            let v = v.trim().to_string();
            // v1's zod schema: min 32 chars, and production refuses the dev value.
            if v.len() < 32 || v == DEV_OPERATOR_SECRET {
                tracing::warn!(
                    "OPERATOR_JWT_SECRET is unset/insecure — /api/operator/* stays on the v1 proxy"
                );
                return None;
            }
            Some(v)
        })
        .as_deref()
}

/// What v1 attaches as `req.operator`. Only `id` is consumed by these modules
/// (`createdByOperatorId` / `updatedByOperatorId` / `repliedByOperatorId`).
struct Operator {
    id: String,
}

#[derive(Deserialize)]
struct OperatorClaims {
    sub: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    exp: Option<i64>,
}

/// HS256 verify + decode, mirroring `JwtService.verifyAsync` (which rejects an
/// expired token). Any structural problem is a single opaque `None` so the
/// caller cannot distinguish "bad signature" from "malformed", exactly as v1's
/// `catch { throw new UnauthorizedException('Operator token invalid') }` does.
fn decode_operator_token(token: &str, secret: &str) -> Option<OperatorClaims> {
    let mut parts = token.splitn(3, '.');
    let h = parts.next()?;
    let p = parts.next()?;
    let s = parts.next()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(format!("{h}.{p}").as_bytes());
    let expected = B64.encode(mac.finalize().into_bytes());
    if !ct_eq(expected.as_bytes(), s.as_bytes()) {
        return None;
    }
    let claims: OperatorClaims = serde_json::from_slice(&B64.decode(p).ok()?).ok()?;
    if let Some(exp) = claims.exp {
        if exp < chrono::Utc::now().timestamp() {
            return None;
        }
    }
    Some(claims)
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

/// v1 `OperatorGuard.canActivate`. The `Operator` row is re-read on every
/// request; `disabledAt` decides access, so its decode error is propagated
/// instead of being swallowed into a fail-open `None`.
async fn require_operator(state: &AppState, headers: &HeaderMap) -> ApiResult<Operator> {
    // Unreachable while `routes()` gates registration on this, but the guard
    // must never depend on the router to stay closed.
    let secret =
        operator_secret().ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;

    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer ").map(|t| t.to_string()))
        // Fallback to the cookie so the admin SPA can use httpOnly sessions.
        .or_else(|| crate::cookie_from_header(headers, "operator_access"))
        .ok_or_else(|| ApiError::unauthorized("Operator token required"))?;

    let claims = decode_operator_token(&token, secret)
        .ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;
    if claims.kind.as_deref() != Some("operator") {
        return Err(ApiError::unauthorized("Not an operator token"));
    }

    let row = sqlx::query(r#"SELECT "id","disabledAt" FROM "Operator" WHERE "id" = $1"#)
        .bind(&claims.sub)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Err(ApiError::unauthorized("Operator not found"));
    };
    let disabled_at: Option<chrono::NaiveDateTime> = row
        .try_get("disabledAt")
        .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;
    if disabled_at.is_some() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Operator disabled"));
    }
    let id: String = row
        .try_get("id")
        .map_err(|e| ApiError::internal(format!("operator check failed: {e}")))?;
    Ok(Operator { id })
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// v1 `NotFoundException()` with no argument renders as
/// `{ statusCode: 404, message: "Not Found" }`.
fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Not Found")
}

/// Nest's default exception filter for a non-`HttpException` throw (a raw
/// `Error`, or a Prisma `P2025`/`P2002`): 500 `Internal server error`.
fn internal_error() -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// Postgres unique-violation → the same bare 500 Prisma's `P2002` produces.
fn map_unique_violation(e: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &e {
        if db.code().as_deref() == Some("23505") {
            return internal_error();
        }
    }
    ApiError::from(e)
}

/// `parseInt(s, 10)`: optional sign, leading digits, trailing junk ignored.
fn parse_int(s: &str) -> Option<i64> {
    let t = s.trim_start();
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

/// `parseInt(raw, 10) || fallback` — NaN *and* 0 fall back, because 0 is falsy
/// in JS. Negative values are clamped to 0 (Prisma's `take: -n` "read backwards"
/// behaviour has no LIMIT equivalent; Postgres rejects a negative LIMIT).
fn js_int_or(raw: &Option<String>, fallback: i64) -> i64 {
    raw.as_deref()
        .and_then(parse_int)
        .filter(|v| *v != 0)
        .unwrap_or(fallback)
        .max(0)
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

#[derive(Deserialize)]
struct FeedbackListQuery {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    offset: Option<String>,
}

#[derive(Deserialize)]
struct DaysQuery {
    #[serde(default)]
    days: Option<String>,
}

/// class-validator `@Length(min, max)` messages, verbatim.
fn check_len(field: &str, value: &str, min: usize, max: usize) -> ApiResult<()> {
    let len = value.chars().count();
    if len < min {
        return Err(ApiError::bad(format!(
            "{field} must be longer than or equal to {min} characters"
        )));
    }
    if len > max {
        return Err(ApiError::bad(format!(
            "{field} must be shorter than or equal to {max} characters"
        )));
    }
    Ok(())
}

/// class-validator `@Min` / `@Max`, verbatim.
fn check_range(field: &str, value: i64, min: i64, max: i64) -> ApiResult<()> {
    if value < min {
        return Err(ApiError::bad(format!("{field} must not be less than {min}")));
    }
    if value > max {
        return Err(ApiError::bad(format!(
            "{field} must not be greater than {max}"
        )));
    }
    Ok(())
}

/// class-validator `@IsIn(values)`, verbatim.
fn check_in(field: &str, value: &str, allowed: &[&str]) -> ApiResult<()> {
    if allowed.contains(&value) {
        return Ok(());
    }
    Err(ApiError::bad(format!(
        "{field} must be one of the following values: {}",
        allowed.join(", ")
    )))
}

/// class-validator `@IsEmail` — the same shallow shape check `main.rs::signup`
/// uses, with validator.js's message.
fn check_email(field: &str, value: &str) -> ApiResult<()> {
    let ok = value.len() <= 254
        && !value.contains(char::is_whitespace)
        && value.split('@').count() == 2
        && value.split('@').all(|p| !p.is_empty())
        && value.split('@').nth(1).map(|d| d.contains('.')).unwrap_or(false);
    if ok {
        Ok(())
    } else {
        Err(ApiError::bad(format!("{field} must be an email")))
    }
}

/// class-validator `@IsISO8601` + `new Date(...)`. Accepts a full RFC3339
/// instant or a bare `YYYY-MM-DD` (which JS reads as UTC midnight). A local-time
/// string without an offset is read as UTC — v1 would use the Node process's
/// timezone, which in the deployed container is UTC.
fn parse_iso(field: &str, s: &str) -> ApiResult<chrono::NaiveDateTime> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(dt.naive_utc());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(dt);
        }
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        if let Some(dt) = d.and_hms_opt(0, 0, 0) {
            return Ok(dt);
        }
    }
    Err(ApiError::bad(format!(
        "{field} must be a valid ISO 8601 date string"
    )))
}

/// `new Date(null)` → the unix epoch. Reached only by a literal `"startsAt":
/// null` in a PATCH body, which `@IsOptional()` waves through in v1.
fn epoch() -> chrono::NaiveDateTime {
    chrono::DateTime::from_timestamp(0, 0)
        .expect("epoch is a valid timestamp")
        .naive_utc()
}

fn now_naive() -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// Distinguishes "key absent" (`None`) from "key present and null"
/// (`Some(None)`) — v1's `patch.x !== undefined` checks depend on it.
fn double_opt<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(d)?))
}

/// JS truthiness for a JSON value — `if (!t) return true` in `activeFor`
/// treats `null`, `false`, `0` and `""` alike.
fn json_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn str_col(r: &PgRow, col: &str) -> String {
    r.try_get::<String, _>(col).unwrap_or_default()
}

fn opt_str_col(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(col).unwrap_or(None)
}

fn i32_col(r: &PgRow, col: &str) -> i32 {
    r.try_get::<i32, _>(col).unwrap_or(0)
}

fn json_col(r: &PgRow, col: &str) -> Value {
    r.try_get::<Option<Value>, _>(col)
        .unwrap_or(None)
        .unwrap_or(Value::Null)
}

/// The UTC calendar day of `now - offset_days`, formatted like JS's
/// `new Date(...).toISOString().slice(0, 10)`.
fn day_key(offset_days: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::milliseconds(offset_days * 86_400_000))
        .format("%Y-%m-%d")
        .to_string()
}

/// `new Date(Date.now() - days * 864e5)` as a naive-UTC timestamp.
fn since_days(days: i64) -> chrono::NaiveDateTime {
    (chrono::Utc::now() - chrono::Duration::milliseconds(days * 86_400_000)).naive_utc()
}

// ===========================================================================
// Announcements — v1 AnnouncementsService
// ===========================================================================

const ANN_SEVERITIES: [&str; 3] = ["INFO", "WARNING", "CRITICAL"];

const ANN_COLS: &str = r#""id","title","body","severity"::text AS "severity","targeting","startsAt","endsAt","createdByOperatorId","createdAt","updatedAt""#;

fn announcement_json(r: &PgRow) -> Value {
    json!({
        "id": str_col(r, "id"),
        "title": str_col(r, "title"),
        "body": str_col(r, "body"),
        "severity": str_col(r, "severity"),
        "targeting": json_col(r, "targeting"),
        "startsAt": iso(r, "startsAt"),
        "endsAt": iso(r, "endsAt"),
        "createdByOperatorId": str_col(r, "createdByOperatorId"),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

/// GET /api/announcements/active — v1 `AnnouncementsController.active` +
/// `AnnouncementsService.activeFor`.
async fn ann_active(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    // The caller's workspaces: memberships first, then the ones they own —
    // same two queries, same concatenation order as v1.
    let mut workspace_ids: Vec<String> =
        sqlx::query_scalar(r#"SELECT "workspaceId" FROM "WorkspaceMember" WHERE "userId" = $1"#)
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    let owned: Vec<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Workspace" WHERE "ownerId" = $1"#)
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    workspace_ids.extend(owned);

    let now = now_naive();
    let rows = sqlx::query(&format!(
        r#"SELECT {ANN_COLS} FROM "Announcement"
           WHERE "startsAt" <= $1 AND ("endsAt" IS NULL OR "endsAt" >= $1)
           ORDER BY "startsAt" DESC"#
    ))
    .bind(now)
    .fetch_all(&state.pool)
    .await?;

    // Targeting filter, applied in-process exactly as v1 does.
    let mut visible: Vec<Value> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for r in &rows {
        let targeting = json_col(r, "targeting");
        let show = if !json_truthy(&targeting) {
            true
        } else {
            let user_hit = targeting
                .get("userIds")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty() && a.iter().any(|v| v.as_str() == Some(user.id.as_str())))
                .unwrap_or(false);
            let ws_hit = targeting
                .get("workspaceIds")
                .and_then(|v| v.as_array())
                .map(|a| {
                    !a.is_empty()
                        && a.iter().any(|v| {
                            v.as_str()
                                .map(|s| workspace_ids.iter().any(|w| w == s))
                                .unwrap_or(false)
                        })
                })
                .unwrap_or(false);
            user_hit || ws_hit
        };
        if show {
            ids.push(str_col(r, "id"));
            visible.push(announcement_json(r));
        }
    }
    if visible.is_empty() {
        return Ok(Json(json!([])));
    }

    let views = sqlx::query(
        r#"SELECT "announcementId","seenAt","dismissedAt" FROM "AnnouncementView"
           WHERE "userId" = $1 AND "announcementId" = ANY($2)"#,
    )
    .bind(&user.id)
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;
    let mut seen_by_id: HashMap<String, (bool, Option<String>)> = HashMap::new();
    for v in &views {
        // `seen: !!view.seenAt` — the column is NOT NULL, so a row means seen.
        let seen = v
            .try_get::<Option<chrono::NaiveDateTime>, _>("seenAt")
            .unwrap_or(None)
            .is_some();
        seen_by_id.insert(str_col(v, "announcementId"), (seen, iso(v, "dismissedAt")));
    }

    let out: Vec<Value> = visible
        .into_iter()
        .zip(ids.iter())
        .map(|(mut a, id)| {
            let (seen, dismissed) = seen_by_id.get(id).cloned().unwrap_or((false, None));
            if let Some(obj) = a.as_object_mut() {
                obj.insert("seen".into(), json!(seen));
                obj.insert("dismissedAt".into(), json!(dismissed));
            }
            a
        })
        .collect();
    Ok(Json(json!(out)))
}

/// POST /api/announcements/:id/seen — `@HttpCode(200)`.
async fn ann_seen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query(
        r#"INSERT INTO "AnnouncementView" ("id","announcementId","userId","seenAt")
           VALUES ($1,$2,$3,now())
           ON CONFLICT ("announcementId","userId") DO UPDATE SET "seenAt" = now()"#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&user.id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

/// POST /api/announcements/:id/dismiss — `@HttpCode(200)`.
async fn ann_dismiss(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query(
        r#"INSERT INTO "AnnouncementView" ("id","announcementId","userId","seenAt","dismissedAt")
           VALUES ($1,$2,$3,now(),now())
           ON CONFLICT ("announcementId","userId") DO UPDATE SET "dismissedAt" = now()"#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&user.id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAnnouncementBody {
    title: String,
    body: String,
    severity: String,
    #[serde(default)]
    targeting: Option<Value>,
    #[serde(default)]
    starts_at: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAnnouncementBody {
    // v1 would 500 on an explicit `null` here (Prisma rejects null for a
    // non-nullable String); v2 treats it as "absent" instead of crashing.
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default, deserialize_with = "double_opt")]
    targeting: Option<Option<Value>>,
    #[serde(default, deserialize_with = "double_opt")]
    starts_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_opt")]
    ends_at: Option<Option<String>>,
}

/// GET /api/operator/announcements?limit&offset — `{ rows, total }`.
async fn op_ann_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let limit = js_int_or(&q.limit, 50).min(200);
    let offset = js_int_or(&q.offset, 0).max(0);
    let rows = sqlx::query(&format!(
        r#"SELECT {ANN_COLS} FROM "Announcement" ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2"#
    ))
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "Announcement""#)
        .fetch_one(&state.pool)
        .await?;
    let rows: Vec<Value> = rows.iter().map(announcement_json).collect();
    Ok(Json(json!({ "rows": rows, "total": total })))
}

/// POST /api/operator/announcements — 201 (Nest's POST default).
async fn op_ann_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateAnnouncementBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let op = require_operator(&state, &headers).await?;
    check_len("title", &body.title, 1, 200)?;
    check_len("body", &body.body, 1, 5000)?;
    check_in("severity", &body.severity, &ANN_SEVERITIES)?;
    let starts_at = match &body.starts_at {
        Some(s) => parse_iso("startsAt", s)?,
        None => now_naive(),
    };
    let ends_at = match &body.ends_at {
        Some(s) => Some(parse_iso("endsAt", s)?),
        None => None,
    };
    let row = sqlx::query(&format!(
        r#"INSERT INTO "Announcement"
           ("id","title","body","severity","targeting","startsAt","endsAt",
            "createdByOperatorId","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4::"AnnouncementSeverity",$5,$6,$7,$8,now(),now())
           RETURNING {ANN_COLS}"#
    ))
    .bind(gen_id())
    .bind(&body.title)
    .bind(&body.body)
    .bind(&body.severity)
    .bind(body.targeting.clone())
    .bind(starts_at)
    .bind(ends_at)
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(announcement_json(&row))))
}

/// PATCH /api/operator/announcements/:id — 404 when the row is gone.
async fn op_ann_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<UpdateAnnouncementBody>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    if let Some(t) = &body.title {
        check_len("title", t, 1, 200)?;
    }
    if let Some(b) = &body.body {
        check_len("body", b, 1, 5000)?;
    }
    if let Some(s) = &body.severity {
        check_in("severity", s, &ANN_SEVERITIES)?;
    }
    let starts_at: Option<chrono::NaiveDateTime> = match &body.starts_at {
        None => None,
        Some(None) => Some(epoch()),
        Some(Some(s)) => Some(parse_iso("startsAt", s)?),
    };
    let ends_at: Option<Option<chrono::NaiveDateTime>> = match &body.ends_at {
        None => None,
        Some(None) => Some(None),
        Some(Some(s)) => Some(Some(parse_iso("endsAt", s)?)),
    };

    let mut n = 0usize;
    let mut sets: Vec<String> = Vec::new();
    if body.title.is_some() {
        n += 1;
        sets.push(format!(r#""title" = ${n}"#));
    }
    if body.body.is_some() {
        n += 1;
        sets.push(format!(r#""body" = ${n}"#));
    }
    if body.severity.is_some() {
        n += 1;
        sets.push(format!(r#""severity" = ${n}::"AnnouncementSeverity""#));
    }
    if body.targeting.is_some() {
        n += 1;
        sets.push(format!(r#""targeting" = ${n}"#));
    }
    if starts_at.is_some() {
        n += 1;
        sets.push(format!(r#""startsAt" = ${n}"#));
    }
    if ends_at.is_some() {
        n += 1;
        sets.push(format!(r#""endsAt" = ${n}"#));
    }
    // Prisma's @updatedAt is client-side: every update writes it.
    sets.push(r#""updatedAt" = now()"#.to_string());
    n += 1;
    let sql = format!(
        r#"UPDATE "Announcement" SET {} WHERE "id" = ${n} RETURNING {ANN_COLS}"#,
        sets.join(", ")
    );

    let mut q = sqlx::query(&sql);
    if let Some(t) = &body.title {
        q = q.bind(t.as_str());
    }
    if let Some(b) = &body.body {
        q = q.bind(b.as_str());
    }
    if let Some(s) = &body.severity {
        q = q.bind(s.as_str());
    }
    if let Some(t) = &body.targeting {
        // v1 maps an explicit `targeting: null` to `Prisma.JsonNull`, i.e. the
        // JSON scalar null *inside* the jsonb column — not SQL NULL (that would
        // be `Prisma.DbNull`). Binding a bare `Value::Null` reproduces it.
        q = q.bind(t.clone().unwrap_or(Value::Null));
    }
    if let Some(s) = starts_at {
        q = q.bind(s);
    }
    if let Some(e) = ends_at {
        q = q.bind(e);
    }
    q = q.bind(&id);
    let row = q.fetch_optional(&state.pool).await?.ok_or_else(not_found)?;
    Ok(Json(announcement_json(&row)))
}

/// DELETE /api/operator/announcements/:id — v1 swallows a missing row.
async fn op_ann_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let _ = sqlx::query(r#"DELETE FROM "Announcement" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await;
    Ok(Json(json!({ "ok": true })))
}

// ===========================================================================
// Feedback — v1 FeedbackService
// ===========================================================================

const FEEDBACK_CATEGORIES: [&str; 4] = ["BUG", "FEATURE", "QUESTION", "OTHER"];
const FEEDBACK_STATUSES: [&str; 4] = ["NEW", "TRIAGED", "ANSWERED", "CLOSED"];

const FEEDBACK_COLS: &str = r#"f."id",f."userId",f."email",f."category"::text AS "category",f."message",f."sourcePath",f."status"::text AS "status",f."internalNotes",f."replyText",f."repliedAt",f."repliedByOperatorId",f."createdAt",f."updatedAt""#;

/// `include: { user: { select: { id, email, displayName } } }`.
const FEEDBACK_USER_COLS: &str =
    r#"u."id" AS "u_id",u."email" AS "u_email",u."displayName" AS "u_displayName""#;

fn feedback_json(r: &PgRow, with_user: bool) -> Value {
    let mut v = json!({
        "id": str_col(r, "id"),
        "userId": opt_str_col(r, "userId"),
        "email": opt_str_col(r, "email"),
        "category": str_col(r, "category"),
        "message": str_col(r, "message"),
        "sourcePath": opt_str_col(r, "sourcePath"),
        "status": str_col(r, "status"),
        "internalNotes": opt_str_col(r, "internalNotes"),
        "replyText": opt_str_col(r, "replyText"),
        "repliedAt": iso(r, "repliedAt"),
        "repliedByOperatorId": opt_str_col(r, "repliedByOperatorId"),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    });
    if with_user {
        let user = match opt_str_col(r, "u_id") {
            Some(uid) => json!({
                "id": uid,
                "email": opt_str_col(r, "u_email"),
                "displayName": opt_str_col(r, "u_displayName"),
            }),
            None => Value::Null,
        };
        if let Some(o) = v.as_object_mut() {
            o.insert("user".into(), user);
        }
    }
    v
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitFeedbackBody {
    message: String,
    category: String,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// POST /api/feedback — `@Public()`, `@HttpCode(201)`.
///
/// v1's `JwtAuthGuard` short-circuits on `@Public()` without running passport,
/// so `req.user` is always undefined here: the row is written anonymously even
/// for a signed-in caller, and `email` comes solely from the body. Reproduced.
async fn feedback_submit(
    State(state): State<AppState>,
    Json(body): Json<SubmitFeedbackBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_len("message", &body.message, 1, 2000)?;
    check_in("category", &body.category, &FEEDBACK_CATEGORIES)?;
    if let Some(p) = &body.source_path {
        check_len("sourcePath", p, 0, 1000)?;
    }
    if let Some(e) = &body.email {
        check_email("email", e)?;
    }
    let row = sqlx::query(&format!(
        r#"INSERT INTO "Feedback"
           ("id","userId","email","category","message","sourcePath","createdAt","updatedAt")
           VALUES ($1,NULL,$2,$3::"FeedbackCategory",$4,$5,now(),now())
           RETURNING {FEEDBACK_COLS}"#
    ))
    .bind(gen_id())
    .bind(body.email.as_deref())
    .bind(&body.category)
    .bind(&body.message)
    .bind(body.source_path.as_deref())
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(feedback_json(&row, false))))
}

/// GET /api/feedback/mine — v1 takes the newest 20 rows *globally* and then
/// filters them down to the caller, so this is "mine, among the latest 20".
async fn feedback_mine(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT {FEEDBACK_COLS},{FEEDBACK_USER_COLS}
           FROM "Feedback" f LEFT JOIN "User" u ON u."id" = f."userId"
           ORDER BY f."createdAt" DESC LIMIT 20 OFFSET 0"#
    ))
    .fetch_all(&state.pool)
    .await?;
    let out: Vec<Value> = rows
        .iter()
        .filter(|r| opt_str_col(r, "userId").as_deref() == Some(user.id.as_str()))
        .map(|r| feedback_json(r, true))
        .collect();
    Ok(Json(json!(out)))
}

/// GET /api/operator/feedback?status&limit&offset — `{ rows, total, unread }`.
async fn op_feedback_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<FeedbackListQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let limit = js_int_or(&q.limit, 50).min(200);
    let offset = js_int_or(&q.offset, 0).max(0);
    // An unrecognised ?status is ignored (v1: `STATUSES.includes(...) ?: undefined`).
    let status = q
        .status
        .filter(|s| FEEDBACK_STATUSES.contains(&s.as_str()));

    let rows = sqlx::query(&format!(
        r#"SELECT {FEEDBACK_COLS},{FEEDBACK_USER_COLS}
           FROM "Feedback" f LEFT JOIN "User" u ON u."id" = f."userId"
           WHERE ($1::text IS NULL OR f."status"::text = $1::text)
           ORDER BY f."createdAt" DESC LIMIT $2 OFFSET $3"#
    ))
    .bind(status.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM "Feedback" WHERE ($1::text IS NULL OR "status"::text = $1::text)"#,
    )
    .bind(status.as_deref())
    .fetch_one(&state.pool)
    .await?;
    let unread: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM "Feedback" WHERE "status" = 'NEW'"#)
            .fetch_one(&state.pool)
            .await?;
    let rows: Vec<Value> = rows.iter().map(|r| feedback_json(r, true)).collect();
    Ok(Json(json!({ "rows": rows, "total": total, "unread": unread })))
}

async fn load_feedback(state: &AppState, id: &str) -> ApiResult<PgRow> {
    sqlx::query(&format!(
        r#"SELECT {FEEDBACK_COLS},{FEEDBACK_USER_COLS}
           FROM "Feedback" f LEFT JOIN "User" u ON u."id" = f."userId"
           WHERE f."id" = $1"#
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)
}

/// GET /api/operator/feedback/:id
async fn op_feedback_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let row = load_feedback(&state, &id).await?;
    Ok(Json(feedback_json(&row, true)))
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
}

/// PATCH /api/operator/feedback/:id/status
async fn op_feedback_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<StatusBody>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    check_in("status", &body.status, &FEEDBACK_STATUSES)?;
    let res = sqlx::query(
        r#"UPDATE "Feedback" SET "status" = $1::"FeedbackStatus", "updatedAt" = now() WHERE "id" = $2"#,
    )
    .bind(&body.status)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    // v1 calls prisma.update on a possibly-missing row: P2025 → bare 500.
    if res.rows_affected() == 0 {
        return Err(internal_error());
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteBody {
    internal_notes: String,
}

/// PATCH /api/operator/feedback/:id/note
async fn op_feedback_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<NoteBody>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    check_len("internalNotes", &body.internal_notes, 0, 5000)?;
    let res = sqlx::query(
        r#"UPDATE "Feedback" SET "internalNotes" = $1, "updatedAt" = now() WHERE "id" = $2"#,
    )
    .bind(&body.internal_notes)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(internal_error());
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReplyBody {
    body: String,
}

/// POST /api/operator/feedback/:id/reply — `@HttpCode(200)`.
///
/// The reply is persisted whether or not the mail goes out, so the audit trail
/// stays whole and the operator can copy the text out manually
/// (`copyToManualEmail`).
async fn op_feedback_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ReplyBody>,
) -> ApiResult<Json<Value>> {
    let op = require_operator(&state, &headers).await?;
    check_len("body", &body.body, 1, 5000)?;
    let row = load_feedback(&state, &id).await?;
    // Prefer the live account address, else the snapshot taken at submit time.
    let to = opt_str_col(&row, "u_email").or_else(|| opt_str_col(&row, "email"));

    let mail_enabled = state.resend_key.is_some() && state.mail_from.is_some();
    let mut sent = false;
    let mut error: Option<String> = None;
    if let (Some(to), true) = (to.as_deref(), mail_enabled) {
        let html = format!(
            "<div style=\"white-space:pre-wrap\">{}</div>",
            crate::html_escape(&body.body)
        );
        sent = crate::send_mail(&state, to, "Re: your feedback", &body.body, &html).await;
        if !sent {
            // v1 surfaces the transport's exception message here; v2's mailer
            // only reports success/failure, so this string is fixed.
            error = Some("Email send failed".to_string());
        }
    }

    sqlx::query(
        r#"UPDATE "Feedback"
           SET "replyText" = $1, "repliedAt" = now(), "repliedByOperatorId" = $2,
               "status" = 'ANSWERED'::"FeedbackStatus", "updatedAt" = now()
           WHERE "id" = $3"#,
    )
    .bind(&body.body)
    .bind(&op.id)
    .bind(&id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "sent": sent,
        "copyToManualEmail": !sent,
        "error": error,
    })))
}

// ===========================================================================
// Feature flags — v1 FeatureFlagsService
// ===========================================================================

const FLAG_COLS: &str = r#""key","description","rolloutPercent","enabledUserIds","enabledWorkspaceIds","disabledUserIds","disabledWorkspaceIds","updatedByOperatorId","updatedAt","createdAt""#;

fn flag_json(r: &PgRow) -> Value {
    json!({
        "key": str_col(r, "key"),
        "description": opt_str_col(r, "description"),
        "rolloutPercent": i32_col(r, "rolloutPercent"),
        "enabledUserIds": r.try_get::<Vec<String>, _>("enabledUserIds").unwrap_or_default(),
        "enabledWorkspaceIds": r.try_get::<Vec<String>, _>("enabledWorkspaceIds").unwrap_or_default(),
        "disabledUserIds": r.try_get::<Vec<String>, _>("disabledUserIds").unwrap_or_default(),
        "disabledWorkspaceIds": r.try_get::<Vec<String>, _>("disabledWorkspaceIds").unwrap_or_default(),
        "updatedByOperatorId": opt_str_col(r, "updatedByOperatorId"),
        "updatedAt": iso(r, "updatedAt"),
        "createdAt": iso(r, "createdAt"),
    })
}

/// v1 `FeatureFlagsService.match`: denylists beat allowlists, allowlists beat
/// the percentage, and the percentage bucket is a stable
/// `sha256("<key>:<userId>").readUInt32BE(0) % 100`, so a user never flickers
/// in and out of a rollout.
fn flag_matches(r: &PgRow, user_id: &str, workspace_ids: &[String], key: &str) -> bool {
    let get = |c: &str| r.try_get::<Vec<String>, _>(c).unwrap_or_default();
    let disabled_users = get("disabledUserIds");
    if disabled_users.iter().any(|u| u == user_id) {
        return false;
    }
    let disabled_ws = get("disabledWorkspaceIds");
    if workspace_ids.iter().any(|w| disabled_ws.contains(w)) {
        return false;
    }
    let enabled_users = get("enabledUserIds");
    if enabled_users.iter().any(|u| u == user_id) {
        return true;
    }
    let enabled_ws = get("enabledWorkspaceIds");
    if workspace_ids.iter().any(|w| enabled_ws.contains(w)) {
        return true;
    }
    let percent = i32_col(r, "rolloutPercent");
    if percent >= 100 {
        return true;
    }
    if percent <= 0 {
        return false;
    }
    let digest = Sha256::digest(format!("{key}:{user_id}").as_bytes());
    let bucket = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 100;
    (bucket as i32) < percent
}

/// GET /api/flags/my — `Record<flagKey, boolean>` for the caller.
async fn flags_my(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let mut workspace_ids: Vec<String> =
        sqlx::query_scalar(r#"SELECT "workspaceId" FROM "WorkspaceMember" WHERE "userId" = $1"#)
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    let owned: Vec<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Workspace" WHERE "ownerId" = $1"#)
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    workspace_ids.extend(owned);

    let rows = sqlx::query(&format!(r#"SELECT {FLAG_COLS} FROM "FeatureFlag""#))
        .fetch_all(&state.pool)
        .await?;
    let mut out = serde_json::Map::new();
    for r in &rows {
        let key = str_col(r, "key");
        let on = flag_matches(r, &user.id, &workspace_ids, &key);
        out.insert(key, json!(on));
    }
    Ok(Json(Value::Object(out)))
}

/// GET /api/operator/flags
async fn op_flags_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {FLAG_COLS} FROM "FeatureFlag" ORDER BY "key" ASC"#
    ))
    .fetch_all(&state.pool)
    .await?;
    let rows: Vec<Value> = rows.iter().map(flag_json).collect();
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertFlagBody {
    key: String,
    #[serde(default)]
    description: Option<String>,
    rollout_percent: i64,
    #[serde(default)]
    enabled_user_ids: Option<Vec<String>>,
    #[serde(default)]
    enabled_workspace_ids: Option<Vec<String>>,
    #[serde(default)]
    disabled_user_ids: Option<Vec<String>>,
    #[serde(default)]
    disabled_workspace_ids: Option<Vec<String>>,
}

/// POST /api/operator/flags — create-or-replace; 201 (Nest's POST default).
async fn op_flags_upsert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<UpsertFlagBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let op = require_operator(&state, &headers).await?;
    check_len("key", &body.key, 1, 128)?;
    check_range("rolloutPercent", body.rollout_percent, 0, 100)?;
    // v1 writes `description ?? null` and the four arrays default to [] on both
    // create *and* update — omitting one clears it.
    let enabled_users = body.enabled_user_ids.unwrap_or_default();
    let enabled_ws = body.enabled_workspace_ids.unwrap_or_default();
    let disabled_users = body.disabled_user_ids.unwrap_or_default();
    let disabled_ws = body.disabled_workspace_ids.unwrap_or_default();
    let row = sqlx::query(&format!(
        r#"INSERT INTO "FeatureFlag"
           ("key","description","rolloutPercent","enabledUserIds","enabledWorkspaceIds",
            "disabledUserIds","disabledWorkspaceIds","updatedByOperatorId","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
           ON CONFLICT ("key") DO UPDATE SET
             "description" = EXCLUDED."description",
             "rolloutPercent" = EXCLUDED."rolloutPercent",
             "enabledUserIds" = EXCLUDED."enabledUserIds",
             "enabledWorkspaceIds" = EXCLUDED."enabledWorkspaceIds",
             "disabledUserIds" = EXCLUDED."disabledUserIds",
             "disabledWorkspaceIds" = EXCLUDED."disabledWorkspaceIds",
             "updatedByOperatorId" = EXCLUDED."updatedByOperatorId",
             "updatedAt" = now()
           RETURNING {FLAG_COLS}"#
    ))
    .bind(&body.key)
    .bind(body.description.as_deref())
    .bind(body.rollout_percent as i32)
    .bind(&enabled_users)
    .bind(&enabled_ws)
    .bind(&disabled_users)
    .bind(&disabled_ws)
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(flag_json(&row))))
}

/// DELETE /api/operator/flags/:key — v1 swallows a missing row.
async fn op_flags_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let _ = sqlx::query(r#"DELETE FROM "FeatureFlag" WHERE "key" = $1"#)
        .bind(&key)
        .execute(&state.pool)
        .await;
    Ok(Json(json!({ "ok": true })))
}

// ===========================================================================
// Invite codes + waitlist — v1 InviteCodesService
// ===========================================================================

const CODE_COLS: &str = r#""code","usesRemaining","maxUses","expiresAt","assignedEmail","note","createdByOperatorId","createdAt","waitlistId""#;

fn invite_code_json(r: &PgRow) -> Value {
    json!({
        "code": str_col(r, "code"),
        "usesRemaining": i32_col(r, "usesRemaining"),
        "maxUses": i32_col(r, "maxUses"),
        "expiresAt": iso(r, "expiresAt"),
        "assignedEmail": opt_str_col(r, "assignedEmail"),
        "note": opt_str_col(r, "note"),
        "createdByOperatorId": str_col(r, "createdByOperatorId"),
        "createdAt": iso(r, "createdAt"),
        "waitlistId": opt_str_col(r, "waitlistId"),
    })
}

fn waitlist_json(r: &PgRow, with_code: bool) -> Value {
    let mut v = json!({
        "id": str_col(r, "id"),
        "email": str_col(r, "email"),
        "metadata": json_col(r, "metadata"),
        "invitedAt": iso(r, "invitedAt"),
        "notes": opt_str_col(r, "notes"),
        "createdAt": iso(r, "createdAt"),
    });
    if with_code {
        // include: { inviteCode: { select: { code, usesRemaining } } }
        let code = match opt_str_col(r, "ic_code") {
            Some(c) => json!({
                "code": c,
                "usesRemaining": r.try_get::<Option<i32>, _>("ic_usesRemaining").unwrap_or(None),
            }),
            None => Value::Null,
        };
        if let Some(o) = v.as_object_mut() {
            o.insert("inviteCode".into(), code);
        }
    }
    v
}

/// v1's default code: `randomBytes(6).toString('base64url').toUpperCase()`.
///
/// 6 random bytes → 8 base64url characters → uppercased, so the effective
/// alphabet is `[A-Z0-9-_]` (lowercase letters fold onto their uppercase twin,
/// which is why the printed code is 8 chars, not the "10 base32-ish chars" the
/// v1 comment claims). Reproduced byte-for-byte: changing the length or the
/// alphabet would invalidate codes already mailed out.
fn generate_code() -> String {
    use rand::RngCore;
    let mut b = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b).to_uppercase()
}

#[derive(Deserialize)]
struct WaitlistAddBody {
    email: String,
}

/// POST /api/waitlist — `@Public()`, no guard at all. Upsert on the lowercased
/// email, so re-submitting is idempotent and never leaks whether the address
/// was already on the list.
async fn waitlist_add(
    State(state): State<AppState>,
    Json(body): Json<WaitlistAddBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_email("email", &body.email)?;
    let email = body.email.to_lowercase();
    let row = sqlx::query(
        r#"INSERT INTO "Waitlist" ("id","email","metadata","createdAt")
           VALUES ($1,$2,NULL,now())
           ON CONFLICT ("email") DO UPDATE SET "email" = EXCLUDED."email"
           RETURNING "id","email","metadata","invitedAt","notes","createdAt""#,
    )
    .bind(gen_id())
    .bind(&email)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(waitlist_json(&row, false))))
}

/// GET /api/operator/invite-codes?limit&offset — `{ rows, total }`.
async fn op_codes_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let limit = js_int_or(&q.limit, 50).min(200);
    let offset = js_int_or(&q.offset, 0).max(0);
    let rows = sqlx::query(&format!(
        r#"SELECT {CODE_COLS} FROM "InviteCode" ORDER BY "createdAt" DESC LIMIT $1 OFFSET $2"#
    ))
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "InviteCode""#)
        .fetch_one(&state.pool)
        .await?;
    let rows: Vec<Value> = rows.iter().map(invite_code_json).collect();
    Ok(Json(json!({ "rows": rows, "total": total })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCodeBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    max_uses: Option<i64>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    assigned_email: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// The shared half of `InviteCodesService.createCode`, used by both the direct
/// create route and the waitlist promotion.
#[allow(clippy::too_many_arguments)]
async fn create_code(
    state: &AppState,
    operator_id: &str,
    code: Option<&str>,
    max_uses: Option<i64>,
    expires_at: Option<chrono::NaiveDateTime>,
    assigned_email: Option<&str>,
    note: Option<&str>,
    waitlist_id: Option<&str>,
) -> ApiResult<PgRow> {
    let code = match code {
        Some(c) => c.to_uppercase(),
        None => generate_code(),
    };
    // `usesRemaining` starts equal to `maxUses`; 0 means unlimited.
    let max_uses = max_uses.unwrap_or(1) as i32;
    sqlx::query(&format!(
        r#"INSERT INTO "InviteCode"
           ("code","usesRemaining","maxUses","expiresAt","assignedEmail","note","waitlistId",
            "createdByOperatorId","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
           RETURNING {CODE_COLS}"#
    ))
    .bind(&code)
    .bind(max_uses)
    .bind(max_uses)
    .bind(expires_at)
    .bind(assigned_email)
    .bind(note)
    .bind(waitlist_id)
    .bind(operator_id)
    .fetch_one(&state.pool)
    .await
    .map_err(map_unique_violation)
}

/// POST /api/operator/invite-codes — 201.
async fn op_codes_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateCodeBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let op = require_operator(&state, &headers).await?;
    if let Some(c) = &body.code {
        check_len("code", c, 3, 64)?;
    }
    if let Some(m) = body.max_uses {
        check_range("maxUses", m, 0, i64::from(i32::MAX))?;
    }
    if let Some(e) = &body.assigned_email {
        check_email("assignedEmail", e)?;
    }
    let expires_at = match &body.expires_at {
        Some(s) => Some(parse_iso("expiresAt", s)?),
        None => None,
    };
    let row = create_code(
        &state,
        &op.id,
        body.code.as_deref(),
        body.max_uses,
        expires_at,
        body.assigned_email.as_deref(),
        body.note.as_deref(),
        None,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(invite_code_json(&row))))
}

/// DELETE /api/operator/invite-codes/:code — exact match, not uppercased
/// (v1 deletes by the path value as given); a missing row is swallowed.
async fn op_codes_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let _ = sqlx::query(r#"DELETE FROM "InviteCode" WHERE "code" = $1"#)
        .bind(&code)
        .execute(&state.pool)
        .await;
    Ok(Json(json!({ "ok": true })))
}

/// GET /api/operator/waitlist?limit&offset — `{ rows, total }`, default limit
/// 100, cap 500.
async fn op_waitlist_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let limit = js_int_or(&q.limit, 100).min(500);
    let offset = js_int_or(&q.offset, 0).max(0);
    let rows = sqlx::query(
        r#"SELECT w."id",w."email",w."metadata",w."invitedAt",w."notes",w."createdAt",
                  ic."code" AS "ic_code", ic."usesRemaining" AS "ic_usesRemaining"
           FROM "Waitlist" w
           LEFT JOIN "InviteCode" ic ON ic."waitlistId" = w."id"
           ORDER BY w."createdAt" DESC LIMIT $1 OFFSET $2"#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "Waitlist""#)
        .fetch_one(&state.pool)
        .await?;
    let rows: Vec<Value> = rows.iter().map(|r| waitlist_json(r, true)).collect();
    Ok(Json(json!({ "rows": rows, "total": total })))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InviteEntryBody {
    #[serde(default)]
    max_uses: Option<i64>,
}

/// POST /api/operator/waitlist/:id/invite — mint a code assigned to the
/// waitlisted address and stamp `invitedAt`. 201; 404 when the entry is gone.
///
/// The body is optional (`{}` or nothing at all → `maxUses = 1`), so it is
/// parsed from raw bytes rather than the `Json` extractor, which rejects an
/// empty body that v1's body parser accepts.
async fn op_waitlist_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    raw: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let op = require_operator(&state, &headers).await?;
    let body: InviteEntryBody = if raw.is_empty() {
        InviteEntryBody::default()
    } else {
        serde_json::from_slice(&raw).map_err(|e| ApiError::bad(e.to_string()))?
    };
    if let Some(m) = body.max_uses {
        check_range("maxUses", m, 1, i64::from(i32::MAX))?;
    }
    let email: Option<String> = sqlx::query_scalar(r#"SELECT "email" FROM "Waitlist" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    let email = email.ok_or_else(not_found)?;

    let row = create_code(
        &state,
        &op.id,
        None,
        Some(body.max_uses.unwrap_or(1)),
        None,
        Some(&email),
        None,
        Some(&id),
    )
    .await?;
    sqlx::query(r#"UPDATE "Waitlist" SET "invitedAt" = now() WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok((StatusCode::CREATED, Json(invite_code_json(&row))))
}

/// v1 `InviteCodesService.consume` — the signup gate. NOT an HTTP route; kept
/// here so wiring it into `main.rs`'s `signup` (which currently ignores
/// `REQUIRE_INVITE_CODE_ON_SIGNUP`) is a single call.
///
/// Every rule is reproduced exactly, because loosening one gives away free
/// access and tightening one blocks legitimate signups:
///   * the code is trimmed and uppercased before lookup (codes are stored
///     uppercase, so users may type them in any case);
///   * `expiresAt` in the past → expired;
///   * `usesRemaining !== 0 && usesRemaining <= 0` → already used (v1's own
///     wording: only a *negative* counter trips this, since 0 is the
///     "unlimited" sentinel and is excluded first);
///   * an `assignedEmail` must match the signup address case-insensitively;
///   * `maxUses === 0` means unlimited and never decrements; otherwise the
///     decrement is a conditional UPDATE (`usesRemaining > 0`) so two parallel
///     signups cannot both claim the last use.
#[allow(dead_code)]
pub async fn consume_invite_code(state: &AppState, code: &str, email: &str) -> ApiResult<Value> {
    let normalized = code.trim().to_uppercase();
    if normalized.is_empty() {
        return Err(ApiError::bad("Invite code required"));
    }
    let row = sqlx::query(
        r#"SELECT "usesRemaining","maxUses","expiresAt","assignedEmail" FROM "InviteCode" WHERE "code" = $1"#,
    )
    .bind(&normalized)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::bad("Invite code not found"));
    };

    // Security-relevant columns: propagate a decode error, never default it.
    let expires_at: Option<chrono::NaiveDateTime> = row
        .try_get("expiresAt")
        .map_err(|e| ApiError::internal(format!("invite code read failed: {e}")))?;
    let uses_remaining: i32 = row
        .try_get("usesRemaining")
        .map_err(|e| ApiError::internal(format!("invite code read failed: {e}")))?;
    let max_uses: i32 = row
        .try_get("maxUses")
        .map_err(|e| ApiError::internal(format!("invite code read failed: {e}")))?;
    let assigned_email: Option<String> = row
        .try_get("assignedEmail")
        .map_err(|e| ApiError::internal(format!("invite code read failed: {e}")))?;

    if let Some(exp) = expires_at {
        if exp < now_naive() {
            return Err(ApiError::bad("Invite code expired"));
        }
    }
    if uses_remaining != 0 && uses_remaining <= 0 {
        return Err(ApiError::bad("Invite code already used"));
    }
    if let Some(assigned) = assigned_email {
        if assigned.to_lowercase() != email.to_lowercase() {
            return Err(ApiError::bad("Invite code does not match this email"));
        }
    }
    if max_uses != 0 {
        let res = sqlx::query(
            r#"UPDATE "InviteCode" SET "usesRemaining" = "usesRemaining" - 1
               WHERE "code" = $1 AND "usesRemaining" > 0"#,
        )
        .bind(&normalized)
        .execute(&state.pool)
        .await?;
        if res.rows_affected() == 0 {
            return Err(ApiError::bad("Invite code already used"));
        }
    }
    Ok(json!({ "ok": true }))
}

// ===========================================================================
// Usage analytics — v1 UsageAnalyticsService
// ===========================================================================

/// `Math.min(Math.max(parseInt(raw, 10) || 30, 1), 180)`.
fn days_param(raw: &Option<String>) -> i64 {
    js_int_or(raw, 30).max(1).min(180)
}

/// Counts keyed by the UTC calendar day of `createdAt` — `to_char` on a
/// `timestamp WITHOUT time zone` holding UTC is exactly JS's
/// `toISOString().slice(0, 10)`.
async fn day_counts(
    state: &AppState,
    sql: &str,
    binds: &[&str],
    since: chrono::NaiveDateTime,
) -> ApiResult<HashMap<String, i64>> {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    let rows = q.bind(since).fetch_all(&state.pool).await?;
    let mut out = HashMap::new();
    for r in &rows {
        out.insert(str_col(r, "d"), r.try_get::<i64, _>("n").unwrap_or(0));
    }
    Ok(out)
}

/// v1 `classifyUser`: buckets on days since the most recent `LOGIN` audit row.
async fn classify_user(state: &AppState, user_id: &str) -> ApiResult<&'static str> {
    let last: Option<chrono::NaiveDateTime> = sqlx::query_scalar(
        r#"SELECT "createdAt" FROM "AuditLog"
           WHERE "userId" = $1 AND "action" = 'LOGIN'::"AuditAction"
           ORDER BY "createdAt" DESC LIMIT 1"#,
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(last) = last else {
        return Ok("never_logged_in");
    };
    let ms = chrono::Utc::now().timestamp_millis() - last.and_utc().timestamp_millis();
    let days = ms.div_euclid(86_400_000);
    Ok(if days <= 7 {
        "active"
    } else if days <= 14 {
        "at_risk"
    } else {
        "dormant"
    })
}

/// GET /api/operator/analytics/platform?days
async fn op_analytics_platform(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<DaysQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let days = days_param(&q.days);
    let since = since_days(days);

    let signups = day_counts(
        &state,
        r#"SELECT to_char("createdAt", 'YYYY-MM-DD') AS "d", count(*) AS "n"
           FROM "User" WHERE "createdAt" >= $1 GROUP BY 1"#,
        &[],
        since,
    )
    .await?;
    let login_rows = sqlx::query(
        r#"SELECT to_char("createdAt", 'YYYY-MM-DD') AS "d",
                  count(*) AS "n",
                  count(DISTINCT "userId") AS "u"
           FROM "AuditLog"
           WHERE "action" = 'LOGIN'::"AuditAction" AND "createdAt" >= $1
           GROUP BY 1"#,
    )
    .bind(since)
    .fetch_all(&state.pool)
    .await?;
    let mut logins: HashMap<String, (i64, i64)> = HashMap::new();
    for r in &login_rows {
        logins.insert(
            str_col(r, "d"),
            (
                r.try_get::<i64, _>("n").unwrap_or(0),
                r.try_get::<i64, _>("u").unwrap_or(0),
            ),
        );
    }

    // Buckets for the trailing `days` calendar days, oldest first. Rows outside
    // that window are dropped, exactly as v1's `if (b)` guard does.
    let out: Vec<Value> = (0..days)
        .rev()
        .map(|i| {
            let d = day_key(i);
            let (l, u) = logins.get(&d).copied().unwrap_or((0, 0));
            json!({
                "day": d,
                "signups": signups.get(&d).copied().unwrap_or(0),
                "logins": l,
                "uniqueUsers": u,
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

/// GET /api/operator/analytics/users/:id?days
async fn op_analytics_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<DaysQuery>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let days = days_param(&q.days);
    let since = since_days(days);

    let logins = day_counts(
        &state,
        r#"SELECT to_char("createdAt", 'YYYY-MM-DD') AS "d", count(*) AS "n"
           FROM "AuditLog"
           WHERE "userId" = $1 AND "action" = 'LOGIN'::"AuditAction" AND "createdAt" >= $2
           GROUP BY 1"#,
        &[&id],
        since,
    )
    .await?;
    let queries = day_counts(
        &state,
        r#"SELECT to_char("createdAt", 'YYYY-MM-DD') AS "d", count(*) AS "n"
           FROM "AuditLog"
           WHERE "userId" = $1 AND "action" = 'QUERY_RUN'::"AuditAction" AND "createdAt" >= $2
           GROUP BY 1"#,
        &[&id],
        since,
    )
    .await?;
    // AiUsageDay."day" is a YYYY-MM-DD *string*, compared as a string in v1.
    let since_day = since.format("%Y-%m-%d").to_string();
    let ai_rows = sqlx::query(
        r#"SELECT "day" AS "d", sum("callsUsed")::bigint AS "n"
           FROM "AiUsageDay" WHERE "userId" = $1 AND "day" >= $2 GROUP BY 1"#,
    )
    .bind(&id)
    .bind(&since_day)
    .fetch_all(&state.pool)
    .await?;
    let mut ai: HashMap<String, i64> = HashMap::new();
    for r in &ai_rows {
        ai.insert(str_col(r, "d"), r.try_get::<i64, _>("n").unwrap_or(0));
    }

    let series: Vec<Value> = (0..days)
        .rev()
        .map(|i| {
            let d = day_key(i);
            json!({
                "day": d,
                "logins": logins.get(&d).copied().unwrap_or(0),
                "queries": queries.get(&d).copied().unwrap_or(0),
                "aiCalls": ai.get(&d).copied().unwrap_or(0),
            })
        })
        .collect();

    Ok(Json(json!({
        "classification": classify_user(&state, &id).await?,
        "series": series,
    })))
}

const AUDIT_COLS: &str = r#""id","userId","connectionId","action"::text AS "action","sqlText","affectedRows","ip","userAgent","metadata","createdAt""#;

fn audit_json(r: &PgRow) -> Value {
    json!({
        "id": str_col(r, "id"),
        "userId": opt_str_col(r, "userId"),
        "connectionId": opt_str_col(r, "connectionId"),
        "action": str_col(r, "action"),
        "sqlText": opt_str_col(r, "sqlText"),
        "affectedRows": r.try_get::<Option<i32>, _>("affectedRows").unwrap_or(None),
        "ip": opt_str_col(r, "ip"),
        "userAgent": opt_str_col(r, "userAgent"),
        "metadata": json_col(r, "metadata"),
        "createdAt": iso(r, "createdAt"),
    })
}

fn abuse_json(r: &PgRow) -> Value {
    json!({
        "id": str_col(r, "id"),
        "rule": str_col(r, "rule"),
        "ip": opt_str_col(r, "ip"),
        "userId": opt_str_col(r, "userId"),
        "path": opt_str_col(r, "path"),
        "metadata": json_col(r, "metadata"),
        "ackedAt": iso(r, "ackedAt"),
        "ackedByOperatorId": opt_str_col(r, "ackedByOperatorId"),
        "createdAt": iso(r, "createdAt"),
    })
}

/// GET /api/operator/analytics/users/:id/support — recent failures for one
/// user; v1's fixed `limit = 100` per list.
async fn op_analytics_support(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let audit_sql = format!(
        r#"SELECT {AUDIT_COLS} FROM "AuditLog"
           WHERE "userId" = $1 AND "action" = $2::"AuditAction"
           ORDER BY "createdAt" DESC LIMIT 100"#
    );
    let failed = sqlx::query(&audit_sql)
        .bind(&id)
        .bind("LOGIN_FAILED")
        .fetch_all(&state.pool)
        .await?;
    let suspended = sqlx::query(&audit_sql)
        .bind(&id)
        .bind("LOGIN_SUSPENDED")
        .fetch_all(&state.pool)
        .await?;
    let abuse = sqlx::query(
        r#"SELECT "id","rule","ip","userId","path","metadata","ackedAt","ackedByOperatorId","createdAt"
           FROM "AbuseEvent" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 100"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "failedLogins": failed.iter().map(audit_json).collect::<Vec<_>>(),
        "suspendedLogins": suspended.iter().map(audit_json).collect::<Vec<_>>(),
        "abuseEvents": abuse.iter().map(abuse_json).collect::<Vec<_>>(),
    })))
}

// ===========================================================================
// Retention — v1 RetentionService
// ===========================================================================

/// v1's `defaults` map, in insertion order (`Object.entries` order decides the
/// seeding order).
const RETENTION_DEFAULTS: [(&str, i32); 6] = [
    ("audit_log", 365),
    ("query_history", 180),
    ("ai_usage_day", 90),
    ("slow_query_log", 90),
    ("abuse_event", 90),
    ("feedback", 730),
];

const RETENTION_COLS: &str = r#""resource","keepDays","lastRunAt","lastRunRowsDeleted","updatedByOperatorId","updatedAt","createdAt""#;

fn retention_json(r: &PgRow) -> Value {
    json!({
        "resource": str_col(r, "resource"),
        "keepDays": i32_col(r, "keepDays"),
        "lastRunAt": iso(r, "lastRunAt"),
        "lastRunRowsDeleted": i32_col(r, "lastRunRowsDeleted"),
        "updatedByOperatorId": opt_str_col(r, "updatedByOperatorId"),
        "updatedAt": iso(r, "updatedAt"),
        "createdAt": iso(r, "createdAt"),
    })
}

/// v1 `RetentionService.list` — seeds any missing default policy so a fresh
/// install shows every dial, then returns the table ordered by resource.
async fn retention_list(state: &AppState) -> ApiResult<Vec<PgRow>> {
    let known: Vec<String> = sqlx::query_scalar(r#"SELECT "resource" FROM "RetentionPolicy""#)
        .fetch_all(&state.pool)
        .await?;
    for (resource, days) in RETENTION_DEFAULTS {
        if known.iter().any(|k| k == resource) {
            continue;
        }
        // upsert with an empty `update` = insert-if-absent.
        sqlx::query(
            r#"INSERT INTO "RetentionPolicy" ("resource","keepDays","updatedAt","createdAt")
               VALUES ($1,$2,now(),now())
               ON CONFLICT ("resource") DO NOTHING"#,
        )
        .bind(resource)
        .bind(days)
        .execute(&state.pool)
        .await?;
    }
    let rows = sqlx::query(&format!(
        r#"SELECT {RETENTION_COLS} FROM "RetentionPolicy" ORDER BY "resource" ASC"#
    ))
    .fetch_all(&state.pool)
    .await?;
    Ok(rows)
}

/// GET /api/operator/retention
async fn op_retention_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let rows = retention_list(&state).await?;
    let rows: Vec<Value> = rows.iter().map(retention_json).collect();
    Ok(Json(json!(rows)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePolicyBody {
    keep_days: i64,
}

/// PATCH /api/operator/retention/:resource
async fn op_retention_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(resource): Path<String>,
    Json(body): Json<UpdatePolicyBody>,
) -> ApiResult<Json<Value>> {
    let op = require_operator(&state, &headers).await?;
    check_range("keepDays", body.keep_days, 1, 3650)?;
    // v1 throws a raw `Error` for an unknown resource → Nest renders a bare 500.
    if !RETENTION_DEFAULTS.iter().any(|(r, _)| *r == resource) {
        return Err(internal_error());
    }
    let row = sqlx::query(&format!(
        r#"INSERT INTO "RetentionPolicy"
           ("resource","keepDays","updatedByOperatorId","updatedAt","createdAt")
           VALUES ($1,$2,$3,now(),now())
           ON CONFLICT ("resource") DO UPDATE SET
             "keepDays" = EXCLUDED."keepDays",
             "updatedByOperatorId" = EXCLUDED."updatedByOperatorId",
             "updatedAt" = now()
           RETURNING {RETENTION_COLS}"#
    ))
    .bind(&resource)
    .bind(body.keep_days as i32)
    .bind(&op.id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(retention_json(&row)))
}

/// POST /api/operator/retention/sweep — `@HttpCode(200)`.
///
/// One pass over every policy: delete what has aged out, then stamp
/// `lastRunAt`/`lastRunRowsDeleted` whether or not the delete worked. A failure
/// on one resource is logged and skipped (v1 catches per-resource), so a broken
/// table can't stop the rest of the sweep.
async fn op_retention_sweep(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let policies = retention_list(&state).await?;
    let mut out = serde_json::Map::new();
    for p in &policies {
        let resource = str_col(p, "resource");
        let keep_days = i32_col(p, "keepDays") as i64;
        let cutoff = since_days(keep_days);
        let cutoff_day = cutoff.format("%Y-%m-%d").to_string();

        let res = match resource.as_str() {
            "audit_log" => Some(
                sqlx::query(
                    r#"DELETE FROM "AuditLog" WHERE "createdAt" < $1 AND "action" <> 'QUERY_RUN'::"AuditAction""#,
                )
                .bind(cutoff)
                .execute(&state.pool)
                .await,
            ),
            "query_history" => Some(
                sqlx::query(
                    r#"DELETE FROM "AuditLog" WHERE "createdAt" < $1 AND "action" = 'QUERY_RUN'::"AuditAction""#,
                )
                .bind(cutoff)
                .execute(&state.pool)
                .await,
            ),
            "ai_usage_day" => Some(
                sqlx::query(r#"DELETE FROM "AiUsageDay" WHERE "day" < $1"#)
                    .bind(&cutoff_day)
                    .execute(&state.pool)
                    .await,
            ),
            "slow_query_log" => Some(
                sqlx::query(r#"DELETE FROM "SlowQueryLog" WHERE "createdAt" < $1"#)
                    .bind(cutoff)
                    .execute(&state.pool)
                    .await,
            ),
            "abuse_event" => Some(
                sqlx::query(r#"DELETE FROM "AbuseEvent" WHERE "createdAt" < $1"#)
                    .bind(cutoff)
                    .execute(&state.pool)
                    .await,
            ),
            "feedback" => Some(
                sqlx::query(
                    r#"DELETE FROM "Feedback" WHERE "createdAt" < $1 AND "status" = 'CLOSED'::"FeedbackStatus""#,
                )
                .bind(cutoff)
                .execute(&state.pool)
                .await,
            ),
            // Unknown resource rows fall through v1's switch untouched.
            _ => None,
        };
        let deleted: i64 = match res {
            Some(Ok(r)) => r.rows_affected() as i64,
            Some(Err(e)) => {
                tracing::warn!("Retention sweep failed for {resource}: {e}");
                0
            }
            None => 0,
        };

        let _ = sqlx::query(
            r#"UPDATE "RetentionPolicy"
               SET "lastRunAt" = now(), "lastRunRowsDeleted" = $1, "updatedAt" = now()
               WHERE "resource" = $2"#,
        )
        .bind(deleted as i32)
        .bind(&resource)
        .execute(&state.pool)
        .await;

        out.insert(resource, json!(deleted));
    }
    Ok(Json(Value::Object(out)))
}
