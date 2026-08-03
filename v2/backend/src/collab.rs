//! Webhooks + comments — Rust port of v1's `backend/src/webhooks/` and
//! `backend/src/comments/` Nest modules.
//!
//! Faithful to v1 down to routes, status codes and error strings. Two v1 quirks
//! are reproduced deliberately (they are load-bearing for compatibility):
//!
//!  * The webhook sub-routes take `:webhookId` and **ignore** the `:id`
//!    connection segment — `WebhooksController` never passes it to the service,
//!    which looks the hook up by primary key alone and then runs RBAC against
//!    the hook's *own* `connectionId`. Filtering by the path connection here
//!    would 404 requests that v1 serves.
//!  * `webhook.update`/`remove`/`testFire` authorize on `Webhook.ownerId` first
//!    and only fall back to the connection role — a non-owner EDITOR cannot edit
//!    a hook even though EDITOR outranks nothing here; v1 demands OWNER.
//!
//! The delivery pipeline differs by necessity: v1 pushes onto a bullmq/Redis
//! queue and a separate worker dials the URL. v2 has no Redis, so `…/test`
//! spawns the same delivery logic (`webhook.worker.ts` `deliver()`) as a
//! detached task and returns `{ queued: true }` immediately, exactly as v1's
//! endpoint does. The wire format — payload, headers, HMAC — is byte-identical
//! so existing receivers keep verifying.

use std::fmt::Write as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/connections/:id/webhooks",
            get(webhooks_list).post(webhook_create),
        )
        .route(
            "/api/connections/:id/webhooks/:webhookId",
            get(webhook_get).patch(webhook_update).delete(webhook_delete),
        )
        .route(
            "/api/connections/:id/webhooks/:webhookId/test",
            post(webhook_test),
        )
        .route(
            "/api/connections/:id/webhooks/:webhookId/deliveries",
            get(webhook_deliveries),
        )
        .route(
            "/api/connections/:id/comments",
            get(comments_list).post(comment_create),
        )
        // Must stay a distinct route from `:commentId` below; matchit gives the
        // static segment priority, so `/comments/counts` never falls into it.
        .route("/api/connections/:id/comments/counts", get(comment_counts))
        .route(
            "/api/connections/:id/comments/:commentId",
            patch(comment_update).delete(comment_delete),
        )
}

// ---------------------------------------------------------------------------
// RBAC — v1 `rbac.service.ts`
// ---------------------------------------------------------------------------

/// v1 `RANK`: VIEWER=1, EDITOR=2, OWNER=3. Unknown roles sort below VIEWER so a
/// future enum value can never silently satisfy a check.
fn rank(role: &str) -> i32 {
    match role {
        "VIEWER" => 1,
        "EDITOR" => 2,
        "OWNER" => 3,
        _ => 0,
    }
}

/// v1 `RbacService.require`. `require_conn_owner` is too strict for these
/// routes: VIEWER/EDITOR members must pass, and a ConnectionMember whose role is
/// OWNER counts as OWNER even though they are not `Connection.ownerId`.
///
/// The role lookup itself is `crate::conn_role`, which already reproduces v1's
/// owner → ConnectionMember → WorkspaceMember precedence.
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match crate::conn_role(&state.pool, conn_id, user_id).await? {
        None => {
            // v1 re-checks existence so a bad id reads as 404, not 403.
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                    .bind(conn_id)
                    .fetch_optional(&state.pool)
                    .await?
                    .flatten();
            if exists.is_none() {
                Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))
            } else {
                Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"))
            }
        }
        Some(role) if rank(&role) < rank(min) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {min} role (have {role})"),
        )),
        Some(role) => Ok(role),
    }
}

/// `Webhook.ownerId` wins; otherwise the caller must hold OWNER on the
/// connection. `msg` differs per v1 call site (edit says why, delete/test use
/// Nest's bare `ForbiddenException`).
async fn require_hook_owner(
    state: &AppState,
    hook_owner: &str,
    conn_id: &str,
    user_id: &str,
    msg: &str,
) -> ApiResult<()> {
    if hook_owner == user_id {
        return Ok(());
    }
    let role = crate::conn_role(&state.pool, conn_id, user_id).await?;
    if role.as_deref() == Some("OWNER") {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, msg))
    }
}

// ---------------------------------------------------------------------------
// SSRF guard — v1 `common/ssrf-guard.service.ts`
// ---------------------------------------------------------------------------
//
// SECURITY: a webhook makes *our* server dial a user-supplied URL, and the
// delivery row stores the response body which `…/deliveries` hands straight
// back — a readable SSRF, not a blind one. Dropping this on the port would
// reopen it, so it comes along.

