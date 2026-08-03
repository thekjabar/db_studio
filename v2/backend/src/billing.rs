//! Organizations + customer billing + operator billing-adjustments — Rust port
//! of v1's `OrganizationsController`/`Service`
//! (`backend/src/organizations/`), `BillingController`/`BillingService` +
//! `PlanService` + `WaylClient` + `plans.ts` (`backend/src/billing/`), and
//! `BillingAdjustmentsController`/`Service` (`backend/src/billing-adjustments/`).
//!
//! This is revenue code, so it is a literal translation rather than a rewrite:
//! same paths, same guards, same HTTP status codes, same JSON field names and
//! the same error strings. Three v1-isms that are easy to get wrong and are
//! reproduced deliberately:
//!
//!   * Nest's `@Post` defaults to **201**; `@HttpCode(200)` on `addMember`,
//!     `attachWorkspace`, `verify` and the Wayl webhook makes those **200**.
//!     `@Delete` defaults to 200 (there is no 204 in these controllers).
//!   * The global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform,
//!     enableImplicitConversion })` runs BEFORE the handler, so DTO errors
//!     always precede ownership checks. `POST /billing/checkout` uses
//!     `@Body('seats')` (a primitive, no DTO class) so it gets **no** whitelist
//!     treatment — unknown body properties are accepted there.
//!   * `@Public()` marks `GET /billing/plans/public` and the Wayl webhook as
//!     unauthenticated; everything else is behind the global `JwtAuthGuard`.
//!
//! ## Entitlement — the one rule that decides paid access
//!
//! v1 `plans.ts`:
//!
//! ```ts
//! isEntitled(sub) = !!sub && sub.status !== 'SUSPENDED' && sub.periodEnd > now
//! effectiveTier(sub) = isEntitled(sub) ? sub.plan : 'FREE'
//! ```
//!
//! Reproduced verbatim in [`is_entitled`]. Note what it does **not** say:
//!   * `CANCELLED` is NOT excluded — a cancelled subscription keeps its plan
//!     until `periodEnd` (that is the product promise: "access ends at
//!     periodEnd"). Only `SUSPENDED` revokes immediately. Adding `CANCELLED`
//!     here would lock out customers who have already paid for the period.
//!   * `PAST_DUE` is NOT excluded either — but its `periodEnd` is by definition
//!     in the past, so it fails the second half anyway. `BillingLifecycleService`
//!     only relabels statuses; it never gates access.
//!   * The comparison is strict `>`. At exactly `periodEnd` the entitlement is
//!     already gone.
//!
//! `periodEnd` is `TIMESTAMP(3)` *without* time zone holding a UTC instant, so
//! "now" must be `Utc::now().naive_utc()` — comparing against a local-time
//! `NaiveDateTime` would shift every expiry by the box's UTC offset.
//!
//! ## Timestamps
//!
//! Every Prisma `DateTime` is `timestamp WITHOUT time zone`, so all reads go
//! through `chrono::NaiveDateTime`; `DateTime<Utc>` fails to decode. Money- and
//! entitlement-bearing columns (`periodEnd`, `status`, `plan`, `seats`,
//! `amountIqd`) are read with a typed `try_get` whose error is **propagated** —
//! never `.ok().flatten()`, which would silently turn a decode mistake into
//! "not entitled" (locks out payers) or a zero amount (gives away access).
//!
//! ## Money
//!
//! Everything here is a whole-integer `INTEGER` column: `amountIqd`/
//! `seatPriceIqd` (Iraqi Dinar has no minor unit) and `amountCents`. They are
//! read and written as `i32`/`i64` — never `f64` — so no value can round. The
//! only float in the file is the webhook's `total` guard, which must reproduce
//! JavaScript `Number()` semantics exactly (see [`reconcile`]).
//!
//! ## Deployment gates (fail-safe, not feature flags)
//!
//! `routes()` registers the Wayl-dependent routes only when this process has
//! the Wayl credentials, and the operator routes only when it has
//! `OPERATOR_JWT_SECRET`. v2 runs behind a strangler proxy whose fallback is the
//! v1 Node API, and v2 reads its own `.env` file. If a secret is missing here
//! but present in v1, an unconditional registration would turn a working
//! checkout into a permanent 503 and a valid Wayl webhook into a 401 — i.e. it
//! would break payments. Not registering leaves those paths proxying to v1,
//! which still has the credentials. When both processes are configured
//! identically (the intended state) the behaviour is identical either way.
//!
//! ## Not ported (and why)
//!
//! * `PlanService.onModuleInit` seeding of `PlanConfig` — v1 already seeds it on
//!   every boot (create-if-absent), and `plan_config()` below falls back to the
//!   same coded defaults per read, so a missing row behaves identically without
//!   v2 writing to the table.
//! * `BillingLifecycleService` (the daily PAST_DUE/SUSPENDED sweep) — a timer,
//!   not a route, and it must run from exactly one instance. v1 owns it. It only
//!   advances status *labels*; entitlement follows `periodEnd` directly, so
//!   nothing here depends on it having run.
//! * `PlanService.forUser`/`seatLimitForUser`/`seatLimitForWorkspace` and
//!   `BillingAdjustmentsService.pendingSumCents` — internal helpers for the AI/
//!   quota gating and the operator revenue dashboard, reachable from none of
//!   these three controllers.

use std::sync::OnceLock;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    let mut r = Router::new()
        // --- Organizations (JwtAuthGuard) ---
        .route("/api/organizations", get(org_list).post(org_create))
        .route("/api/organizations/:id", get(org_get).patch(org_update))
        .route("/api/organizations/:id/members", post(org_add_member))
        .route(
            "/api/organizations/:id/members/:memberUserId",
            axum::routing::delete(org_remove_member),
        )
        .route("/api/organizations/:id/workspaces", post(org_attach_workspace))
        .route(
            "/api/organizations/:id/workspaces/:workspaceId",
            axum::routing::delete(org_detach_workspace),
        )
        // --- Billing: public plan catalogue (@Public) ---
        .route("/api/billing/plans/public", get(public_plans));

    // --- Billing: everything that depends on Wayl credentials ---
    //
    // `GET /api/billing` is gated too, not just checkout: its `waylEnabled`
    // field is what enables the Subscribe button. Serving `false` here while v1
    // would serve `true` hides the paywall from paying customers.
    if wayl_cfg().enabled {
        r = r
            .route("/api/billing", get(overview_route))
            .route("/api/billing/checkout", post(checkout))
            .route("/api/billing/verify/:referenceId", post(verify_return))
            .route("/api/billing/wayl/webhook", post(wayl_webhook));
    }

    // --- Operator billing adjustments (OperatorGuard) ---
    //
    // Only when this process can actually verify an operator JWT. v1's
    // OPERATOR_JWT_SECRET has a committed development default that is
    // deliberately NOT reproduced here — baking a public secret into a second
    // service that verifies operator tokens would be a real privilege-escalation
    // path. No secret → the routes stay with v1.
    if operator_secret().is_some() {
        r = r.route(
            "/api/operator/workspaces/:workspaceId/adjustments",
            get(adjustments_list).post(adjustments_issue),
        );
    }
    r
}

// ---------------------------------------------------------------------------
// DTO validation — stands in for v1's global ValidationPipe
// ---------------------------------------------------------------------------
//
// v1 answers a DTO failure with `message: string[]` (every error at once).
// v2's `ApiError` carries a single string, the convention already set by
// `workspaces.rs`; the frontend renders `data.message` either way. The string
// chosen is the first error in DTO property-declaration order, which is the
// order class-validator reports in.

/// `whitelist: true, forbidNonWhitelisted: true` — any property not on the DTO
/// is a 400 before the handler runs.
fn reject_unknown(body: &Value, allowed: &[&str]) -> Result<(), ApiError> {
    if let Some(obj) = body.as_object() {
        for k in obj.keys() {
            if !allowed.contains(&k.as_str()) {
                return Err(ApiError::bad(format!("property {k} should not exist")));
            }
        }
    }
    Ok(())
}

/// `@IsString()` under `enableImplicitConversion` — class-transformer coerces a
/// JSON primitive to the declared TS type, so v1 genuinely accepts `5` as `"5"`.
fn as_string(body: &Value, field: &str) -> Option<String> {
    match body.get(field) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

/// `@IsString() @Length(min, max)`; class-validator counts UTF-16 code units,
/// and `chars()` agrees for everything outside the astral planes.
fn parse_str(body: &Value, field: &str, min: usize, max: usize) -> Result<String, ApiError> {
    let v = as_string(body, field)
        .ok_or_else(|| ApiError::bad(format!("{field} must be a string")))?;
    let len = v.chars().count();
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
    Ok(v)
}

/// `@IsOptional()` skips validation when the value is `undefined` **or** `null`.
fn is_absent(body: &Value, field: &str) -> bool {
    matches!(body.get(field), None | Some(Value::Null))
}

/// `@IsEmail()`. Approximates validator.js closely enough for real client input:
/// exactly one `@`, a non-empty local part, a dotted domain, no whitespace.
fn valid_email(raw: &str) -> bool {
    let mut parts = raw.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    parts.next().is_none()
        && !local.is_empty()
        && local.len() <= 64
        && domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !raw.chars().any(|c| c.is_whitespace())
}

fn parse_email(body: &Value, field: &str) -> Result<String, ApiError> {
    let raw = body.get(field).and_then(|v| v.as_str()).unwrap_or("");
    if !valid_email(raw) {
        return Err(ApiError::bad(format!("{field} must be an email")));
    }
    Ok(raw.to_string())
}

/// `@IsInt()` with implicit conversion: JSON numbers pass when integral, and a
/// numeric string is converted first (`"5"` → `5`).
fn parse_int(body: &Value, field: &str) -> Result<i64, ApiError> {
    let n = match body.get(field) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => Some(js_number_str(s)),
        _ => None,
    };
    match n {
        Some(v) if v.is_finite() && v.fract() == 0.0 && v.abs() <= 9.007_199_254_740_991e15 => {
            Ok(v as i64)
        }
        _ => Err(ApiError::bad(format!("{field} must be an integer number"))),
    }
}

