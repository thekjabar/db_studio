//! Ops endpoints — Rust port of v1's `agents`, `scheduler` and `status`
//! modules (`backend/src/agents/`, `backend/src/scheduler/`,
//! `backend/src/status/`).
//!
//! Wire-compatible with v1 by design: same paths, same HTTP status codes (Nest's
//! 201-on-POST included), same error messages and the same JSON field names, so
//! the existing frontend (`api.listAgents/listSchedules/getPublicStatus`) cannot
//! tell which backend answered.
//!
//! ## What is ported natively
//!   * agents: create, authorize (browser auto-pair), pairing-token, delete.
//!   * schedules: list, get, runs.
//!   * status: `GET /api/status` (public, unauthenticated — v1 marks it
//!     `@Public()` + `@SkipThrottle()`).
//!
//! ## What is deliberately routed to the v1 proxy (and why)
//!   * `GET /api/agents` and `GET /api/agents/:id` — the `online` flag comes
//!     from `AgentRegistry`, an in-process `Map` of live `/agent-ws` sockets. The
//!     tunnel lives only in the Node process (and `agent_guard` keeps it there),
//!     so a Rust answer would report every agent offline. Serving these from
//!     Rust would be a silent lie, so they forward.
//!   * `POST/PATCH/DELETE /api/schedules[/:id]` and `POST /api/schedules/:id/run`
//!     — every one of them mutates BullMQ state in Redis (`QueuesService
//!     .upsertCron/.removeCron/.enqueueExec`). The cron trigger, not the row, is
//!     what actually makes a schedule fire; writing the row from Rust would
//!     create schedules that never run, leave disabled ones firing, and orphan
//!     repeatable jobs on delete. v2 has no Redis/BullMQ client, so these
//!     forward to v1 exactly as `POST /api/connections` already does.
//!   * `/api/admin/incidents*` (the `IncidentsAdminController` half of v1's
//!     status module) is ported in `admin.rs`; registering it here too would
//!     panic the router with an overlapping-route conflict.
//!
//! The mutating routes are registered explicitly against `crate::proxy` rather
//! than left unregistered: axum answers a known path + unknown method with 405
//! from the method router, it does NOT fall through to `Router::fallback`.

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{conn_role, gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        // ---- agents (AgentsController, global JwtAuthGuard) ----
        .route("/api/agents", get(crate::proxy).post(agent_create))
        // Static sibling of `/:id` below — matchit prefers the literal segment,
        // so "authorize" is never captured as an agent id.
        .route("/api/agents/authorize", post(agent_authorize))
        .route("/api/agents/:id", get(crate::proxy).delete(agent_delete))
        .route("/api/agents/:id/pairing-token", post(agent_pairing_token))
        // ---- schedules (SchedulerController, @UseGuards(JwtAuthGuard)) ----
        .route("/api/schedules", get(schedules_list).post(crate::proxy))
        .route(
            "/api/schedules/:id",
            get(schedule_get).patch(crate::proxy).delete(crate::proxy),
        )
        .route("/api/schedules/:id/run", post(crate::proxy))
        .route("/api/schedules/:id/runs", get(schedule_runs))
        // ---- status (PublicStatusController, @Public) ----
        .route("/api/status", get(public_status))
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// v1 `NotFoundException()` / `ForbiddenException()` with no argument render as
/// `{ statusCode, message: "Not Found" | "Forbidden" }`.
fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Not Found")
}

fn forbidden() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "Forbidden")
}

/// JS `new Date().toISOString()` — millisecond precision, `Z` suffix. Used for
/// timestamps v1 computes in-process (not read from a row).
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// class-validator's `@Length(min, max)` messages, reproduced verbatim so a
/// rejected body reads the same as it does on v1.
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

/// JS `String.prototype.slice(0, n)`, close enough for BMP text.
fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---------------------------------------------------------------------------
// Agents — v1 AgentsService
// ---------------------------------------------------------------------------

/// v1 `PAIRING_TTL = '15m'`.
const PAIRING_TTL_SECS: i64 = 15 * 60;

#[derive(Deserialize)]
struct CreateAgentBody {
    name: String,
}

#[derive(Deserialize)]
struct AuthorizeAgentBody {
    name: String,
    /// CSRF nonce the agent generated; echoed back unchanged.
    state: String,
}

/// v1 `AgentsService.view` — `online` comes from the in-process registry. Every
/// caller here creates the row in the same request, so `false` is not an
/// approximation: a just-created agent cannot hold a live socket yet. The two
/// routes where `online` is genuinely dynamic (list/get) forward to v1.
fn agent_view(r: &PgRow, online: bool) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "online": online,
        "lastSeenAt": iso(r, "lastSeenAt"),
    })
}