fn allow_private_hosts() -> bool {
    std::env::var("ALLOW_PRIVATE_HOSTS").map(|v| v == "true").unwrap_or(false)
}

/// Minimal absolute-URL split. v2 has no `url` crate and only needs what v1
/// reads off `new URL(...)`: the protocol and the hostname. Returns `None` for
/// inputs where `new URL()` would throw.
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
    // Non-hierarchical schemes (mailto:, javascript:) parse fine in JS but carry
    // no authority; they get rejected by the http(s) check downstream.
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip userinfo: everything up to and including the LAST '@'.
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or("").to_string(), // [::1]:8080
        None => authority.split(':').next().unwrap_or("").to_string(),
    };
    if (scheme == "http" || scheme == "https") && host.is_empty() {
        return None; // `new URL("https://")` throws
    }
    Some((scheme, host))
}

fn is_blocked_v4(a: Ipv4Addr) -> bool {
    let [x, y, ..] = a.octets();
    x == 0                              // 0.0.0.0/8 "this network"
        || x == 10                      // private
        || x == 127                     // loopback
        || (x == 169 && y == 254)       // link-local — cloud metadata (169.254.169.254)
        || (x == 172 && (16..=31).contains(&y)) // private — Docker bridges live here
        || (x == 192 && y == 168)       // private
        || (x == 100 && (64..=127).contains(&y)) // CGNAT 100.64/10
        || (x == 192 && y == 0)         // 192.0.0/24 + 192.0.2/24 test nets
        || (x == 198 && (y == 18 || y == 19)) // benchmarking
        || x >= 224 // multicast + reserved + broadcast
}

fn is_blocked_v6(a: Ipv6Addr) -> bool {
    if a.is_unspecified() || a.is_loopback() {
        return true;
    }
    // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded v4 address.
    if let Some(v4) = a.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    let s = a.to_string();
    s.starts_with("fe80")                              // link-local
        || s.starts_with("fc") || s.starts_with("fd")  // unique-local fc00::/7
        || s.starts_with("ff") // multicast
}

fn is_blocked(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(a) => is_blocked_v4(a),
        IpAddr::V6(a) => is_blocked_v6(a),
    }
}

/// v1 `assertPublicHost`. Validates the RESOLVED addresses, not the name — a
/// hostname can simply carry an A record of 127.0.0.1.
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
            // Unresolvable names are refused rather than passed through: a name
            // that resolves only inside our network would otherwise slip past
            // when lookup fails here but succeeds at dial time.
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
    let (scheme, host) = parse_url(raw).ok_or_else(|| ApiError::bad(format!("{label} is not a valid URL")))?;
    if scheme != "http" && scheme != "https" {
        return Err(ApiError::bad(format!("{label} must be http(s)")));
    }
    assert_public_host(&host, label).await
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

const EVENTS: [&str; 3] = ["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"];

/// Postgres enums have no sqlx mapping here, so they are cast to text on the
/// way out (and back on the way in). `sanitize()` in v1 drops `secretCt`; this
/// column list never selects it in the first place.
const WEBHOOK_COLS: &str = r#""id","connectionId","ownerId","name","url","schemaName","tableName","events"::text[] AS "events","enabled","lastFiredAt","lastStatus"::text AS "lastStatus","createdAt","updatedAt""#;

fn webhook_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "connectionId": r.try_get::<String, _>("connectionId").unwrap_or_default(),
        "ownerId": r.try_get::<String, _>("ownerId").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "url": r.try_get::<String, _>("url").unwrap_or_default(),
        "schemaName": r.try_get::<String, _>("schemaName").unwrap_or_default(),
        "tableName": r.try_get::<String, _>("tableName").unwrap_or_default(),
        "events": r.try_get::<Vec<String>, _>("events").unwrap_or_default(),
        "enabled": r.try_get::<bool, _>("enabled").unwrap_or(true),
        "lastFiredAt": iso(r, "lastFiredAt"),
        "lastStatus": r.try_get::<Option<String>, _>("lastStatus").ok().flatten(),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