/// `@IsBoolean()`. class-transformer's implicit conversion maps the strings
/// `"true"`/`"false"` onto booleans; anything else keeps its type and fails.
fn parse_bool(body: &Value, field: &str) -> Result<bool, ApiError> {
    match body.get(field) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) if s == "true" => Ok(true),
        Some(Value::String(s)) if s == "false" => Ok(false),
        _ => Err(ApiError::bad(format!("{field} must be a boolean value"))),
    }
}

/// `@IsEnum(Role)` — the message lists the members in declaration order,
/// exactly as class-validator builds it.
fn parse_role(body: &Value) -> Result<String, ApiError> {
    let role = body.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if !["OWNER", "EDITOR", "VIEWER"].contains(&role) {
        return Err(ApiError::bad(
            "role must be one of the following values: OWNER, EDITOR, VIEWER",
        ));
    }
    Ok(role.to_string())
}

// ---------------------------------------------------------------------------
// JavaScript semantics the port has to reproduce bit-for-bit
// ---------------------------------------------------------------------------

/// `Number(string)`: trimmed, empty → 0, otherwise a full-string numeric parse
/// (NaN when anything is left over).
fn js_number_str(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(value)` for an arbitrary JSON value: `null` → 0, booleans → 1/0,
/// numbers as-is, strings via [`js_number_str`], everything else NaN.
///
/// This is not pedantry: `checkout` funnels the request's `seats` through
/// `Math.floor(Number(seats))`, and the webhook's amount guard through
/// `Number(total)`. NaN propagating differently would either reject a valid
/// purchase or skip the amount check.
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number_str(s),
        _ => f64::NAN,
    }
}

/// Node's `Buffer.from(str, 'hex')`, which is **lenient**: it decodes leading
/// valid pairs and stops at the first non-hex character or a dangling nibble,
/// returning a short buffer rather than throwing. v1's `try/catch` around it is
/// therefore dead code, and its length check is what actually rejects malformed
/// signatures. Reproduced so the accept/reject decision is identical for every
/// input — including a valid 64-char digest with trailing junk, which Node
/// accepts (harmlessly: the 32 decoded bytes still have to equal the HMAC).
fn node_hex_decode(s: &str) -> Vec<u8> {
    fn nib(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut i = 0;
    // A dangling final nibble is dropped, exactly as Node does.
    while i + 1 < b.len() {
        match (nib(b[i]), nib(b[i + 1])) {
            (Some(hi), Some(lo)) => out.push((hi << 4) | lo),
            _ => break,
        }
        i += 2;
    }
    out
}

/// `encodeURIComponent` — everything outside `A-Za-z0-9-_.!~*'()` is
/// percent-encoded. Used on the Wayl link lookup path.
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

fn now_utc() -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc()
}

/// Read a `DateTime` column, propagating a decode error instead of nulling it.
/// `iso()` swallows errors with `.ok()`, which is fine for cosmetic columns but
/// not for anything a customer's access or invoice depends on.
fn ts(r: &PgRow, col: &str) -> ApiResult<Option<String>> {
    let v: Option<chrono::NaiveDateTime> = r
        .try_get(col)
        .map_err(|e| ApiError::internal(format!("{col}: {e}")))?;
    Ok(v.map(|d| d.and_utc().to_rfc3339()))
}

fn req_str(r: &PgRow, col: &str) -> ApiResult<String> {
    r.try_get(col)
        .map_err(|e| ApiError::internal(format!("{col}: {e}")))
}

fn req_i32(r: &PgRow, col: &str) -> ApiResult<i32> {
    r.try_get(col)
        .map_err(|e| ApiError::internal(format!("{col}: {e}")))
}

// ---------------------------------------------------------------------------
// Plan catalogue — v1 `plans.ts` + `PlanService`
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Plan {
    tier: String,
    name: String,
    seat_price_iqd: i32,
    max_connections: i32,
    ai_enabled: bool,
    daily_ai_calls: i32,
    max_scheduled_queries: i32,
    max_webhooks_per_connection: i32,
    max_seats: Option<i32>,
}

/// v1 `DEFAULT_PLANS` — the coded fallback used for any tier whose `PlanConfig`
/// row is absent. Values are whole IQD per seat / month.
fn default_plan(tier: &str) -> Plan {
    match tier {
        "PRO" => Plan {
            tier: "PRO".into(),
            name: "Pro".into(),
            seat_price_iqd: 15_000,
            max_connections: 25,
            ai_enabled: true,
            daily_ai_calls: 50,
            max_scheduled_queries: 25,
            max_webhooks_per_connection: 10,
            max_seats: Some(5),
        },
        "TEAM" => Plan {
            tier: "TEAM".into(),
            name: "Team".into(),
            seat_price_iqd: 25_000,
            max_connections: 100,
            ai_enabled: true,
            daily_ai_calls: 200,
            max_scheduled_queries: 100,
            max_webhooks_per_connection: 25,
            max_seats: None,
        },
        // FREE — the 7-day trial allowance, not a free forever tier.
        _ => Plan {
            tier: "FREE".into(),
            name: "Trial".into(),
            seat_price_iqd: 0,
            max_connections: 1,
            ai_enabled: false,
            daily_ai_calls: 0,
            max_scheduled_queries: 0,
            max_webhooks_per_connection: 0,
            max_seats: Some(1),
        },
    }
}

/// v1 `LOCKED_LIMITS` — what a workspace with no active entitlement may do:
/// nothing. Note the tier *label* stays "FREE" while every limit is zero.
fn locked_plan() -> Plan {
    Plan {
        tier: "FREE".into(),
        name: "No plan".into(),
        seat_price_iqd: 0,
        max_connections: 0,
        ai_enabled: false,
        daily_ai_calls: 0,
        max_scheduled_queries: 0,
        max_webhooks_per_connection: 0,
        max_seats: Some(1),
    }
}

const PLAN_COLS: &str = r#""tier"::text AS "tier","name","seatPriceIqd","maxConnections","aiEnabled","dailyAiCalls","maxScheduledQueries","maxWebhooksPerConnection","maxSeats""#;

fn plan_from_row(r: &PgRow) -> ApiResult<Plan> {
    Ok(Plan {
        tier: req_str(r, "tier")?,
        name: req_str(r, "name")?,
        // Prices drive what the customer is charged: a decode failure must be
        // loud, never a silent 0 (which would then trip "price is not set").
        seat_price_iqd: req_i32(r, "seatPriceIqd")?,
        max_connections: req_i32(r, "maxConnections")?,
        ai_enabled: r
            .try_get("aiEnabled")
            .map_err(|e| ApiError::internal(format!("aiEnabled: {e}")))?,
        daily_ai_calls: req_i32(r, "dailyAiCalls")?,
        max_scheduled_queries: req_i32(r, "maxScheduledQueries")?,
        max_webhooks_per_connection: req_i32(r, "maxWebhooksPerConnection")?,
        max_seats: r
            .try_get("maxSeats")
            .map_err(|e| ApiError::internal(format!("maxSeats: {e}")))?,
    })
}

/// v1 `PlanService.config(tier)`: the operator-editable DB row, else the coded
/// default.
async fn plan_config(state: &AppState, tier: &str) -> ApiResult<Plan> {
    let row = sqlx::query(&format!(
        r#"SELECT {PLAN_COLS} FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#
    ))
    .bind(tier)
    .fetch_optional(&state.pool)
    .await?;
    match row {
        Some(r) => plan_from_row(&r),
        None => Ok(default_plan(tier)),
    }
}