/// v1 `AgentsService.signPairingToken`: HS256 JWT `{ sub, agentId, kind }`
/// signed with `jwtAccessSecret` and `expiresIn: '15m'` — the exact token
/// `/agent-ws` verifies (it reads `sub` + `agentId`, and re-checks the Agent row
/// still belongs to `sub` before registering the tunnel).
///
/// SECURITY: this is a bearer credential for the tunnel, so it is minted, never
/// stored — v1 keeps no copy either (`Agent.refreshHash` is written by nothing
/// in the current tree). The secret is `AppState.jwt_secret`, which the v2 auth
/// port already requires to equal v1's `JWT_ACCESS_SECRET`; if the deployment
/// ever sets `V2_JWT_SECRET` to a different value, tokens minted here stop
/// verifying at v1's gateway.
fn sign_pairing_token(state: &AppState, agent_id: &str, user_id: &str) -> ApiResult<String> {
    let now = chrono::Utc::now().timestamp();
    let claims = json!({
        "sub": user_id,
        "agentId": agent_id,
        "kind": "agent-pairing",
        "iat": now,
        "exp": now + PAIRING_TTL_SECS,
    });
    let header = B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = B64.encode(
        serde_json::to_vec(&claims)
            .map_err(|e| ApiError::internal(format!("pairing token encode failed: {e}")))?,
    );
    let signing_input = format!("{header}.{payload}");
    let sig = crate::jwt_sign(&signing_input, &state.jwt_secret);
    Ok(format!("{signing_input}.{sig}"))
}

/// The agent must exist AND belong to the caller — v1 collapses "missing" and
/// "someone else's" into the same 404 so ids can't be probed.
async fn owned_agent(state: &AppState, id: &str, user_id: &str) -> ApiResult<()> {
    let row = sqlx::query(r#"SELECT "ownerId" FROM "Agent" WHERE "id" = $1"#)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let owner: String = match row {
        // Ownership decides access — propagate a decode error instead of
        // swallowing it into a `None` that would read as "not found".
        Some(r) => r
            .try_get("ownerId")
            .map_err(|e| ApiError::internal(format!("agent owner read failed: {e}")))?,
        None => return Err(not_found()),
    };
    if owner != user_id {
        return Err(not_found());
    }
    Ok(())
}

/// POST /api/agents — v1 `AgentsService.create`. 201 (Nest's POST default).
async fn agent_create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateAgentBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_len("name", &body.name, 1, 80)?;
    let trimmed = body.name.trim();
    if trimmed.is_empty() {
        return Err(ApiError::bad("Agent name is required."));
    }
    let name = truncate(trimmed, 80);
    let row = sqlx::query(
        r#"INSERT INTO "Agent" ("id","name","ownerId","createdAt")
           VALUES ($1, $2, $3, now())
           RETURNING "id","name","lastSeenAt""#,
    )
    .bind(gen_id())
    .bind(&name)
    .bind(&user.id)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(agent_view(&row, false))))
}

/// POST /api/agents/authorize — browser auto-pair. Reuses an existing agent with
/// the same name for this user (re-running agent.exe on one machine must not
/// spawn duplicates), otherwise creates one, then mints a pairing token.
async fn agent_authorize(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<AuthorizeAgentBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    check_len("name", &body.name, 1, 120)?;
    check_len("state", &body.state, 1, 200)?;

    let mut name = truncate(body.name.trim(), 80);
    if name.is_empty() {
        name = "Local agent".to_string();
    }

    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT "id" FROM "Agent"
           WHERE "ownerId" = $1 AND "name" = $2
           ORDER BY "createdAt" DESC
           LIMIT 1"#,
    )
    .bind(&user.id)
    .bind(&name)
    .fetch_optional(&state.pool)
    .await?;

    let agent_id = match existing {
        Some(id) => id,
        None => {
            let id = gen_id();
            sqlx::query(
                r#"INSERT INTO "Agent" ("id","name","ownerId","createdAt")
                   VALUES ($1, $2, $3, now())"#,
            )
            .bind(&id)
            .bind(&name)
            .bind(&user.id)
            .execute(&state.pool)
            .await?;
            id
        }
    };

    let token = sign_pairing_token(&state, &agent_id, &user.id)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "agentId": agent_id, "state": body.state })),
    ))
}