/// v1 `IDENT_RE` — `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`.
fn ident_re(s: &str) -> bool {
    let mut cs = s.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    s.len() <= 64 && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn check_len(field: &str, v: &str, min: usize, max: usize) -> ApiResult<()> {
    let n = v.chars().count();
    if n < min {
        return Err(ApiError::bad(format!(
            "{field} must be longer than or equal to {min} characters"
        )));
    }
    if n > max {
        return Err(ApiError::bad(format!(
            "{field} must be shorter than or equal to {max} characters"
        )));
    }
    Ok(())
}

fn check_events(events: &[String]) -> ApiResult<()> {
    if events.is_empty() {
        return Err(ApiError::bad("events must contain at least 1 elements"));
    }
    if events.iter().any(|e| !EVENTS.contains(&e.as_str())) {
        return Err(ApiError::bad(
            "each value in events must be one of the following values: ROW_INSERT, ROW_UPDATE, ROW_DELETE",
        ));
    }
    Ok(())
}

/// v1 `WebhooksService.validateInput` — only the fields actually present.
async fn validate_webhook_input(
    schema_name: Option<&str>,
    table_name: Option<&str>,
    url: Option<&str>,
) -> ApiResult<()> {
    if let Some(s) = schema_name {
        if !ident_re(s) {
            return Err(ApiError::bad("Invalid schema name"));
        }
    }
    if let Some(t) = table_name {
        if !ident_re(t) {
            return Err(ApiError::bad("Invalid table name"));
        }
    }
    if let Some(u) = url {
        let (scheme, _) = parse_url(u).ok_or_else(|| ApiError::bad("URL must be a valid absolute URL"))?;
        if scheme != "http" && scheme != "https" {
            return Err(ApiError::bad("URL must be http(s)"));
        }
        assert_public_url(u, "Webhook URL").await?;
    }
    Ok(())
}

// --- quota (v1 `common/quota.service.ts` + `billing/plan.service.ts`) -------

struct PlanLimits {
    name: String,
    max_webhooks: i32,
}

/// v1 `DEFAULT_PLANS` — used when the operator-editable PlanConfig row is absent.
fn default_plan(tier: &str) -> PlanLimits {
    let (name, max) = match tier {
        "PRO" => ("Pro", 10),
        "TEAM" => ("Team", 25),
        _ => ("Trial", 0),
    };
    PlanLimits { name: name.into(), max_webhooks: max }
}

/// v1 `LOCKED_LIMITS` — no active entitlement means nothing is free.
fn locked_plan() -> PlanLimits {
    PlanLimits { name: "No plan".into(), max_webhooks: 0 }
}

async fn plan_config(state: &AppState, tier: &str) -> ApiResult<PlanLimits> {
    let row = sqlx::query(
        r#"SELECT "name","maxWebhooksPerConnection" FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#,
    )
    .bind(tier)
    .fetch_optional(&state.pool)
    .await?;
    Ok(match row {
        Some(r) => PlanLimits {
            name: r.try_get::<String, _>("name").unwrap_or_default(),
            max_webhooks: r.try_get::<i32, _>("maxWebhooksPerConnection").unwrap_or(0),
        },
        None => default_plan(tier),
    })
}

/// v1 `QuotaService.assertCanCreateWebhook`. The plan cap comes from the
/// workspace's effective tier; the env cap is an absolute host ceiling an
/// oversized plan row can never exceed.
async fn assert_can_create_webhook(state: &AppState, conn_id: &str) -> ApiResult<()> {
    let count: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "Webhook" WHERE "connectionId" = $1"#)
        .bind(conn_id)
        .fetch_one(&state.pool)
        .await?;

    let workspace_id: Option<String> =
        sqlx::query_scalar(r#"SELECT "workspaceId" FROM "Connection" WHERE "id" = $1"#)
            .bind(conn_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();

    let cfg = match workspace_id {
        Some(ws) => {
            let sub = sqlx::query(
                r#"SELECT "plan"::text AS "plan","status"::text AS "status","periodEnd"
                   FROM "Subscription" WHERE "workspaceId" = $1"#,
            )
            .bind(&ws)
            .fetch_optional(&state.pool)
            .await?;
            // v1 `isEntitled`: not SUSPENDED and the period is still open. Both a
            // lapsed trial and a lapsed paid plan drop to LOCKED.
            let entitled = sub.as_ref().and_then(|r| {
                let status = r.try_get::<String, _>("status").ok()?;
                let period_end = r.try_get::<chrono::NaiveDateTime, _>("periodEnd").ok()?;
                let plan = r.try_get::<String, _>("plan").ok()?;
                (status != "SUSPENDED" && period_end > chrono::Utc::now().naive_utc()).then_some(plan)
            });
            match entitled {
                Some(plan) => plan_config(state, &plan).await?,
                None => locked_plan(),
            }
        }
        // No workspace → v1 falls back to the coded/DB FREE tier.
        None => plan_config(state, "FREE").await?,
    };

    let env_cap = std::env::var("MAX_WEBHOOKS_PER_CONNECTION")
        .ok()
        .and_then(|v| v.parse::<i32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(20);
    let cap = cfg.max_webhooks.min(env_cap);
    if count >= cap as i64 {
        // A zero cap means "no plan / no subscription" — steer to Billing to
        // subscribe rather than "upgrade".
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            if cap == 0 {
                "You need an active subscription to add webhooks. Open Billing to choose a plan.".to_string()
            } else {
                format!(
                    "Your {} plan allows {} webhook(s) per connection. Upgrade your plan to add more.",
                    cfg.name, cfg.max_webhooks
                )
            },
        ));
    }
    Ok(())
}

// --- handlers --------------------------------------------------------------

async fn webhooks_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {WEBHOOK_COLS} FROM "Webhook" WHERE "connectionId" = $1 ORDER BY "createdAt" DESC"#,
    ))
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.iter().map(webhook_dto).collect::<Vec<_>>())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWebhook {
    name: String,
    url: String,
    schema_name: String,
    table_name: String,
    events: Vec<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

fn webhook_purpose(id: &str) -> String {
    format!("webhook:{id}")
}

async fn webhook_create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<CreateWebhook>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // DTO-level constraints (class-validator) run before the service in v1.
    check_len("name", &body.name, 1, 80)?;
    check_len("schemaName", &body.schema_name, 1, 64)?;
    check_len("tableName", &body.table_name, 1, 64)?;
    check_events(&body.events)?;

    require_role(&state, &id, &user.id, "OWNER").await?;
    validate_webhook_input(Some(&body.schema_name), Some(&body.table_name), Some(&body.url)).await?;
    if body.events.is_empty() {
        return Err(ApiError::bad("At least one event must be selected"));
    }
    assert_can_create_webhook(&state, &id).await?;

    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("Encryption is not configured (ENCRYPTION_KEY missing)"))?;

    // Node's `randomBytes(32).toString('base64url')`.
    let mut raw = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut raw);
    let secret = B64URL.encode(raw);

    // Encrypted at write time. The id doesn't exist yet, so v1 uses a throwaway
    // purpose and re-encrypts with the id-bound one right after insert.
    let temp_ct = crypto
        .encrypt(&secret, "webhook:new")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let hook_id = gen_id();
    sqlx::query(
        r#"INSERT INTO "Webhook"
             ("id","connectionId","ownerId","name","url","secretCt","schemaName","tableName","events","enabled","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[]::"WebhookEvent"[],$10,now(),now())"#,
    )
    .bind(&hook_id)
    .bind(&id)
    .bind(&user.id)
    .bind(&body.name)
    .bind(&body.url)
    .bind(&temp_ct)
    .bind(&body.schema_name)
    .bind(&body.table_name)
    .bind(&body.events)
    .bind(body.enabled.unwrap_or(true))
    .execute(&state.pool)
    .await?;

    let final_ct = crypto
        .encrypt(&secret, &webhook_purpose(&hook_id))
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let row = sqlx::query(&format!(
        r#"UPDATE "Webhook" SET "secretCt" = $1, "updatedAt" = now() WHERE "id" = $2 RETURNING {WEBHOOK_COLS}"#,
    ))
    .bind(&final_ct)
    .bind(&hook_id)
    .fetch_one(&state.pool)
    .await?;

    // The plaintext secret is returned exactly once, at create time.
    let mut out = webhook_dto(&row);
    out["secret"] = json!(secret);
    Ok((StatusCode::CREATED, Json(out)))
}