/// v1 `PlanService.all()` — TIER_ORDER, DB row per tier where present.
async fn plan_all(state: &AppState) -> ApiResult<Vec<Plan>> {
    let rows = sqlx::query(&format!(r#"SELECT {PLAN_COLS} FROM "PlanConfig""#))
        .fetch_all(&state.pool)
        .await?;
    let mut found: Vec<Plan> = Vec::with_capacity(rows.len());
    for r in &rows {
        found.push(plan_from_row(r)?);
    }
    Ok(["FREE", "PRO", "TEAM"]
        .iter()
        .map(|t| {
            found
                .iter()
                .find(|p| p.tier == *t)
                .cloned()
                .unwrap_or_else(|| default_plan(t))
        })
        .collect())
}

/// v1 `plans.ts` `isEntitled`. See the module header — `CANCELLED` deliberately
/// stays entitled until `periodEnd`, and the period comparison is strict.
fn is_entitled(status: &str, period_end: chrono::NaiveDateTime, now: chrono::NaiveDateTime) -> bool {
    status != "SUSPENDED" && period_end > now
}

/// A workspace's `Subscription` row, decoded strictly.
struct Sub {
    plan: String,
    status: String,
    period_start: chrono::NaiveDateTime,
    period_end: chrono::NaiveDateTime,
    seats: i32,
}

async fn load_subscription(state: &AppState, workspace_id: &str) -> ApiResult<Option<Sub>> {
    let row = sqlx::query(
        r#"SELECT "plan"::text AS "plan","status"::text AS "status","periodStart","periodEnd","seats"
           FROM "Subscription" WHERE "workspaceId" = $1"#,
    )
    .bind(workspace_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(r) = row else { return Ok(None) };
    Ok(Some(Sub {
        plan: req_str(&r, "plan")?,
        status: req_str(&r, "status")?,
        // Every one of these decides entitlement or price. `.ok()` here would
        // hand out (or withhold) paid access on a driver-level mistake.
        period_start: r
            .try_get("periodStart")
            .map_err(|e| ApiError::internal(format!("periodStart: {e}")))?,
        period_end: r
            .try_get("periodEnd")
            .map_err(|e| ApiError::internal(format!("periodEnd: {e}")))?,
        seats: req_i32(&r, "seats")?,
    }))
}

/// v1 `PlanService.forWorkspace` — effective tier, its limits, the raw
/// subscription, and whether the workspace is locked out.
async fn for_workspace(
    state: &AppState,
    workspace_id: &str,
) -> ApiResult<(String, Plan, Option<Sub>, bool)> {
    let sub = load_subscription(state, workspace_id).await?;
    let now = now_utc();
    let entitled = sub
        .as_ref()
        .map(|s| is_entitled(&s.status, s.period_end, now))
        .unwrap_or(false);
    if !entitled {
        return Ok(("FREE".to_string(), locked_plan(), sub, true));
    }
    let plan = sub.as_ref().expect("entitled implies a row").plan.clone();
    let cfg = plan_config(state, &plan).await?;
    Ok((plan, cfg, sub, false))
}

// ---------------------------------------------------------------------------
// Wayl configuration + REST client (v1 `wayl.client.ts` + AppConfigService)
// ---------------------------------------------------------------------------

struct WaylCfg {
    api_token: Option<String>,
    webhook_secret: Option<String>,
    env: String,
    api_base: String,
    webhook_url: Option<String>,
    redirection_url: Option<String>,
    /// v1: `!!(WAYL_API_TOKEN && WAYL_WEBHOOK_SECRET)`.
    enabled: bool,
}

/// v1's zod schema maps an empty string to `undefined`, so an empty env var is
/// "unset", not "set to nothing".
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn wayl_cfg() -> &'static WaylCfg {
    static CFG: OnceLock<WaylCfg> = OnceLock::new();
    CFG.get_or_init(|| {
        let api_token = env_opt("WAYL_API_TOKEN");
        let webhook_secret = env_opt("WAYL_WEBHOOK_SECRET");
        WaylCfg {
            enabled: api_token.is_some() && webhook_secret.is_some(),
            api_token,
            webhook_secret,
            // v1: z.enum(['live','test']).default('test') — an invalid value
            // fails v1's boot, so anything unexpected here is treated as unset.
            env: match env_opt("WAYL_ENV").as_deref() {
                Some("live") => "live".to_string(),
                _ => "test".to_string(),
            },
            api_base: env_opt("WAYL_API_BASE")
                .unwrap_or_else(|| "https://api.thewayl.com".to_string()),
            webhook_url: env_opt("WAYL_WEBHOOK_URL"),
            redirection_url: env_opt("WAYL_REDIRECTION_URL"),
        }
    })
}

fn wayl_webhook_url(state: &AppState) -> String {
    wayl_cfg()
        .webhook_url
        .clone()
        .unwrap_or_else(|| format!("{}/api/billing/wayl/webhook", state.app_base_url))
}

fn wayl_redirection_url(state: &AppState) -> String {
    wayl_cfg()
        .redirection_url
        .clone()
        .unwrap_or_else(|| format!("{}/billing", state.app_base_url))
}

/// v1 `WaylClient.request`. Returns the parsed body, or the exact message v1's
/// `WaylError` would carry — that string is persisted as
/// `PaymentAttempt.failureReason`, so it is part of the observable contract.
async fn wayl_request(
    state: &AppState,
    method: reqwest::Method,
    path: &str,
    body: Option<Vec<u8>>,
) -> Result<Option<Value>, String> {
    let cfg = wayl_cfg();
    let url = format!("{}{}", cfg.api_base, path);
    let mut rb = state
        .http
        .request(method, &url)
        .header(
            "X-WAYL-AUTHENTICATION",
            cfg.api_token.clone().unwrap_or_default(),
        )
        .header("Accept", "application/json");
    if let Some(b) = body {
        // reqwest is built without the `json` feature, so the body is
        // serialized by hand and content-type set explicitly.
        rb = rb.header("Content-Type", "application/json").body(b);
    }
    let res = match rb.send().await {
        Ok(r) => r,
        Err(e) => return Err(format!("Wayl request failed: {e}")),
    };
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let parsed: Option<Value> = if text.is_empty() {
        None
    } else {
        match serde_json::from_str::<Value>(&text) {
            Ok(v) => Some(v),
            Err(_) => {
                if !status.is_success() {
                    return Err(format!(
                        "Wayl returned a non-JSON error ({})",
                        status.as_u16()
                    ));
                }
                None
            }
        }
    };
    if !status.is_success() {
        // v1: `parsed?.message ?? \`Wayl request failed (${status})\``. A
        // non-string `message` would stringify oddly in JS; the default is used
        // instead so the persisted failureReason stays readable.
        let msg = parsed
            .as_ref()
            .and_then(|p| p.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Wayl request failed ({})", status.as_u16()));
        tracing::warn!("Wayl {path} -> {}: {msg}", status.as_u16());
        return Err(msg);
    }
    Ok(parsed)
}

/// v1 `WaylClient.createLink` — POST /api/v1/links.
async fn wayl_create_link(
    state: &AppState,
    reference_id: &str,
    total_iqd: i64,
    custom_parameter: &str,
    label: &str,
) -> Result<Value, String> {
    let cfg = wayl_cfg();
    let body = json!({
        "env": cfg.env,
        "referenceId": reference_id,
        "total": total_iqd,
        "currency": "IQD",
        "customParameter": custom_parameter,
        "lineItem": [{ "label": label, "amount": total_iqd, "type": "increase" }],
        "webhookUrl": wayl_webhook_url(state),
        // The shared secret Wayl will sign its webhook with. Same value we
        // verify against below — that is the whole trust anchor.
        "webhookSecret": cfg.webhook_secret.clone().unwrap_or_default(),
        "redirectionUrl": wayl_redirection_url(state),
    });
    let bytes = serde_json::to_vec(&body).map_err(|e| format!("Wayl request failed: {e}"))?;
    let res = wayl_request(state, reqwest::Method::POST, "/api/v1/links", Some(bytes)).await?;
    Ok(unwrap_data(res))
}

/// v1 `WaylClient.getLink` — GET /api/v1/links/{ref}. Wayl resolves this by our
/// merchant `referenceId` only; passing the internal link id 404s.
async fn wayl_get_link(state: &AppState, id_or_reference: &str) -> Result<Value, String> {
    let path = format!(
        "/api/v1/links/{}",
        encode_uri_component(id_or_reference)
    );
    let res = wayl_request(state, reqwest::Method::GET, &path, None).await?;
    Ok(unwrap_data(res))
}

/// v1: `(res?.data ?? res) as WaylLink`.
fn unwrap_data(res: Option<Value>) -> Value {
    match res {
        Some(v) => match v.get("data") {
            Some(d) if !d.is_null() => d.clone(),
            _ => v,
        },
        None => Value::Null,
    }
}

/// v1 `WaylClient.verifySignature`, exactly:
///
/// > HMAC-SHA256 over the raw body, keyed with `WAYL_WEBHOOK_SECRET`,
/// > hex-encoded, constant-time compared against `x-wayl-signature-256`.
///
/// Every detail is load-bearing and is reproduced rather than "improved":
///   * the digest is over the **raw request bytes** — re-serializing the parsed
///     JSON would change whitespace/key order and never match;
///   * a missing secret or missing header is `false` (v1's falsy check, so an
///     empty string counts as missing);
///   * the header is trimmed and hex-decoded with Node's lenient decoder, then
///     length-checked before the compare;
///   * the compare is constant-time (`crate::ct_eq`, the same primitive the JWT
///     path uses) so the signature can't be recovered byte-by-byte by timing.
fn verify_wayl_signature(raw: &[u8], signature: Option<&str>) -> bool {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let Some(secret) = wayl_cfg().webhook_secret.as_deref() else {
        return false;
    };
    if secret.is_empty() {
        return false;
    }
    let Some(sig) = signature.filter(|s| !s.is_empty()) else {
        return false;
    };

    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("hmac accepts any key length");
    mac.update(raw);
    // v1 hex-encodes the digest and immediately decodes it back into a Buffer,
    // which is bit-identical to the digest itself.
    let expected = mac.finalize().into_bytes();
    let received = node_hex_decode(sig.trim());
    if expected.len() != received.len() {
        return false;
    }
    crate::ct_eq(&expected, &received)
}

// ---------------------------------------------------------------------------
// Workspace resolution + seat counting (v1 BillingService privates)
// ---------------------------------------------------------------------------

struct Ws {
    id: String,
    name: String,
    is_personal: bool,
    owner_id: String,
}

fn ws_from_row(r: &PgRow) -> ApiResult<Ws> {
    Ok(Ws {
        id: req_str(r, "id")?,
        name: req_str(r, "name")?,
        is_personal: r
            .try_get("isPersonal")
            .map_err(|e| ApiError::internal(format!("isPersonal: {e}")))?,
        // Ownership decides who may spend money on this workspace.
        owner_id: req_str(r, "ownerId")?,
    })
}

/// v1 `BillingService.resolveWorkspace`. Membership is required to *view*;
/// ownership is checked separately by the mutating routes.
async fn resolve_workspace(
    state: &AppState,
    user_id: &str,
    workspace_id: Option<&str>,
) -> ApiResult<Ws> {
    const COLS: &str = r#""id","name","isPersonal","ownerId""#;
    if let Some(wid) = workspace_id.filter(|w| !w.is_empty()) {
        let row = sqlx::query(&format!(
            r#"SELECT {COLS} FROM "Workspace" WHERE "id" = $1"#
        ))
        .bind(wid)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Workspace not found"))?;
        let ws = ws_from_row(&row)?;
        if ws.owner_id != user_id {
            let member: Option<String> = sqlx::query_scalar(
                r#"SELECT "id" FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2"#,
            )
            .bind(&ws.id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
            if member.is_none() {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "Not a member of this workspace.",
                ));
            }
        }
        return Ok(ws);
    }
    // Prisma emits no ORDER BY for the personal lookup (there is at most one);
    // the explicit order only makes a pathological duplicate deterministic.
    let personal = sqlx::query(&format!(
        r#"SELECT {COLS} FROM "Workspace" WHERE "ownerId" = $1 AND "isPersonal" = true
           ORDER BY "createdAt" ASC, "id" ASC LIMIT 1"#
    ))
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(r) = personal {
        return ws_from_row(&r);
    }
    let owned = sqlx::query(&format!(
        r#"SELECT {COLS} FROM "Workspace" WHERE "ownerId" = $1
           ORDER BY "createdAt" ASC, "id" ASC LIMIT 1"#
    ))
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "No workspace found for this user."))?;
    ws_from_row(&owned)
}