/// POST /api/agents/:id/pairing-token — v1 `createPairingToken`.
async fn agent_pairing_token(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owned_agent(&state, &id, &user.id).await?;
    let token = sign_pairing_token(&state, &id, &user.id)?;
    let expires_at = (chrono::Utc::now() + chrono::Duration::seconds(PAIRING_TTL_SECS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "expiresAt": expires_at })),
    ))
}

/// DELETE /api/agents/:id — unlink any connection still pointing at the agent so
/// it doesn't dangle, then delete. v1 does both without a transaction; matched.
async fn agent_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_agent(&state, &id, &user.id).await?;
    sqlx::query(
        r#"UPDATE "Connection" SET "agentId" = NULL, "viaAgent" = false WHERE "agentId" = $1"#,
    )
    .bind(&id)
    .execute(&state.pool)
    .await?;
    sqlx::query(r#"DELETE FROM "Agent" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Schedules — v1 SchedulerService (read side)
// ---------------------------------------------------------------------------

/// Every `ScheduledQuery` scalar Prisma returns, plus the `include`d connection
/// under distinct aliases (both tables have `id`/`name`, and sqlx resolves a
/// duplicate column name to the first match).
const SCHED_COLS: &str = r#"s."id", s."connectionId", s."ownerId", s."name", s."cron",
       s."timezone", s."schemaName", s."sqlText", s."emailTo", s."slackWebhook",
       s."alertCondition", s."alertCooldownMin", s."lastAlertedAt", s."enabled",
       s."lastRunAt", s."lastStatus"::text AS "lastStatus", s."nextRunAt",
       s."createdAt", s."updatedAt",
       c."id" AS "connId", c."name" AS "connName", c."dialect"::text AS "connDialect""#;

fn schedule_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "connectionId": r.try_get::<String, _>("connectionId").unwrap_or_default(),
        "ownerId": r.try_get::<String, _>("ownerId").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "cron": r.try_get::<String, _>("cron").unwrap_or_default(),
        "timezone": r.try_get::<Option<String>, _>("timezone").ok().flatten(),
        "schemaName": r.try_get::<Option<String>, _>("schemaName").ok().flatten(),
        "sqlText": r.try_get::<String, _>("sqlText").unwrap_or_default(),
        "emailTo": r.try_get::<String, _>("emailTo").unwrap_or_default(),
        "slackWebhook": r.try_get::<Option<String>, _>("slackWebhook").ok().flatten(),
        "alertCondition": r.try_get::<Option<Value>, _>("alertCondition").ok().flatten(),
        "alertCooldownMin": r.try_get::<Option<i32>, _>("alertCooldownMin").ok().flatten(),
        "lastAlertedAt": iso(r, "lastAlertedAt"),
        "enabled": r.try_get::<bool, _>("enabled").unwrap_or(false),
        "lastRunAt": iso(r, "lastRunAt"),
        "lastStatus": r.try_get::<Option<String>, _>("lastStatus").ok().flatten(),
        "nextRunAt": iso(r, "nextRunAt"),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
        "connection": {
            "id": r.try_get::<String, _>("connId").unwrap_or_default(),
            "name": r.try_get::<String, _>("connName").unwrap_or_default(),
            "dialect": r.try_get::<String, _>("connDialect").unwrap_or_default(),
        },
    })
}

fn run_dto(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "scheduleId": r.try_get::<String, _>("scheduleId").unwrap_or_default(),
        "startedAt": iso(r, "startedAt"),
        "finishedAt": iso(r, "finishedAt"),
        "status": r.try_get::<String, _>("status").unwrap_or_default(),
        "rowCount": r.try_get::<Option<i32>, _>("rowCount").ok().flatten(),
        "durationMs": r.try_get::<Option<i32>, _>("durationMs").ok().flatten(),
        "errorMessage": r.try_get::<Option<String>, _>("errorMessage").ok().flatten(),
        "resultPreview": r.try_get::<Option<Value>, _>("resultPreview").ok().flatten(),
        "emailDelivered": r.try_get::<bool, _>("emailDelivered").unwrap_or(false),
        "emailError": r.try_get::<Option<String>, _>("emailError").ok().flatten(),
        "alertTriggered": r.try_get::<bool, _>("alertTriggered").unwrap_or(false),
        "alertSummary": r.try_get::<Option<String>, _>("alertSummary").ok().flatten(),
    })
}

/// GET /api/schedules — the caller's schedules plus any on connections they own.
/// The tenant scope lives in the WHERE clause, so another user's rows are simply
/// not selected.
async fn schedules_list(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT {SCHED_COLS}
           FROM "ScheduledQuery" s
           JOIN "Connection" c ON c."id" = s."connectionId"
           WHERE s."ownerId" = $1 OR c."ownerId" = $1
           ORDER BY s."createdAt" DESC, s."id" DESC"#
    ))
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.iter().map(schedule_dto).collect::<Vec<_>>())))
}