async fn webhook_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_id, webhook_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(&format!(r#"SELECT {WEBHOOK_COLS} FROM "Webhook" WHERE "id" = $1"#))
        .bind(&webhook_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let conn_id: String = row.try_get("connectionId").unwrap_or_default();
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    Ok(Json(webhook_dto(&row)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateWebhook {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    schema_name: Option<String>,
    #[serde(default)]
    table_name: Option<String>,
    #[serde(default)]
    events: Option<Vec<String>>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    secret: Option<String>,
}

async fn webhook_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_id, webhook_id)): Path<(String, String)>,
    Json(body): Json<UpdateWebhook>,
) -> ApiResult<Json<Value>> {
    if let Some(v) = &body.name {
        check_len("name", v, 1, 80)?;
    }
    if let Some(v) = &body.schema_name {
        check_len("schemaName", v, 1, 64)?;
    }
    if let Some(v) = &body.table_name {
        check_len("tableName", v, 1, 64)?;
    }
    if let Some(v) = &body.events {
        check_events(v)?;
    }
    if let Some(v) = &body.secret {
        check_len("secret", v, 16, 512)?;
    }

    let existing = sqlx::query(r#"SELECT "connectionId","ownerId" FROM "Webhook" WHERE "id" = $1"#)
        .bind(&webhook_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let conn_id: String = existing.try_get("connectionId").unwrap_or_default();
    let hook_owner: String = existing.try_get("ownerId").unwrap_or_default();
    require_hook_owner(
        &state,
        &hook_owner,
        &conn_id,
        &user.id,
        "Only the owner or connection owner can edit",
    )
    .await?;

    validate_webhook_input(body.schema_name.as_deref(), body.table_name.as_deref(), body.url.as_deref()).await?;

    // `if (patch.secret)` in v1 — an empty string is falsy and leaves the
    // stored secret untouched.
    let secret_ct = match body.secret.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => Some(
            state
                .crypto
                .as_ref()
                .ok_or_else(|| ApiError::internal("Encryption is not configured (ENCRYPTION_KEY missing)"))?
                .encrypt(s, &webhook_purpose(&webhook_id))
                .map_err(|e| ApiError::internal(e.to_string()))?,
        ),
        None => None,
    };

    // COALESCE = Prisma's "only the keys present in `data`"; `updatedAt` always
    // moves, matching @updatedAt firing on every update() call.
    let row = sqlx::query(&format!(
        r#"UPDATE "Webhook" SET
             "name" = COALESCE($1, "name"),
             "url" = COALESCE($2, "url"),
             "schemaName" = COALESCE($3, "schemaName"),
             "tableName" = COALESCE($4, "tableName"),
             "events" = COALESCE($5::text[]::"WebhookEvent"[], "events"),
             "enabled" = COALESCE($6, "enabled"),
             "secretCt" = COALESCE($7, "secretCt"),
             "updatedAt" = now()
           WHERE "id" = $8 RETURNING {WEBHOOK_COLS}"#,
    ))
    .bind(&body.name)
    .bind(&body.url)
    .bind(&body.schema_name)
    .bind(&body.table_name)
    .bind(&body.events)
    .bind(body.enabled)
    .bind(&secret_ct)
    .bind(&webhook_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(webhook_dto(&row)))
}

async fn webhook_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_id, webhook_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let existing = sqlx::query(r#"SELECT "connectionId","ownerId" FROM "Webhook" WHERE "id" = $1"#)
        .bind(&webhook_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let conn_id: String = existing.try_get("connectionId").unwrap_or_default();
    let hook_owner: String = existing.try_get("ownerId").unwrap_or_default();
    require_hook_owner(&state, &hook_owner, &conn_id, &user.id, "Forbidden").await?;

    sqlx::query(r#"DELETE FROM "Webhook" WHERE "id" = $1"#)
        .bind(&webhook_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeliveriesQ {
    #[serde(default)]
    limit: Option<String>,
}

/// JS `parseInt(raw, 10)` semantics: leading digits win, trailing junk ignored.
fn js_parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    digits[..end].parse::<i64>().ok().map(|n| if neg { -n } else { n })
}

async fn webhook_deliveries(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_id, webhook_id)): Path<(String, String)>,
    Query(q): Query<DeliveriesQ>,
) -> ApiResult<Json<Value>> {
    let conn_id: Option<String> =
        sqlx::query_scalar(r#"SELECT "connectionId" FROM "Webhook" WHERE "id" = $1"#)
            .bind(&webhook_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    let conn_id = conn_id.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;

    // v1: `limitRaw ? parseInt(limitRaw,10) || 50 : 50`, then clamped to 1..200.
    // NaN *and* 0 are falsy in JS, so both fall back to 50.
    let limit = q
        .limit
        .filter(|s| !s.is_empty())
        .and_then(|s| js_parse_int(&s))
        .filter(|n| *n != 0)
        .unwrap_or(50)
        .max(1)
        .min(200);

    let rows = sqlx::query(
        r#"SELECT "id","webhookId","event"::text AS "event","attempt","status"::text AS "status",
                  "httpStatus","responseBody","errorMessage","startedAt","finishedAt","durationMs"
           FROM "WebhookDelivery" WHERE "webhookId" = $1 ORDER BY "startedAt" DESC LIMIT $2"#,
    )
    .bind(&webhook_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!(rows
        .iter()
        .map(|r| json!({
            "id": r.try_get::<String, _>("id").unwrap_or_default(),
            "webhookId": r.try_get::<String, _>("webhookId").unwrap_or_default(),
            "event": r.try_get::<String, _>("event").unwrap_or_default(),
            "attempt": r.try_get::<i32, _>("attempt").unwrap_or(0),
            "status": r.try_get::<String, _>("status").unwrap_or_default(),
            "httpStatus": r.try_get::<Option<i32>, _>("httpStatus").ok().flatten(),
            "responseBody": r.try_get::<Option<String>, _>("responseBody").ok().flatten(),
            "errorMessage": r.try_get::<Option<String>, _>("errorMessage").ok().flatten(),
            "startedAt": iso(r, "startedAt"),
            "finishedAt": iso(r, "finishedAt"),
            "durationMs": r.try_get::<Option<i32>, _>("durationMs").ok().flatten(),
        }))
        .collect::<Vec<_>>())))
}

async fn webhook_test(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_id, webhook_id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let w = sqlx::query(r#"SELECT "connectionId","ownerId" FROM "Webhook" WHERE "id" = $1"#)
        .bind(&webhook_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let conn_id: String = w.try_get("connectionId").unwrap_or_default();
    let hook_owner: String = w.try_get("ownerId").unwrap_or_default();
    require_hook_owner(&state, &hook_owner, &conn_id, &user.id, "Forbidden").await?;

    // Synthetic test event, byte-identical to v1's queued payload. Built here
    // (not in the task) so `sentAt` is the enqueue time, as in v1.
    let payload = json!({
        "test": true,
        "message": "This is a manual test delivery triggered from the UI.",
        "sentAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    });
    // v1 returns as soon as the job is queued; the worker dials in the
    // background. Detached task = the same observable behaviour without Redis.
    tokio::spawn(deliver(state.clone(), webhook_id, "ROW_INSERT", payload));

    Ok((StatusCode::CREATED, Json(json!({ "queued": true }))))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Truncate on character boundaries — v1 uses `String.slice(0, n)`.
fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Port of `webhook.worker.ts` `deliver()`. Never propagates errors (it runs
/// detached); every outcome is recorded on the WebhookDelivery row instead.
async fn deliver(state: AppState, webhook_id: String, event: &'static str, payload: Value) {
    let w = match sqlx::query(r#"SELECT "id","url","enabled","secretCt" FROM "Webhook" WHERE "id" = $1"#)
        .bind(&webhook_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => {
            tracing::warn!("webhook {webhook_id} not found, dropping");
            return;
        }
        Err(e) => {
            tracing::warn!("webhook {webhook_id} lookup failed: {e}");
            return;
        }
    };
    if !w.try_get::<bool, _>("enabled").unwrap_or(false) {
        tracing::info!("webhook {webhook_id} disabled, skipping");
        return;
    }
    let url: String = w.try_get("url").unwrap_or_default();
    let secret_ct: String = w.try_get("secretCt").unwrap_or_default();

    let delivery_id = gen_id();
    // attempt = 1: bullmq's `attemptsMade + 1` on the first (only) try.
    if let Err(e) = sqlx::query(
        r#"INSERT INTO "WebhookDelivery" ("id","webhookId","event","attempt","status","startedAt")
           VALUES ($1,$2,$3::"WebhookEvent",1,'PENDING'::"WebhookDeliveryStatus",now())"#,
    )
    .bind(&delivery_id)
    .bind(&webhook_id)
    .bind(event)
    .execute(&state.pool)
    .await
    {
        tracing::warn!("webhook {webhook_id} delivery row insert failed: {e}");
        return;
    }
    let started = Instant::now();

    match try_send(&state, &url, &secret_ct, &webhook_id, &delivery_id, event, &payload).await {
        Ok((http_status, text)) => {
            // JS `response.ok` == 200..=299.
            let ok = (200..300).contains(&http_status);
            let status = if ok { "SUCCESS" } else { "FAILED" };
            let _ = sqlx::query(
                r#"UPDATE "WebhookDelivery"
                   SET "status" = $1::"WebhookDeliveryStatus", "httpStatus" = $2, "responseBody" = $3,
                       "finishedAt" = now(), "durationMs" = $4
                   WHERE "id" = $5"#,
            )
            .bind(status)
            .bind(http_status)
            .bind(if text.is_empty() { None } else { Some(&text) })
            .bind(started.elapsed().as_millis() as i32)
            .bind(&delivery_id)
            .execute(&state.pool)
            .await;
            let _ = sqlx::query(
                r#"UPDATE "Webhook" SET "lastFiredAt" = now(), "lastStatus" = $1::"WebhookDeliveryStatus" WHERE "id" = $2"#,
            )
            .bind(status)
            .bind(&webhook_id)
            .execute(&state.pool)
            .await;
        }
        Err(message) => {
            let _ = sqlx::query(
                r#"UPDATE "WebhookDelivery"
                   SET "status" = 'FAILED'::"WebhookDeliveryStatus", "errorMessage" = $1,
                       "finishedAt" = now(), "durationMs" = $2
                   WHERE "id" = $3"#,
            )
            .bind(truncate(&message, 2_000))
            .bind(started.elapsed().as_millis() as i32)
            .bind(&delivery_id)
            .execute(&state.pool)
            .await;
            let _ = sqlx::query(
                r#"UPDATE "Webhook" SET "lastFiredAt" = now(), "lastStatus" = 'FAILED'::"WebhookDeliveryStatus" WHERE "id" = $1"#,
            )
            .bind(&webhook_id)
            .execute(&state.pool)
            .await;
            tracing::warn!("webhook delivery failed (webhook={webhook_id}): {message}");
        }
    }
}

/// Signs and POSTs the payload. `Ok((status, body))` for any HTTP response
/// (including 5xx — the caller decides); `Err(msg)` for anything that stopped
/// us reaching one.
#[allow(clippy::too_many_arguments)]
async fn try_send(
    state: &AppState,
    url: &str,
    secret_ct: &str,
    webhook_id: &str,
    delivery_id: &str,
    event: &str,
    payload: &Value,
) -> Result<(i32, String), String> {
    let body = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| "Encryption is not configured (ENCRYPTION_KEY missing)".to_string())?;
    let secret = crypto
        .decrypt(secret_ct, &webhook_purpose(webhook_id))
        .map_err(|e| e.to_string())?;

    // HMAC-SHA256 over the exact bytes we send, hex-encoded — receivers verify
    // `X-DBStudio-Signature: sha256=<hex>`.
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(&body);
    let signature = hex_lower(&mac.finalize().into_bytes());

    // SECURITY: re-check the destination immediately before dialing. Checking
    // only at save time is bypassable — the hostname can be re-pointed at an
    // internal address after validation (DNS rebinding), and rows created
    // before the guard existed were never checked at all.
    assert_public_url(url, "Webhook URL").await.map_err(|e| e.message)?;

    // reqwest is built without the `json` feature, so the body is serialized by
    // hand and content-type set explicitly.
    let resp = state
        .http
        .post(url)
        .header("content-type", "application/json")
        .header("user-agent", "DBStudio-Webhook/1.0")
        .header("x-dbstudio-event", event)
        .header("x-dbstudio-delivery", delivery_id)
        .header("x-dbstudio-signature", format!("sha256={signature}"))
        .timeout(Duration::from_secs(10))
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status().as_u16() as i32;
    let text = truncate(&resp.text().await.unwrap_or_default(), 2_000);
    Ok((status, text))
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/// v1 `include: { user: { select: { email, displayName } } }`.
const COMMENT_COLS: &str = r#"c."id",c."connectionId",c."userId",c."target",c."body",c."createdAt",c."updatedAt",u."email",u."displayName""#;

fn comment_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "connectionId": r.try_get::<String, _>("connectionId").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "target": r.try_get::<String, _>("target").unwrap_or_default(),
        "body": r.try_get::<String, _>("body").unwrap_or_default(),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
        "user": {
            "email": r.try_get::<String, _>("email").unwrap_or_default(),
            "displayName": r.try_get::<Option<String>, _>("displayName").ok().flatten(),
        },
    })
}

/// v1 `CommentsService.validateTarget`.
fn validate_target(target: &str) -> ApiResult<()> {
    if !(target.starts_with("table:") || target.starts_with("column:") || target.starts_with("row:")) {
        return Err(ApiError::bad("target must start with table: / column: / row:"));
    }
    if target.chars().count() > 500 {
        return Err(ApiError::bad("target too long"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct CommentListQ {
    #[serde(default)]
    target: Option<String>,
}

async fn comments_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<CommentListQ>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "VIEWER").await?;
    // v1 spreads `target ? { target } : {}` — an empty string is falsy, so it
    // means "no filter", not "match empty".
    let target = q.target.filter(|t| !t.is_empty());
    let rows = sqlx::query(&format!(
        r#"SELECT {COMMENT_COLS} FROM "Comment" c JOIN "User" u ON u."id" = c."userId"
           WHERE c."connectionId" = $1 AND ($2::text IS NULL OR c."target" = $2)
           ORDER BY c."createdAt" DESC"#,
    ))
    .bind(&id)
    .bind(&target)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.iter().map(comment_dto).collect::<Vec<_>>())))
}

async fn comment_counts(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(
        r#"SELECT "target", count(*) AS "n" FROM "Comment" WHERE "connectionId" = $1 GROUP BY "target""#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    // Map of target -> count, for badges in the UI. `{}` when there are none.
    let mut out = Map::new();
    for r in &rows {
        let target: String = r.try_get("target").unwrap_or_default();
        let n: i64 = r.try_get("n").unwrap_or(0);
        out.insert(target, json!(n));
    }
    Ok(Json(Value::Object(out)))
}

/// Fields are optional at the serde layer on purpose: v1 mounts `RbacGuard` on
/// this controller, and Nest runs guards *before* the ValidationPipe — so a
/// caller without EDITOR gets 403, not a body-validation 400. Making them
/// non-optional would let axum's extractor reject first and flip that order.
#[derive(Deserialize)]
struct CreateComment {
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

async fn comment_create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(dto): Json<CreateComment>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_role(&state, &id, &user.id, "EDITOR").await?;
    let target = dto.target.ok_or_else(|| ApiError::bad("target must be a string"))?;
    let body = dto.body.ok_or_else(|| ApiError::bad("body must be a string"))?;
    check_len("target", &target, 1, 500)?;
    check_len("body", &body, 1, 5_000)?;
    validate_target(&target)?;
    if body.trim().is_empty() {
        return Err(ApiError::bad("body is required"));
    }
    if body.chars().count() > 5_000 {
        return Err(ApiError::bad("body too long"));
    }
    // One round trip: insert, then join the author for the `user` include.
    let row = sqlx::query(&format!(
        r#"WITH ins AS (
             INSERT INTO "Comment" ("id","connectionId","userId","target","body","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,now(),now())
             RETURNING *
           )
           SELECT {COMMENT_COLS} FROM ins c JOIN "User" u ON u."id" = c."userId""#,
    ))
    .bind(gen_id())
    .bind(&id)
    .bind(&user.id)
    .bind(&target)
    .bind(&body)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(comment_dto(&row))))
}

#[derive(Deserialize)]
struct UpdateComment {
    #[serde(default)]
    body: Option<String>,
}

async fn comment_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, comment_id)): Path<(String, String)>,
    Json(dto): Json<UpdateComment>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "EDITOR").await?;
    let new_body = dto.body.ok_or_else(|| ApiError::bad("body must be a string"))?;
    check_len("body", &new_body, 1, 5_000)?;
    // v1 looks the comment up by primary key only — it is not scoped to the
    // connection in the path; ownership is what gates the write.
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "userId" FROM "Comment" WHERE "id" = $1"#)
        .bind(&comment_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let owner = owner.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    if owner != user.id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Not your comment"));
    }
    if new_body.trim().is_empty() {
        return Err(ApiError::bad("body is required"));
    }
    let row = sqlx::query(&format!(
        r#"WITH upd AS (
             UPDATE "Comment" SET "body" = $1, "updatedAt" = now() WHERE "id" = $2 RETURNING *
           )
           SELECT {COMMENT_COLS} FROM upd c JOIN "User" u ON u."id" = c."userId""#,
    ))
    .bind(&new_body)
    .bind(&comment_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(comment_dto(&row)))
}

async fn comment_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, comment_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    require_role(&state, &id, &user.id, "EDITOR").await?;
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "userId" FROM "Comment" WHERE "id" = $1"#)
        .bind(&comment_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let owner = owner.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    if owner != user.id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Not your comment"));
    }
    sqlx::query(r#"DELETE FROM "Comment" WHERE "id" = $1"#)
        .bind(&comment_id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    /// `/comments/counts` and `/comments/:commentId` are siblings; a routing
    /// conflict would only surface as a panic at startup, so assert it here.
    #[test]
    fn router_builds() {
        let _ = super::routes();
    }
}