/// v1 `BillingService.minSeatsForOwner`: the largest `members + invites` count
/// across every connection the user owns, minimum 1. A connection may hold up
/// to `seats` members, so buying fewer seats than one already uses would strand
/// it — hence this is a floor on the purchasable seat count.
///
/// `_count: { invites: true }` counts **every** ConnectionInvite row regardless
/// of status (PENDING/ACCEPTED/REVOKED); narrowing it to PENDING would quietly
/// lower the floor and let a downgrade strand a connection.
async fn min_seats_for_owner(state: &AppState, user_id: &str) -> ApiResult<i64> {
    let max: Option<i64> = sqlx::query_scalar(
        r#"SELECT MAX(
               (SELECT count(*) FROM "ConnectionMember" m WHERE m."connectionId" = c."id")
             + (SELECT count(*) FROM "ConnectionInvite" i WHERE i."connectionId" = c."id")
           )
           FROM "Connection" c WHERE c."ownerId" = $1"#,
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(max.unwrap_or(1).max(1))
}

// ---------------------------------------------------------------------------
// GET /api/billing/plans/public   (@Public)
// ---------------------------------------------------------------------------

/// v1 `BillingService.publicPlans` — the operator-editable catalogue the
/// marketing pricing section reads, already in FREE → PRO → TEAM order.
async fn public_plans(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let plans = plan_all(&state).await?;
    let out: Vec<Value> = plans
        .iter()
        .map(|p| {
            json!({
                "tier": p.tier,
                "name": p.name,
                "seatPriceIqd": p.seat_price_iqd,
                "maxConnections": p.max_connections,
                "aiEnabled": p.ai_enabled,
                "dailyAiCalls": p.daily_ai_calls,
                "maxScheduledQueries": p.max_scheduled_queries,
                "maxWebhooksPerConnection": p.max_webhooks_per_connection,
                "maxSeats": p.max_seats,
            })
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

// ---------------------------------------------------------------------------
// GET /api/billing
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct OverviewQ {
    #[serde(default)]
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn overview_route(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<OverviewQ>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        overview(&state, &user.id, q.workspace_id.as_deref()).await?,
    ))
}

/// v1 `BillingService.overview` — everything the per-seat billing page needs in
/// one call.
async fn overview(
    state: &AppState,
    user_id: &str,
    workspace_id: Option<&str>,
) -> ApiResult<Value> {
    let ws = resolve_workspace(state, user_id, workspace_id).await?;
    let (tier, _cfg, subscription, locked) = for_workspace(state, &ws.id).await?;
    let paid = plan_config(state, "PRO").await?; // the single dynamic paid plan
    let free = plan_config(state, "FREE").await?;

    let now = now_utc();
    // Whole days left in an ACTIVE trial. v1 reads the raw subscription status,
    // so a lapsed trial (periodEnd <= now) yields 0 even though its status is
    // still TRIALING until the lifecycle sweep relabels it.
    let trial_days_left = match subscription.as_ref() {
        Some(s) if s.status == "TRIALING" && s.period_end > now => {
            let ms = (s.period_end - now).num_milliseconds();
            // Math.ceil over a positive millisecond delta.
            (ms as f64 / 86_400_000.0).ceil() as i64
        }
        _ => 0,
    };

    // Seats are only meaningful while entitled AND on a paid tier.
    let entitled_paid = !locked && (tier == "PRO" || tier == "TEAM");
    let current_seats = if entitled_paid {
        subscription.as_ref().map(|s| s.seats).unwrap_or(0)
    } else {
        0
    };
    let unlimited = entitled_paid && tier == "TEAM";
    let min_seats = min_seats_for_owner(state, &ws.owner_id).await?;

    let limits = |p: &Plan| {
        json!({
            "maxConnections": p.max_connections,
            "aiEnabled": p.ai_enabled,
            "dailyAiCalls": p.daily_ai_calls,
            "maxScheduledQueries": p.max_scheduled_queries,
            "maxWebhooksPerConnection": p.max_webhooks_per_connection,
        })
    };
    let merge = |head: Value, tail: Value| {
        let mut o = head;
        if let (Some(a), Some(b)) = (o.as_object_mut(), tail.as_object()) {
            for (k, v) in b {
                a.insert(k.clone(), v.clone());
            }
        }
        o
    };

    let rows = sqlx::query(
        r#"SELECT "id","plan"::text AS "plan","seats","amountIqd","status"::text AS "status","createdAt","paidAt"
           FROM "PaymentAttempt" WHERE "workspaceId" = $1
           ORDER BY "createdAt" DESC, "id" DESC LIMIT 5"#,
    )
    .bind(&ws.id)
    .fetch_all(&state.pool)
    .await?;
    let mut recent = Vec::with_capacity(rows.len());
    for r in &rows {
        recent.push(json!({
            "id": req_str(r, "id")?,
            "plan": req_str(r, "plan")?,
            "seats": req_i32(r, "seats")?,
            "amountIqd": req_i32(r, "amountIqd")?,
            "status": req_str(r, "status")?,
            "createdAt": ts(r, "createdAt")?,
            "paidAt": ts(r, "paidAt")?,
        }));
    }

    Ok(json!({
        "waylEnabled": wayl_cfg().enabled,
        "currency": "IQD",
        "workspace": { "id": ws.id, "name": ws.name, "isPersonal": ws.is_personal },
        "isOwner": ws.owner_id == user_id,
        "effectiveTier": tier,
        "locked": locked,
        "trialDaysLeft": trial_days_left,
        "perSeatPriceIqd": paid.seat_price_iqd,
        "currentSeats": current_seats,
        "unlimited": unlimited,
        "minSeats": min_seats,
        "freePlan": merge(
            json!({ "name": free.name, "maxSeats": free.max_seats.unwrap_or(1) }),
            limits(&free),
        ),
        "paidPlan": merge(json!({ "name": paid.name }), limits(&paid)),
        "subscription": match subscription.as_ref() {
            Some(s) => json!({
                "plan": s.plan,
                "seats": s.seats,
                "status": s.status,
                "periodStart": s.period_start.and_utc().to_rfc3339(),
                "periodEnd": s.period_end.and_utc().to_rfc3339(),
            }),
            None => Value::Null,
        },
        "recentPayments": recent,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout
// ---------------------------------------------------------------------------

/// v1 `BillingController.checkout` + `BillingService.checkout`.
///
/// The controller validates `seats` BEFORE the service runs, so a bad seat
/// count is a 400 even when Wayl is disabled (which would otherwise 503). That
/// ordering is preserved.
///
/// `@Body('seats')`/`@Body('workspaceId')` are primitive extractions with no DTO
/// class, so `forbidNonWhitelisted` does not apply — unknown body properties
/// are accepted here, unlike every other route in this file.
async fn checkout(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // --- controller-level guard ---
    let seats_f = js_number(body.get("seats").unwrap_or(&Value::Null)).floor();
    if !seats_f.is_finite() || seats_f < 1.0 {
        return Err(ApiError::bad("Choose at least 1 seat."));
    }
    let workspace_id = body
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // --- service ---
    if !wayl_cfg().enabled {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Online payment isn't configured yet. Please try again later.",
        ));
    }
    let ws = resolve_workspace(&state, &user.id, workspace_id.as_deref()).await?;
    if ws.owner_id != user.id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the workspace owner can manage billing.",
        ));
    }

    let plan = "PRO"; // the single dynamic paid plan
    let config = plan_config(&state, plan).await?;

    // The service re-runs the same seat validation; both checks are identical,
    // so the first one has already decided.
    let seats_int = seats_f as i64;
    if seats_int > 1000 {
        return Err(ApiError::bad(
            "That is more seats than we can process at once — contact us.",
        ));
    }
    let min_seats = min_seats_for_owner(&state, &user.id).await?;
    if seats_int < min_seats {
        return Err(ApiError::bad(format!(
            "You already use {min_seats} seat(s) on your connections; choose at least {min_seats}."
        )));
    }

    // i64 so the multiply cannot wrap; the column is INTEGER, so a product that
    // does not fit is rejected before it can be truncated into a wrong charge.
    let amount_iqd: i64 = config.seat_price_iqd as i64 * seats_int;
    if amount_iqd <= 0 {
        return Err(ApiError::bad("Per-seat price is not set. Contact support."));
    }
    let amount_i32 = i32::try_from(amount_iqd)
        .map_err(|_| ApiError::internal("Amount exceeds the supported range."))?;
    let seats_i32 = seats_int as i32; // <= 1000 by the guard above

    // v1: `QS-${ws.id.slice(0,8)}-${randomBytes(4).toString('hex')}`. cuids are
    // ASCII, so taking 8 chars matches JS's 8 UTF-16 code units exactly (and
    // cannot panic on a char boundary the way a byte slice could).
    let reference_id = format!(
        "QS-{}-{}",
        ws.id.chars().take(8).collect::<String>(),
        rand_hex_4()
    );

    // Record the attempt FIRST so there is always an audit row, even if the
    // Wayl call or a later step fails.
    let attempt_id = gen_id();
    sqlx::query(
        r#"INSERT INTO "PaymentAttempt"
             ("id","workspaceId","userId","referenceId","provider","status","plan","seats","amountIqd","months","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,'wayl','PENDING'::"PaymentAttemptStatus",$5::"PlanTier",$6,$7,1,now(),now())"#,
    )
    .bind(&attempt_id)
    .bind(&ws.id)
    .bind(&user.id)
    .bind(&reference_id)
    .bind(plan)
    .bind(seats_i32)
    .bind(amount_i32)
    .execute(&state.pool)
    .await?;

    let label = format!(
        "Query Schema — {} seat(s) × {} IQD/mo",
        seats_int, config.seat_price_iqd
    );
    let custom = format!("sub:{}:{}", ws.id, plan);
    match wayl_create_link(&state, &reference_id, amount_iqd, &custom, &label).await {
        Ok(link) => {
            let provider_ref = link.get("id").and_then(|v| v.as_str()).map(|s| s.to_string());
            sqlx::query(
                r#"UPDATE "PaymentAttempt" SET "providerRef" = $1, "rawResponse" = $2::jsonb, "updatedAt" = now()
                   WHERE "id" = $3"#,
            )
            .bind(&provider_ref)
            .bind(&link)
            .bind(&attempt_id)
            .execute(&state.pool)
            .await?;
            Ok((
                // Nest's @Post default status — there is no @HttpCode here.
                StatusCode::CREATED,
                Json(json!({
                    "url": link.get("url").cloned().unwrap_or(Value::Null),
                    "referenceId": reference_id,
                    "amountIqd": amount_iqd,
                    "seats": seats_int,
                    "plan": plan,
                })),
            ))
        }
        Err(msg) => {
            let reason: String = msg.chars().take(300).collect();
            let _ = sqlx::query(
                r#"UPDATE "PaymentAttempt" SET "status" = 'FAILED'::"PaymentAttemptStatus",
                       "failureReason" = $1, "updatedAt" = now() WHERE "id" = $2"#,
            )
            .bind(&reason)
            .bind(&attempt_id)
            .execute(&state.pool)
            .await;
            tracing::error!("Wayl checkout failed for {reference_id}: {msg}");
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Could not start the payment. Please try again in a moment.",
            ))
        }
    }
}