/// v1 `SchedulerService.get`: 404 when the row is absent, then — for a schedule
/// the caller does not own — any effective role on its connection is enough to
/// read it; no role at all is 403.
async fn load_schedule(state: &AppState, user_id: &str, id: &str) -> ApiResult<PgRow> {
    let row = sqlx::query(&format!(
        r#"SELECT {SCHED_COLS}
           FROM "ScheduledQuery" s
           JOIN "Connection" c ON c."id" = s."connectionId"
           WHERE s."id" = $1"#
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(not_found)?;

    // Ownership gates the whole row — a decode failure must not fall through to
    // the (weaker) RBAC branch, so propagate instead of defaulting.
    let owner: String = row
        .try_get("ownerId")
        .map_err(|e| ApiError::internal(format!("schedule owner read failed: {e}")))?;
    if owner != user_id {
        let conn_id: String = row
            .try_get("connectionId")
            .map_err(|e| ApiError::internal(format!("schedule connection read failed: {e}")))?;
        if conn_role(&state.pool, &conn_id, user_id).await?.is_none() {
            return Err(forbidden());
        }
    }
    Ok(row)
}

async fn schedule_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = load_schedule(&state, &user.id, &id).await?;
    Ok(Json(schedule_dto(&row)))
}

#[derive(Deserialize)]
struct RunsQuery {
    #[serde(default)]
    limit: Option<String>,
}

/// GET /api/schedules/:id/runs — v1 clamps `limit` to 1..=200, default 50, and
/// reuses `get()` for the ACL check.
async fn schedule_runs(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Json<Value>> {
    load_schedule(&state, &user.id, &id).await?;
    let limit = q
        .limit
        .as_deref()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    let rows = sqlx::query(
        r#"SELECT "id","scheduleId","startedAt","finishedAt","status"::text AS "status",
                  "rowCount","durationMs","errorMessage","resultPreview",
                  "emailDelivered","emailError","alertTriggered","alertSummary"
           FROM "ScheduledQueryRun"
           WHERE "scheduleId" = $1
           ORDER BY "startedAt" DESC, "id" DESC
           LIMIT $2"#,
    )
    .bind(&id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!(rows.iter().map(run_dto).collect::<Vec<_>>())))
}

// ---------------------------------------------------------------------------
// Status — v1 StatusService.publicStatus (PUBLIC: no JwtAuthGuard)
// ---------------------------------------------------------------------------

fn severity_rank(s: &str) -> i32 {
    match s {
        "MINOR" => 1,
        "MAJOR" => 2,
        "CRITICAL" => 3,
        _ => 0,
    }
}

/// Minimal RESP probe standing in for v1's `ioredis.ping()`. v2 has no Redis
/// client crate, so this opens a socket and speaks the inline protocol:
/// optional `AUTH`, then `PING`, looking for `+PONG`. Runs on a blocking thread
/// with hard connect/read timeouts so a wedged Redis can never hang the public
/// status page.
fn redis_ping_blocking(url: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    const TIMEOUT: Duration = Duration::from_millis(1500);

    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    // `redis://[user][:password@]host[:port][/db]`
    let (userinfo, hostpart) = match rest.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, rest),
    };
    let hostport = hostpart.split(['/', '?']).next().unwrap_or(hostpart);
    let hostport = if hostport.contains(':') {
        hostport.to_string()
    } else {
        format!("{hostport}:6379")
    };

    let Ok(mut addrs) = hostport.to_socket_addrs() else {
        return false;
    };
    let Some(addr) = addrs.next() else {
        return false;
    };
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, TIMEOUT) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(TIMEOUT));
    let _ = sock.set_write_timeout(Some(TIMEOUT));

    let mut cmd = String::new();
    if let Some(info) = userinfo {
        let (user, pass) = match info.split_once(':') {
            Some((u, p)) => (u, p),
            None => ("", info),
        };
        if !pass.is_empty() {
            if user.is_empty() {
                cmd.push_str(&format!("AUTH {pass}\r\n"));
            } else {
                cmd.push_str(&format!("AUTH {user} {pass}\r\n"));
            }
        }
    }
    cmd.push_str("PING\r\n");
    if sock.write_all(cmd.as_bytes()).is_err() {
        return false;
    }

    let mut acc = String::new();
    let mut buf = [0u8; 256];
    for _ in 0..4 {
        match sock.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                acc.push_str(&String::from_utf8_lossy(&buf[..n]));
                if acc.contains("+PONG") {
                    return true;
                }
                if acc.starts_with('-') {
                    return false;
                }
            }
            Err(_) => break,
        }
    }
    false
}