/// `randomBytes(4).toString('hex')`.
fn rand_hex_4() -> String {
    use rand::RngCore;
    let mut b = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------------------------------------------------------------------------
// POST /api/billing/verify/:referenceId   (@HttpCode(200))
// ---------------------------------------------------------------------------

/// v1 `BillingService.verifyReturn` — the fallback trust path used when the
/// customer returns from Wayl. The status is re-fetched from Wayl (the client
/// cannot lie about it) and reconciled through the same idempotent routine as
/// the webhook.
async fn verify_return(
    State(state): State<AppState>,
    user: AuthUser,
    Path(reference_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let attempt = sqlx::query(
        r#"SELECT "id","workspaceId","status"::text AS "status" FROM "PaymentAttempt" WHERE "referenceId" = $1"#,
    )
    .bind(&reference_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Payment not found"))?;
    let attempt_id = req_str(&attempt, "id")?;
    let attempt_ws = req_str(&attempt, "workspaceId")?;
    let attempt_status = req_str(&attempt, "status")?;

    let owner: Option<String> =
        sqlx::query_scalar(r#"SELECT "ownerId" FROM "Workspace" WHERE "id" = $1"#)
            .bind(&attempt_ws)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    if owner.as_deref() != Some(user.id.as_str()) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Not your payment."));
    }

    if attempt_status == "PENDING" && wayl_cfg().enabled {
        // Wayl's GET /links/{ref} resolves ONLY by our merchant referenceId,
        // not by the internal link id — passing providerRef 404s.
        match wayl_get_link(&state, &reference_id).await {
            Ok(link) => {
                let status = link
                    .get("status")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                // v1 passes `Number(link.total)`, so a MISSING total becomes NaN
                // (not undefined) and therefore trips the amount guard instead of
                // skipping it. `Some(NaN)` reproduces that — see `reconcile`.
                let total = Some(js_number(link.get("total").unwrap_or(&Value::Null)));
                reconcile(&state, &attempt_id, status.as_deref(), total, &link).await?;
            }
            Err(msg) => {
                tracing::warn!("verifyReturn getLink failed for {reference_id}: {msg}");
            }
        }
    }

    let fresh = sqlx::query(
        r#"SELECT "status"::text AS "status","plan"::text AS "plan","failureReason"
           FROM "PaymentAttempt" WHERE "referenceId" = $1"#,
    )
    .bind(&reference_id)
    .fetch_optional(&state.pool)
    .await?;
    let payment = match fresh.as_ref() {
        Some(r) => json!({
            "status": req_str(r, "status")?,
            "plan": req_str(r, "plan")?,
            "failureReason": r.try_get::<Option<String>, _>("failureReason")
                .map_err(|e| ApiError::internal(format!("failureReason: {e}")))?,
        }),
        None => Value::Null,
    };

    // v1 returns `{ payment, ...overview }` — `payment` first, then the overview
    // keys (which contain no `payment`, so nothing is shadowed).
    let mut out = json!({ "payment": payment });
    let ov = overview(&state, &user.id, Some(&attempt_ws)).await?;
    if let (Some(o), Some(b)) = (out.as_object_mut(), ov.as_object()) {
        for (k, v) in b {
            o.insert(k.clone(), v.clone());
        }
    }
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// POST /api/billing/wayl/webhook   (@Public, @HttpCode(200))
// ---------------------------------------------------------------------------

/// Wayl → us. Public; the only trust anchor is the HMAC over the raw body, so
/// the handler takes `Bytes` (never a parsed `Json<Value>`) — v1 is explicit
/// that a re-serialized body can never reproduce the signature.
async fn wayl_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    raw: axum::body::Bytes,
) -> ApiResult<Json<Value>> {
    let signature = headers
        .get("x-wayl-signature-256")
        .and_then(|v| v.to_str().ok());
    if !verify_wayl_signature(&raw, signature) {
        // Log without the body so "Wayl never called" can be told apart from
        // "Wayl called and the signature didn't match" when debugging payments.
        tracing::warn!(
            "Wayl webhook rejected: {} ({} bytes)",
            if signature.is_some() { "signature mismatch" } else { "missing signature" },
            raw.len()
        );
        return Err(ApiError::unauthorized("Invalid signature"));
    }

    let payload: Value = serde_json::from_slice(&raw)
        .map_err(|_| ApiError::bad("Invalid JSON body"))?;

    // v1: `!payload?.id && !payload?.referenceId` — a JS falsy check, so an
    // empty string counts as absent, and a non-object body (or `null`) fails.
    let truthy_str = |k: &str| {
        payload
            .get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    let link_id = truthy_str("id");
    let ref_id = truthy_str("referenceId");
    if link_id.is_none() && ref_id.is_none() {
        return Err(ApiError::bad("Missing payment reference"));
    }

    // Prisma `findFirst` emits no ORDER BY; `providerRef` is indexed but not
    // unique. Each checkout mints a fresh Wayl link, so a duplicate should not
    // exist — the explicit order just makes the pathological case deterministic
    // and matches the insertion order Postgres would usually return.
    let attempt = if let Some(id) = link_id.as_ref() {
        sqlx::query(
            r#"SELECT "id" FROM "PaymentAttempt" WHERE "providerRef" = $1 AND "provider" = 'wayl'
               ORDER BY "createdAt" ASC, "id" ASC LIMIT 1"#,
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
    } else {
        sqlx::query(
            r#"SELECT "id" FROM "PaymentAttempt" WHERE "referenceId" = $1 AND "provider" = 'wayl'
               ORDER BY "createdAt" ASC, "id" ASC LIMIT 1"#,
        )
        .bind(ref_id.as_ref().expect("one of the two is present"))
        .fetch_optional(&state.pool)
        .await?
    };
    let Some(attempt) = attempt else {
        tracing::warn!(
            "Wayl webhook for unknown ref {}; ignoring.",
            link_id.or(ref_id).unwrap_or_default()
        );
        return Ok(Json(json!({ "received": true })));
    };
    let attempt_id = req_str(&attempt, "id")?;

    let status = payload
        .get("paymentStatus")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    // The webhook passes `payload.total` RAW. A missing/null `total` is JS
    // `undefined`, which makes v1's `totalIqd != null` guard skip the amount
    // check entirely — so `None` here means "no amount check", exactly as in v1.
    let total = match payload.get("total") {
        None | Some(Value::Null) => None,
        Some(v) => Some(js_number(v)),
    };

    reconcile(&state, &attempt_id, status.as_deref(), total, &payload).await?;
    Ok(Json(json!({ "received": true })))
}

// ---------------------------------------------------------------------------
// reconcile — the single money-granting routine (v1 BillingService.reconcile)
// ---------------------------------------------------------------------------

/// Wayl statuses that mean the money arrived / definitively didn't.
const PAID_STATUSES: [&str; 2] = ["Complete", "Delivered"];
const FAILED_STATUSES: [&str; 3] = ["Cancelled", "Rejected", "Returned"];
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Idempotent reconcile shared by the webhook and verify-on-return. Runs in one
/// transaction: marks the attempt paid/failed and, on payment, extends the
/// workspace subscription by one monthly period on the target tier.
///
/// Idempotency (v1's guard, hardened): an attempt that is no longer `PENDING`
/// only has its stored payload refreshed — the plan is never granted twice for
/// one payment. v1 relies on Prisma's default READ COMMITTED, where two
/// simultaneous deliveries of the same webhook can both read `PENDING` and both
/// grant a period. The `FOR UPDATE` below closes that window; it changes nothing
/// for sequential calls.
///
/// `total` models JS `number | undefined`: `None` = the value was absent/null so
/// v1's `totalIqd != null` guard is skipped, `Some(x)` = the guard runs. `NaN`
/// is a legitimate `Some` (see `verify_return`) and, like in JS, compares
/// unequal to everything, so it blocks the grant.
async fn reconcile(
    state: &AppState,
    attempt_id: &str,
    wayl_status: Option<&str>,
    total: Option<f64>,
    raw: &Value,
) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;

    let fresh = sqlx::query(
        r#"SELECT "id","workspaceId","referenceId","status"::text AS "status","plan"::text AS "plan",
                  "seats","amountIqd","months"
           FROM "PaymentAttempt" WHERE "id" = $1 FOR UPDATE"#,
    )
    .bind(attempt_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(fresh) = fresh else {
        return Ok(());
    };
    let f_status = req_str(&fresh, "status")?;
    let f_ws = req_str(&fresh, "workspaceId")?;
    let f_ref = req_str(&fresh, "referenceId")?;
    let f_plan = req_str(&fresh, "plan")?;
    let f_seats = req_i32(&fresh, "seats")?;
    let f_amount = req_i32(&fresh, "amountIqd")?;
    let f_months = req_i32(&fresh, "months")?;

    // Already terminal — just refresh the stored payload and stop.
    if f_status != "PENDING" {
        sqlx::query(
            r#"UPDATE "PaymentAttempt" SET "rawResponse" = $1::jsonb, "updatedAt" = now() WHERE "id" = $2"#,
        )
        .bind(raw)
        .bind(attempt_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(());
    }

    let status = wayl_status.unwrap_or("");
    if PAID_STATUSES.contains(&status) {
        // Amount guard: never grant access if the charged total doesn't match
        // what we recorded at checkout. v1 returns here WITHOUT writing
        // anything — the attempt stays PENDING and rawResponse is untouched —
        // so the mismatch can be investigated and later reconciled.
        if let Some(t) = total {
            if t != f_amount as f64 {
                tracing::error!(
                    "Amount mismatch on {f_ref}: charged {t} vs expected {f_amount}; not granting."
                );
                return Ok(());
            }
        }
        let now = now_utc();
        sqlx::query(
            r#"UPDATE "PaymentAttempt" SET "status" = 'PAID'::"PaymentAttemptStatus",
                   "paidAt" = $1, "rawResponse" = $2::jsonb, "updatedAt" = now() WHERE "id" = $3"#,
        )
        .bind(now)
        .bind(raw)
        .bind(attempt_id)
        .execute(&mut *tx)
        .await?;

        // Stack a renewal on top of an unexpired period instead of truncating
        // it: base = max(existing.periodEnd, now).
        let existing_end: Option<chrono::NaiveDateTime> = sqlx::query(
            r#"SELECT "periodEnd" FROM "Subscription" WHERE "workspaceId" = $1 FOR UPDATE"#,
        )
        .bind(&f_ws)
        .fetch_optional(&mut *tx)
        .await?
        .map(|r| {
            r.try_get::<chrono::NaiveDateTime, _>("periodEnd")
                .map_err(|e| ApiError::internal(format!("periodEnd: {e}")))
        })
        .transpose()?;
        let base = match existing_end {
            Some(e) if e > now => e,
            _ => now,
        };
        let period_end = base + chrono::Duration::milliseconds(f_months as i64 * 30 * DAY_MS);

        // Prisma upsert on the @unique workspaceId. `periodStart` is set only on
        // create — a renewal keeps the original start, exactly as v1 does.
        sqlx::query(
            r#"INSERT INTO "Subscription"
                 ("id","workspaceId","plan","status","periodStart","periodEnd","seats","createdAt","updatedAt")
               VALUES ($1,$2,$3::"PlanTier",'ACTIVE'::"SubscriptionStatus",$4,$5,$6,now(),now())
               ON CONFLICT ("workspaceId") DO UPDATE SET
                 "plan" = EXCLUDED."plan",
                 "seats" = EXCLUDED."seats",
                 "status" = 'ACTIVE'::"SubscriptionStatus",
                 "periodEnd" = EXCLUDED."periodEnd",
                 "updatedAt" = now()"#,
        )
        .bind(gen_id())
        .bind(&f_ws)
        .bind(&f_plan)
        .bind(now)
        .bind(period_end)
        .bind(f_seats)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        tracing::info!(
            "Payment {f_ref} settled → workspace {f_ws} on {f_plan} × {f_seats} seat(s) until {}",
            period_end.and_utc().to_rfc3339()
        );
        return Ok(());
    }

    if FAILED_STATUSES.contains(&status) {
        sqlx::query(
            r#"UPDATE "PaymentAttempt" SET "status" = 'FAILED'::"PaymentAttemptStatus",
                   "failureReason" = $1, "rawResponse" = $2::jsonb, "updatedAt" = now() WHERE "id" = $3"#,
        )
        .bind(status)
        .bind(raw)
        .bind(attempt_id)
        .execute(&mut *tx)
        .await?;
    } else {
        // Non-terminal (Created/Pending/Processing): store the payload, stay PENDING.
        sqlx::query(
            r#"UPDATE "PaymentAttempt" SET "rawResponse" = $1::jsonb, "updatedAt" = now() WHERE "id" = $2"#,
        )
        .bind(raw)
        .bind(attempt_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

/// Every `Organization` scalar Prisma returns when no `select` narrows it.
const ORG_COLS: &str =
    r#""id","name","slug","ownerId","billingEmail","enforceSso","seatLimit","createdAt","updatedAt""#;

fn org_json(r: &PgRow, with_updated_at: bool) -> ApiResult<Value> {
    let mut o = json!({
        "id": req_str(r, "id")?,
        "name": req_str(r, "name")?,
        "slug": req_str(r, "slug")?,
        "ownerId": req_str(r, "ownerId")?,
        "billingEmail": r.try_get::<Option<String>, _>("billingEmail")
            .map_err(|e| ApiError::internal(format!("billingEmail: {e}")))?,
        // Drives whether password/OAuth login is refused for members — a
        // security decision, so a decode error must not become `false`.
        "enforceSso": r.try_get::<bool, _>("enforceSso")
            .map_err(|e| ApiError::internal(format!("enforceSso: {e}")))?,
        "seatLimit": r.try_get::<Option<i32>, _>("seatLimit")
            .map_err(|e| ApiError::internal(format!("seatLimit: {e}")))?,
        "createdAt": iso(r, "createdAt"),
    });
    if with_updated_at {
        o["updatedAt"] = json!(iso(r, "updatedAt"));
    }
    Ok(o)
}

/// v1 `assertOwner`: the org owner, or a member holding the OWNER role.
/// Returns the org's `ownerId`, which `removeMember` needs.
async fn assert_org_owner(state: &AppState, user_id: &str, org_id: &str) -> ApiResult<String> {
    let owner: Option<String> =
        sqlx::query_scalar(r#"SELECT "ownerId" FROM "Organization" WHERE "id" = $1"#)
            .bind(org_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    // Bare NotFoundException → Nest's default 404 body.
    let owner = owner.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    if owner != user_id {
        let role: Option<String> = sqlx::query_scalar(
            r#"SELECT "role"::text FROM "OrganizationMember"
               WHERE "organizationId" = $1 AND "userId" = $2"#,
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
        if role.as_deref() != Some("OWNER") {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Organization owner access required",
            ));
        }
    }
    Ok(owner)
}

// --- GET /api/organizations ------------------------------------------------

/// v1 `OrganizationsService.list` — orgs the user owns or belongs to, with
/// Prisma's `_count` block for members and workspaces.
async fn org_list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT o."id",o."name",o."slug",o."ownerId",o."billingEmail",o."enforceSso",o."seatLimit",o."createdAt",
                  (SELECT count(*) FROM "OrganizationMember" m WHERE m."organizationId" = o."id") AS "memberCount",
                  (SELECT count(*) FROM "Workspace" w WHERE w."organizationId" = o."id") AS "workspaceCount"
           FROM "Organization" o
           WHERE o."ownerId" = $1
              OR EXISTS (SELECT 1 FROM "OrganizationMember" m2
                         WHERE m2."organizationId" = o."id" AND m2."userId" = $1)
           ORDER BY o."createdAt" ASC, o."id" ASC"#,
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        // `select` omits updatedAt here, so the DTO must too.
        let mut o = org_json(r, false)?;
        o["_count"] = json!({
            "members": r.try_get::<i64, _>("memberCount").unwrap_or(0),
            "workspaces": r.try_get::<i64, _>("workspaceCount").unwrap_or(0),
        });
        out.push(o);
    }
    Ok(Json(Value::Array(out)))
}

// --- POST /api/organizations -----------------------------------------------

/// v1 `SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/` — 1 to 40 chars,
/// lowercase alphanumeric at both ends, hyphens only in between.
fn slug_ok(s: &str) -> bool {
    let b = s.as_bytes();
    let alnum = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    match b.len() {
        1 => alnum(b[0]),
        2..=40 => {
            alnum(b[0])
                && alnum(b[b.len() - 1])
                && b[1..b.len() - 1]
                    .iter()
                    .all(|&c| alnum(c) || c == b'-')
        }
        _ => false,
    }
}

async fn org_create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    reject_unknown(&body, &["name", "slug", "billingEmail"])?;
    let name = parse_str(&body, "name", 1, 120)?;
    let slug_in = parse_str(&body, "slug", 1, 40)?;
    let billing_email = if is_absent(&body, "billingEmail") {
        None
    } else {
        Some(parse_email(&body, "billingEmail")?)
    };

    // The service re-checks after the DTO: `!input.name.trim()` rejects a
    // whitespace-only name that @Length(1,120) already accepted.
    if name.trim().is_empty() || name.chars().count() > 120 {
        return Err(ApiError::bad("Name required (max 120 chars)"));
    }
    let slug = slug_in.trim().to_lowercase();
    if !slug_ok(&slug) {
        return Err(ApiError::bad(
            "Slug: 1-40 lowercase letters/digits/hyphens",
        ));
    }
    // Checked explicitly so the unique-constraint violation becomes a friendly
    // 400 rather than a 500. The INSERT below is still the real arbiter of a
    // race between two concurrent creates.
    let taken: Option<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Organization" WHERE "slug" = $1"#)
            .bind(&slug)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    if taken.is_some() {
        return Err(ApiError::bad("Slug is already taken"));
    }

    // v1 runs both writes in one Prisma transaction; without it an org could
    // exist with no OWNER membership row.
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(&format!(
        r#"INSERT INTO "Organization" ("id","name","slug","ownerId","billingEmail","enforceSso","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,false,now(),now()) RETURNING {ORG_COLS}"#
    ))
    // Prisma's @default(cuid()) is generated client-side — the column has no
    // DB default, so the id must be supplied.
    .bind(gen_id())
    .bind(name.trim())
    .bind(&slug)
    .bind(&user.id)
    .bind(
        billing_email
            .as_deref()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty()),
    )
    .fetch_one(&mut *tx)
    .await?;
    let org_id = req_str(&row, "id")?;
    sqlx::query(
        r#"INSERT INTO "OrganizationMember" ("id","organizationId","userId","role","createdAt")
           VALUES ($1,$2,$3,'OWNER'::"Role",now())"#,
    )
    .bind(gen_id())
    .bind(&org_id)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // Prisma's create returns scalars only; Nest's @Post → 201.
    Ok((StatusCode::CREATED, Json(org_json(&row, true)?)))
}

// --- GET /api/organizations/:id --------------------------------------------

async fn org_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(&format!(
        r#"SELECT {ORG_COLS} FROM "Organization" WHERE "id" = $1"#
    ))
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let owner_id = req_str(&row, "ownerId")?;

    let members = sqlx::query(
        r#"SELECT m."id",m."organizationId",m."userId",m."role"::text AS "role",m."createdAt",
                  u."id" AS "u_id",u."email" AS "u_email",u."displayName" AS "u_displayName"
           FROM "OrganizationMember" m
           JOIN "User" u ON u."id" = m."userId"
           WHERE m."organizationId" = $1
           ORDER BY m."createdAt" ASC, m."id" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    // v1 derives access from the already-loaded member list, so a non-member
    // gets 403 only AFTER the 404 check. The ids are decoded with the error
    // propagated: a swallowed decode would read as "not a member" and lock a
    // legitimate member out of their own organization.
    let mut member_ids = Vec::with_capacity(members.len());
    for m in &members {
        member_ids.push(req_str(m, "userId")?);
    }
    let is_member = owner_id == user.id || member_ids.iter().any(|u| *u == user.id);
    if !is_member {
        // Bare ForbiddenException → Nest's default 403 body.
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden"));
    }

    let mut member_json = Vec::with_capacity(members.len());
    for m in &members {
        member_json.push(json!({
            "id": req_str(m, "id")?,
            "organizationId": req_str(m, "organizationId")?,
            "userId": req_str(m, "userId")?,
            "role": req_str(m, "role")?,
            "createdAt": iso(m, "createdAt"),
            // Only the three fields v1 `select`s — never the password hash.
            "user": {
                "id": req_str(m, "u_id")?,
                "email": req_str(m, "u_email")?,
                "displayName": m.try_get::<Option<String>, _>("u_displayName").ok().flatten(),
            },
        }));
    }

    // Prisma emits no ORDER BY for the workspaces relation; ordering by
    // creation keeps the same set and makes the list stable for the UI.
    let ws_rows = sqlx::query(
        r#"SELECT "id","name","slug","isPersonal","createdAt" FROM "Workspace"
           WHERE "organizationId" = $1 ORDER BY "createdAt" ASC, "id" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    let mut workspaces = Vec::with_capacity(ws_rows.len());
    for w in &ws_rows {
        workspaces.push(json!({
            "id": req_str(w, "id")?,
            "name": req_str(w, "name")?,
            "slug": req_str(w, "slug")?,
            "isPersonal": w.try_get::<bool, _>("isPersonal")
                .map_err(|e| ApiError::internal(format!("isPersonal: {e}")))?,
            "createdAt": iso(w, "createdAt"),
        }));
    }

    let mut out = org_json(&row, true)?;
    out["members"] = Value::Array(member_json);
    out["workspaces"] = Value::Array(workspaces);
    Ok(Json(out))
}

// --- PATCH /api/organizations/:id ------------------------------------------

async fn org_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    reject_unknown(&body, &["name", "billingEmail", "enforceSso", "seatLimit"])?;
    let name = if is_absent(&body, "name") {
        None
    } else {
        Some(parse_str(&body, "name", 1, 120)?)
    };
    let enforce_sso = if is_absent(&body, "enforceSso") {
        None
    } else {
        Some(parse_bool(&body, "enforceSso")?)
    };
    // `@IsOptional() @IsInt() @Min(1) seatLimit?: number | null` — @IsOptional
    // skips null, so `null` is an accepted value meaning "unmetered".
    let seat_limit: Option<Option<i32>> = if body.get("seatLimit").is_none() {
        None
    } else if matches!(body.get("seatLimit"), Some(Value::Null)) {
        Some(None)
    } else {
        let n = parse_int(&body, "seatLimit")?;
        if n < 1 {
            return Err(ApiError::bad("seatLimit must not be less than 1"));
        }
        Some(Some(i32::try_from(n).map_err(|_| {
            ApiError::bad("seatLimit must not be greater than 2147483647")
        })?))
    };
    // `@IsOptional() billingEmail?: string | null` carries NO type validator, so
    // whitelist keeps the property and anything gets through to the service.
    // There, `patch.billingEmail ? .trim().toLowerCase() : null` throws a
    // TypeError on a truthy non-string — which Nest surfaces as a bare 500.
    let billing_email: Option<Option<String>> = match body.get("billingEmail") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.is_empty() => Some(None),
        Some(Value::String(s)) => Some(Some(s.trim().to_lowercase())),
        Some(Value::Bool(false)) => Some(None),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Some(None),
        Some(_) => return Err(ApiError::internal("Internal server error")),
    };

    assert_org_owner(&state, &user.id, &id).await?;

    // Prisma always stamps @updatedAt on an update, even with an empty `data`.
    let mut sets: Vec<String> = vec![r#""updatedAt" = now()"#.to_string()];
    let mut n = 1;
    if name.is_some() {
        n += 1;
        sets.push(format!(r#""name" = ${n}"#));
    }
    if billing_email.is_some() {
        n += 1;
        sets.push(format!(r#""billingEmail" = ${n}"#));
    }
    if enforce_sso.is_some() {
        n += 1;
        sets.push(format!(r#""enforceSso" = ${n}"#));
    }
    if seat_limit.is_some() {
        n += 1;
        sets.push(format!(r#""seatLimit" = ${n}"#));
    }
    let sql = format!(
        r#"UPDATE "Organization" SET {} WHERE "id" = $1 RETURNING {ORG_COLS}"#,
        sets.join(", ")
    );
    let mut q = sqlx::query(&sql).bind(&id);
    if let Some(v) = name.as_ref() {
        // v1: `patch.name.trim().slice(0, 120)`.
        q = q.bind(v.trim().chars().take(120).collect::<String>());
    }
    if let Some(v) = billing_email.as_ref() {
        q = q.bind(v.clone());
    }
    if let Some(v) = enforce_sso {
        q = q.bind(v);
    }
    if let Some(v) = seat_limit.as_ref() {
        q = q.bind(*v);
    }
    let row = q
        .fetch_optional(&state.pool)
        .await?
        // Unreachable: assert_org_owner proved the row exists.
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    Ok(Json(org_json(&row, true)?))
}

// --- POST /api/organizations/:id/members   (@HttpCode(200)) ----------------

async fn org_add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    reject_unknown(&body, &["email", "role"])?;
    // Property order matches the DTO so the first reported error matches v1's.
    let email = parse_email(&body, "email")?;
    let role = parse_role(&body)?;
    assert_org_owner(&state, &user.id, &id).await?;

    // v1 lowercases but does NOT trim here.
    let target: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
        .bind(email.to_lowercase())
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let target = target.ok_or_else(|| {
        // The message echoes the ORIGINAL casing the caller sent.
        ApiError::new(StatusCode::NOT_FOUND, format!("No user with email {email}"))
    })?;

    let seat_limit: Option<i32> =
        sqlx::query_scalar(r#"SELECT "seatLimit" FROM "Organization" WHERE "id" = $1"#)
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    if let Some(limit) = seat_limit {
        let count: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM "OrganizationMember" WHERE "organizationId" = $1"#,
        )
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
        // NOTE (faithful to v1): the count is not reduced when the target is
        // already a member, so at the seat limit even a plain role change is
        // refused.
        if count >= limit as i64 {
            return Err(ApiError::bad("Seat limit reached"));
        }
    }

    let row = sqlx::query(
        r#"INSERT INTO "OrganizationMember" ("id","organizationId","userId","role","createdAt")
           VALUES ($1,$2,$3,$4::"Role",now())
           ON CONFLICT ("organizationId","userId") DO UPDATE SET "role" = EXCLUDED."role"
           RETURNING "id","organizationId","userId","role"::text AS "role","createdAt""#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&target)
    .bind(&role)
    .fetch_one(&state.pool)
    .await?;

    // @HttpCode(200) — not Nest's POST default.
    Ok(Json(json!({
        "id": req_str(&row, "id")?,
        "organizationId": req_str(&row, "organizationId")?,
        "userId": req_str(&row, "userId")?,
        "role": req_str(&row, "role")?,
        "createdAt": iso(&row, "createdAt"),
    })))
}

// --- DELETE /api/organizations/:id/members/:memberUserId -------------------

async fn org_remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_user_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let owner_id = assert_org_owner(&state, &user.id, &id).await?;
    // Without this an org could be left with no OWNER at all.
    if member_user_id == owner_id {
        return Err(ApiError::bad(
            "The org owner cannot be removed. Transfer ownership first.",
        ));
    }
    // deleteMany: a non-existent membership is a no-op, not a 404.
    sqlx::query(r#"DELETE FROM "OrganizationMember" WHERE "organizationId" = $1 AND "userId" = $2"#)
        .bind(&id)
        .bind(&member_user_id)
        .execute(&state.pool)
        .await?;
    // Nest's @Delete default status is 200.
    Ok(Json(json!({ "ok": true })))
}

// --- POST /api/organizations/:id/workspaces   (@HttpCode(200)) -------------

/// Every `Workspace` scalar, matching what Prisma's `update` returns.
const WS_COLS: &str =
    r#""id","name","slug","isPersonal","ownerId","organizationId","createdAt","updatedAt""#;

fn ws_json(r: &PgRow) -> ApiResult<Value> {
    Ok(json!({
        "id": req_str(r, "id")?,
        "name": req_str(r, "name")?,
        "slug": req_str(r, "slug")?,
        "isPersonal": r.try_get::<bool, _>("isPersonal")
            .map_err(|e| ApiError::internal(format!("isPersonal: {e}")))?,
        "ownerId": req_str(r, "ownerId")?,
        "organizationId": r.try_get::<Option<String>, _>("organizationId")
            .map_err(|e| ApiError::internal(format!("organizationId: {e}")))?,
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    }))
}

async fn org_attach_workspace(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    reject_unknown(&body, &["workspaceId"])?;
    let workspace_id = as_string(&body, "workspaceId")
        .ok_or_else(|| ApiError::bad("workspaceId must be a string"))?;
    assert_org_owner(&state, &user.id, &id).await?;

    let owner: Option<String> =
        sqlx::query_scalar(r#"SELECT "ownerId" FROM "Workspace" WHERE "id" = $1"#)
            .bind(&workspace_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    let owner = owner.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    // The caller must own the WORKSPACE too — org ownership alone can't pull
    // someone else's workspace (and its connections) into the org.
    if owner != user.id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the workspace owner can attach it to an organization",
        ));
    }

    let row = sqlx::query(&format!(
        r#"UPDATE "Workspace" SET "organizationId" = $1, "updatedAt" = now() WHERE "id" = $2
           RETURNING {WS_COLS}"#
    ))
    .bind(&id)
    .bind(&workspace_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    Ok(Json(ws_json(&row)?))
}

// --- DELETE /api/organizations/:id/workspaces/:workspaceId -----------------

async fn org_detach_workspace(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, workspace_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    assert_org_owner(&state, &user.id, &id).await?;
    // NOTE (faithful to v1): the workspace is NOT checked against this org, so
    // an org owner may detach a workspace that belongs to another org. Left
    // as-is deliberately — changing it would alter observable behaviour.
    let res = sqlx::query(
        r#"UPDATE "Workspace" SET "organizationId" = NULL, "updatedAt" = now() WHERE "id" = $1"#,
    )
    .bind(&workspace_id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        // Prisma throws P2025 for a missing row; it is not an HttpException, so
        // v1's filter answers a bare 500.
        return Err(ApiError::internal("Internal server error"));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Operator guard (v1 `OperatorGuard`) — for the billing-adjustments routes
// ---------------------------------------------------------------------------

fn operator_secret() -> Option<String> {
    env_opt("OPERATOR_JWT_SECRET")
}

#[derive(Deserialize)]
struct OperatorClaims {
    sub: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    exp: Option<i64>,
}

/// v1 `OperatorGuard.canActivate`, verbatim:
///   1. Bearer header or `operator_access` cookie
///   2. HS256 against OPERATOR_JWT_SECRET (a customer JWT fails here — different
///      secret, which is the whole point of the separate operator identity)
///   3. `kind === 'operator'` (defence in depth)
///   4. the Operator row still exists and is not disabled
///
/// Returns the operator id for the audit trail.
async fn require_operator(state: &AppState, headers: &HeaderMap) -> ApiResult<String> {
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer ").map(|s| s.to_string()))
        .or_else(|| {
            // Fallback to the cookie so the admin SPA can use httpOnly sessions.
            let raw = headers
                .get(axum::http::header::COOKIE)
                .and_then(|v| v.to_str().ok())?;
            raw.split(';').find_map(|kv| {
                let (k, v) = kv.split_once('=')?;
                (k.trim() == "operator_access").then(|| v.trim().to_string())
            })
        })
        .ok_or_else(|| ApiError::unauthorized("Operator token required"))?;

    let secret = operator_secret()
        .ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;
    let claims = decode_operator_jwt(&token, &secret)
        .ok_or_else(|| ApiError::unauthorized("Operator token invalid"))?;
    if claims.kind.as_deref() != Some("operator") {
        return Err(ApiError::unauthorized("Not an operator token"));
    }

    // Re-read the row on every request: a disabled operator must lose access
    // immediately, not when their token expires.
    let row = sqlx::query(r#"SELECT "id","disabledAt" FROM "Operator" WHERE "id" = $1"#)
        .bind(&claims.sub)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Operator not found"))?;
    let disabled: Option<chrono::NaiveDateTime> = row
        .try_get("disabledAt")
        .map_err(|e| ApiError::internal(format!("disabledAt: {e}")))?;
    if disabled.is_some() {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Operator disabled"));
    }
    req_str(&row, "id")
}

/// HS256 JWT verification against the operator secret. Mirrors main.rs's
/// `jwt_decode` (same base64url alphabet, same constant-time signature compare)
/// but reads `kind`, which the customer `Claims` struct does not carry.
fn decode_operator_jwt(token: &str, secret: &str) -> Option<OperatorClaims> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;

    let mut parts = token.splitn(3, '.');
    let h = parts.next()?;
    let p = parts.next()?;
    let s = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let expected = crate::jwt_sign(&format!("{h}.{p}"), secret);
    if !crate::ct_eq(expected.as_bytes(), s.as_bytes()) {
        return None;
    }
    let claims: OperatorClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()?).ok()?;
    if let Some(exp) = claims.exp {
        if exp < chrono::Utc::now().timestamp() {
            return None;
        }
    }
    Some(claims)
}

// ---------------------------------------------------------------------------
// Billing adjustments (operator) — /api/operator/workspaces/:id/adjustments
// ---------------------------------------------------------------------------

const ADJ_COLS: &str =
    r#""id","workspaceId","amountCents","currency","reason","periodStart","periodEnd","operatorId","createdAt""#;

fn adj_json(r: &PgRow) -> ApiResult<Value> {
    Ok(json!({
        "id": req_str(r, "id")?,
        "workspaceId": req_str(r, "workspaceId")?,
        // Cents, signed: negative = credit to the customer. INTEGER column read
        // as i32 so no value can round.
        "amountCents": req_i32(r, "amountCents")?,
        "currency": req_str(r, "currency")?,
        "reason": req_str(r, "reason")?,
        "periodStart": ts(r, "periodStart")?,
        "periodEnd": ts(r, "periodEnd")?,
        "operatorId": req_str(r, "operatorId")?,
        "createdAt": ts(r, "createdAt")?,
    }))
}

/// v1 `BillingAdjustmentsService.listForWorkspace`.
async fn adjustments_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_operator(&state, &headers).await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {ADJ_COLS} FROM "BillingAdjustment" WHERE "workspaceId" = $1
           ORDER BY "createdAt" DESC, "id" DESC"#
    ))
    .bind(&workspace_id)
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        out.push(adj_json(r)?);
    }
    Ok(Json(Value::Array(out)))
}

/// `@IsISO8601()` then `new Date(value)`. A date-only or offset-less string is
/// read as UTC — the API containers run UTC, which is also what makes v1's
/// `new Date('2026-01-01T00:00:00')` land on UTC midnight.
fn parse_iso8601(s: &str) -> Option<chrono::NaiveDateTime> {
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.naive_utc());
    }
    if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(d);
    }
    if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M") {
        return Some(d);
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
}

fn parse_period(body: &Value, field: &str) -> ApiResult<Option<chrono::NaiveDateTime>> {
    if is_absent(body, field) {
        return Ok(None);
    }
    let s = body
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| ApiError::bad(format!("{field} must be a valid ISO 8601 date string")))?;
    parse_iso8601(s)
        .map(Some)
        .ok_or_else(|| ApiError::bad(format!("{field} must be a valid ISO 8601 date string")))
}

/// v1 `BillingAdjustmentsController.issue` + service + operator audit entry.
async fn adjustments_issue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(workspace_id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let operator_id = require_operator(&state, &headers).await?;

    reject_unknown(
        &body,
        &["amountCents", "currency", "reason", "periodStart", "periodEnd"],
    )?;
    // DTO order: amountCents, currency, reason, periodStart, periodEnd.
    let amount_cents = parse_int(&body, "amountCents")?;
    // The clamp exists so a typo can't issue a $1M credit.
    if amount_cents < -1_000_000 {
        return Err(ApiError::bad("amountCents must not be less than -1000000"));
    }
    if amount_cents > 1_000_000 {
        return Err(ApiError::bad(
            "amountCents must not be greater than 1000000",
        ));
    }
    let currency = if is_absent(&body, "currency") {
        None
    } else {
        Some(parse_str(&body, "currency", 3, 3)?)
    };
    let reason = parse_str(&body, "reason", 1, 500)?;
    let period_start = parse_period(&body, "periodStart")?;
    let period_end = parse_period(&body, "periodEnd")?;
    let currency = currency.unwrap_or_else(|| "USD".to_string());

    let exists: Option<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "Workspace" WHERE "id" = $1"#)
            .bind(&workspace_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    if exists.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Workspace not found"));
    }

    let row = sqlx::query(&format!(
        r#"INSERT INTO "BillingAdjustment"
             ("id","workspaceId","amountCents","currency","reason","periodStart","periodEnd","operatorId","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING {ADJ_COLS}"#
    ))
    .bind(gen_id())
    .bind(&workspace_id)
    .bind(amount_cents as i32) // clamped to ±1_000_000 above
    .bind(&currency)
    .bind(&reason)
    .bind(period_start)
    .bind(period_end)
    .bind(&operator_id)
    .fetch_one(&state.pool)
    .await?;

    // Append-only audit trail. v1 swallows a failed audit write rather than
    // rolling back the business action, so this is deliberately best-effort.
    let action = if amount_cents < 0 {
        "BILLING_CREDIT_ISSUED"
    } else {
        "BILLING_CHARGE_ISSUED"
    };
    let metadata = json!({ "amountCents": amount_cents, "currency": currency });
    let _ = sqlx::query(
        r#"INSERT INTO "OperatorAuditLog"
             ("id","operatorId","action","targetType","targetId","reason","metadata","createdAt")
           VALUES ($1,$2,$3,'Workspace',$4,$5,$6::jsonb,now())"#,
    )
    .bind(gen_id())
    .bind(&operator_id)
    .bind(action)
    .bind(&workspace_id)
    .bind(&reason)
    .bind(&metadata)
    .execute(&state.pool)
    .await;

    // Nest's @Post default status.
    Ok((StatusCode::CREATED, Json(adj_json(&row)?)))
}