fn component(name: &str, status: &str, detail: Option<String>) -> Value {
    // v1 leaves `detail` off entirely when it is undefined (JSON.stringify drops
    // undefined keys), so mirror that rather than emitting `"detail": null`.
    match detail {
        Some(d) => json!({ "name": name, "status": status, "detail": d }),
        None => json!({ "name": name, "status": status }),
    }
}

/// GET /api/status — public status page. Unauthenticated in v1 (`@Public()` on
/// the route, `@SkipThrottle()` on the controller) so probes and the marketing
/// page can hit it; no `AuthUser` extractor here on purpose.
async fn public_status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let mut components: Vec<Value> = Vec::new();

    // DB probe — the app's own Postgres.
    let started = Instant::now();
    match sqlx::query("SELECT 1").fetch_one(&state.pool).await {
        Ok(_) => {
            let ms = started.elapsed().as_millis() as i64;
            components.push(component(
                "Database",
                if ms > 500 { "degraded" } else { "ok" },
                Some(format!("{ms}ms")),
            ));
        }
        Err(_) => components.push(component(
            "Database",
            "down",
            Some("probe failed".to_string()),
        )),
    }

    // Redis probe (optional) — present only when REDIS_URL is configured, which
    // is exactly the condition under which v1 has a client to ping.
    if let Some(url) = std::env::var("REDIS_URL").ok().filter(|v| !v.trim().is_empty()) {
        let ok = tokio::task::spawn_blocking(move || redis_ping_blocking(&url))
            .await
            .unwrap_or(false);
        components.push(if ok {
            component("Queue (scheduler)", "ok", None)
        } else {
            component("Queue (scheduler)", "down", Some("probe failed".to_string()))
        });
    }

    // API itself is serving this request, so mark it operational.
    components.push(component("API", "ok", None));

    let active = sqlx::query(
        r#"SELECT "id","title","status"::text AS "status","severity"::text AS "severity",
                  "startedAt","updates"
           FROM "Incident"
           WHERE "resolvedAt" IS NULL
           ORDER BY "startedAt" DESC"#,
    )
    .fetch_all(&state.pool)
    .await?;

    let recent = sqlx::query(
        r#"SELECT "id","title","severity"::text AS "severity","startedAt","resolvedAt"
           FROM "Incident"
           WHERE "resolvedAt" IS NOT NULL
           ORDER BY "startedAt" DESC
           LIMIT 10"#,
    )
    .fetch_all(&state.pool)
    .await?;

    // Overall status is the worst of the components plus any active incident.
    let status_of = |c: &Value| c.get("status").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let mut overall = "operational";
    if components.iter().any(|c| status_of(c) == "down") {
        overall = "outage";
    } else if components.iter().any(|c| status_of(c) == "degraded") {
        overall = "degraded";
    }
    if !active.is_empty() {
        let highest = active
            .iter()
            .map(|r| r.try_get::<String, _>("severity").unwrap_or_default())
            .fold("MINOR".to_string(), |acc, sev| {
                if severity_rank(&sev) > severity_rank(&acc) { sev } else { acc }
            });
        if highest == "CRITICAL" {
            overall = "outage";
        } else if highest == "MAJOR" && overall == "operational" {
            overall = "degraded";
        }
    }

    let active_json: Vec<Value> = active
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "title": r.try_get::<String, _>("title").unwrap_or_default(),
                "status": r.try_get::<String, _>("status").unwrap_or_default(),
                "severity": r.try_get::<String, _>("severity").unwrap_or_default(),
                "startedAt": iso(r, "startedAt"),
                // v1: `(i.updates as IncidentUpdate[]) ?? []` — anything that is
                // not an array degrades to an empty timeline.
                "updates": r
                    .try_get::<Option<Value>, _>("updates")
                    .ok()
                    .flatten()
                    .filter(|v| v.is_array())
                    .unwrap_or_else(|| json!([])),
            })
        })
        .collect();

    let recent_json: Vec<Value> = recent
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "title": r.try_get::<String, _>("title").unwrap_or_default(),
                "severity": r.try_get::<String, _>("severity").unwrap_or_default(),
                "startedAt": iso(r, "startedAt"),
                "resolvedAt": iso(r, "resolvedAt"),
            })
        })
        .collect();

    Ok(Json(json!({
        "overall": overall,
        "asOf": now_iso(),
        "components": components,
        "activeIncidents": active_json,
        "recentIncidents": recent_json,
    })))
}
