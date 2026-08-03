//! Schedule mutations — the BullMQ write half of v1's scheduler module
//! (`backend/src/scheduler/scheduler.service.ts` + `queues.service.ts`).
//!
//! `ops.rs` already serves the read side (`GET /api/schedules`, `/:id`,
//! `/:id/runs`). This module completes it:
//!
//!   * `POST   /api/schedules`
//!   * `PATCH  /api/schedules/:id`
//!   * `DELETE /api/schedules/:id`
//!   * `POST   /api/schedules/:id/run`
//!
//! Each of these writes a Postgres row *and* mutates BullMQ state in Redis. The
//! row is inert on its own — the repeatable-job entry is what makes a schedule
//! fire, and the Node worker (`SchedulerWorker`) is the only consumer. So the
//! bar for this port is not "plausible Redis writes": it is that the bytes
//! BullMQ's own Lua would have written are the bytes we write.
//!
//! ## How that was established (not by reading — by diffing)
//!
//! The v1 path was driven against a live Redis with `Date.now()` pinned, every
//! command ioredis sent was captured on the wire (msgpack payloads included),
//! and the resulting keyspace was dumped. The same scenarios were then driven
//! from this code with the same pinned instant and dumped with the same
//! reader. The two dumps are identical, byte for byte, for: upsert (with and
//! without a timezone), upsert-over-an-existing-registration, remove,
//! remove-when-absent, run-now, run-now twice, and run-now on a queue that
//! already has a cron. Details in the module tests below, which assert the
//! captured msgpack byte strings directly.
//!
//! ## What v1 actually calls (and what the previous attempt got wrong)
//!
//! `QueuesService.upsertCron` calls `Queue.add(name, data, { repeat })`. In
//! bullmq 5.76.0 `Queue.addJob` routes anything with `opts.repeat` to
//! `Repeat.updateRepeatableJob` — the *legacy* repeatable path — not to
//! `JobScheduler.upsertJobScheduler`. So the scripts in play are
//! `addRepeatableJob-2.lua` + `addDelayedJob-6.lua`, not `addJobScheduler-11.lua`;
//! `removeRepeatableByKey` uses `removeRepeatable-3.lua`; and `enqueueExec`
//! (a plain `Queue.add` with no repeat and no delay) uses `addStandardJob-9.lua`.
//! Those four are reimplemented below as four small scripts that are
//! command-for-command what bullmq's are once the branches this call site can
//! never reach are removed (see `mod bull` for the enumeration of what was
//! dropped and why each is unreachable).
//!
//! ## Cron
//!
//! bullmq's `getNextMillis` is
//! `cron-parser.parseExpression(pattern, { currentDate, tz }).next().getTime()`,
//! against cron-parser **4.9.0** (which computes on luxon `DateTime`s). The
//! `cron` crate cannot stand in for it: it rejects `0` as a day-of-week (so the
//! stock "every Sunday" pattern `0 0 * * 0` fails to parse), it ANDs
//! day-of-month with day-of-week where cron/cron-parser OR them, and it has no
//! `L`. Each of those silently changes *when a customer's schedule fires*. So
//! `mod cronparser` is a port of cron-parser 4.9.0's own algorithm — its field
//! parser, its `_findSchedule` loop, and luxon's `objToTS` zone resolution —
//! differential-tested against the real thing over 6 000 (pattern, timezone,
//! instant) combinations, including every DST transition of 2026 in the zones
//! the timezone picker offers. See the test module.
//!
//! ## Conditional registration
//!
//! These routes are registered only when `REDIS_URL` is set, mirroring
//! `billing.rs`. v2 reads its own `.env`; if Redis were configured in v1 but not
//! here, an unconditional registration would turn "create a schedule" into a
//! 500 (or worse, a row that never fires) when leaving it to proxy would work.

use std::sync::OnceLock;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{conn_role, gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

/// v1 `CRON_RE` — five whitespace-separated non-blank fields, nothing else.
/// Deliberately as loose as v1's: anything past the shape is cron-parser's job
/// to reject, and it must reject it the same way here.
fn cron_shape_ok(s: &str) -> bool {
    let fields: Vec<&str> = s.split_whitespace().collect();
    // `\S+\s+` five times, anchored: no leading/trailing whitespace either.
    fields.len() == 5 && !s.starts_with(char::is_whitespace) && !s.ends_with(char::is_whitespace)
}

pub fn routes() -> Router<AppState> {
    // No Redis configured for *this* process → leave every mutating route on
    // the v1 proxy. Registering them would make them fail closed against a
    // backend that is, from v1's point of view, working fine.
    if redis_url().is_none() {
        return Router::new();
    }
    Router::new()
        .route("/api/schedules", post(create))
        .route(
            "/api/schedules/:id",
            axum::routing::patch(update).delete(remove),
        )
        .route("/api/schedules/:id/run", post(run_now))
}

fn redis_url() -> Option<&'static str> {
    static URL: OnceLock<Option<String>> = OnceLock::new();
    URL.get_or_init(|| std::env::var("REDIS_URL").ok().filter(|s| !s.trim().is_empty()))
        .as_deref()
}

// ---------------------------------------------------------------------------
// Errors — v1 wording, verbatim
// ---------------------------------------------------------------------------

fn forbidden(msg: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, msg)
}

fn not_found(msg: &str) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, msg)
}

/// class-validator's `@Length(min, max)` messages.
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

/// class-validator `@IsEmail()`. Kept intentionally permissive — the point is
/// to reject obvious junk in the same place v1 does, not to out-validate it.
fn is_email(s: &str) -> bool {
    let mut parts = s.rsplitn(2, '@');
    let domain = parts.next().unwrap_or("");
    let local = match parts.next() {
        Some(l) => l,
        None => return false,
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !s.contains(char::is_whitespace)
}

// ---------------------------------------------------------------------------
// RBAC — v1 RbacService
// ---------------------------------------------------------------------------

fn role_rank(r: &str) -> i32 {
    match r {
        "VIEWER" => 1,
        "EDITOR" => 2,
        "OWNER" => 3,
        _ => 0,
    }
}

/// v1 `RbacService.require(userId, connectionId, min)`, including its two
/// distinct failures: a connection that does not exist is a 404, one the caller
/// cannot see is a 403.
async fn rbac_require(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match conn_role(&state.pool, conn_id, user_id).await? {
        Some(role) => {
            if role_rank(&role) < role_rank(min) {
                Err(forbidden(&format!("Requires {min} role (have {role})")))
            } else {
                Ok(role)
            }
        }
        None => {
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                    .bind(conn_id)
                    .fetch_optional(&state.pool)
                    .await?;
            if exists.is_none() {
                Err(not_found("Connection not found"))
            } else {
                Err(forbidden("No access to this connection"))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Quota — v1 QuotaService.assertCanCreateSchedule + PlanService.forUser
// ---------------------------------------------------------------------------

struct PlanLimits {
    name: String,
    tier: String,
    ai_enabled: bool,
    daily_ai_calls: i32,
    max_scheduled_queries: i32,
}

/// v1 `DEFAULT_PLANS` — the coded fallback for a tier whose `PlanConfig` row is
/// missing.
fn default_plan(tier: &str) -> PlanLimits {
    let (name, ai, calls, sched) = match tier {
        "PRO" => ("Pro", true, 50, 25),
        "TEAM" => ("Team", true, 200, 100),
        _ => ("Trial", false, 0, 0),
    };
    PlanLimits {
        name: name.into(),
        tier: tier.into(),
        ai_enabled: ai,
        daily_ai_calls: calls,
        max_scheduled_queries: sched,
    }
}

/// v1 `LOCKED_LIMITS` — no active entitlement anywhere means nothing is free.
fn locked_plan() -> PlanLimits {
    PlanLimits {
        name: "No plan".into(),
        tier: "FREE".into(),
        ai_enabled: false,
        daily_ai_calls: 0,
        max_scheduled_queries: 0,
    }
}

fn tier_index(tier: &str) -> i32 {
    match tier {
        "FREE" => 0,
        "PRO" => 1,
        "TEAM" => 2,
        _ => -1,
    }
}

async fn plan_config(state: &AppState, tier: &str) -> ApiResult<PlanLimits> {
    let row = sqlx::query(
        r#"SELECT "name","aiEnabled","dailyAiCalls","maxScheduledQueries"
           FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#,
    )
    .bind(tier)
    .fetch_optional(&state.pool)
    .await?;
    Ok(match row {
        Some(r) => PlanLimits {
            name: r.try_get::<String, _>("name").unwrap_or_default(),
            tier: tier.into(),
            ai_enabled: r.try_get::<bool, _>("aiEnabled").unwrap_or(false),
            daily_ai_calls: r.try_get::<i32, _>("dailyAiCalls").unwrap_or(0),
            max_scheduled_queries: r.try_get::<i32, _>("maxScheduledQueries").unwrap_or(0),
        },
        None => default_plan(tier),
    })
}

/// v1 `PlanService.forUser`: the strongest plan the user is entitled to across
/// every workspace they belong to *or* own. "Strongest" = AI-enabled, then
/// highest daily AI allowance, then tier order — v1's comparator, quirks
/// included (it ranks on the AI fields even when the caller wants a schedule
/// cap, so a plan with more schedules but less AI does NOT win).
async fn plan_for_user(state: &AppState, user_id: &str) -> ApiResult<PlanLimits> {
    let rows = sqlx::query(
        r#"SELECT s."plan"::text AS "plan", s."status"::text AS "status", s."periodEnd"
             FROM "Subscription" s
             JOIN "Workspace" w ON w."id" = s."workspaceId"
            WHERE w."ownerId" = $1
               OR EXISTS (SELECT 1 FROM "WorkspaceMember" wm
                           WHERE wm."workspaceId" = s."workspaceId" AND wm."userId" = $1)"#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;

    // v1 `isEntitled`: not SUSPENDED and the period is still open. Compared in
    // Rust because `periodEnd` is `timestamp WITHOUT time zone` holding UTC.
    let now = chrono::Utc::now().naive_utc();
    let mut tiers: Vec<String> = Vec::new();
    for r in &rows {
        // A decode failure must never read as "entitled".
        let status: String = r.try_get("status").map_err(|e| ApiError::internal(e.to_string()))?;
        let period_end: chrono::NaiveDateTime =
            r.try_get("periodEnd").map_err(|e| ApiError::internal(e.to_string()))?;
        let plan: String = r.try_get("plan").map_err(|e| ApiError::internal(e.to_string()))?;
        if status != "SUSPENDED" && period_end > now && !tiers.contains(&plan) {
            tiers.push(plan);
        }
    }
    if tiers.is_empty() {
        return Ok(locked_plan());
    }
    let mut best: Option<PlanLimits> = None;
    for t in tiers {
        let c = plan_config(state, &t).await?;
        best = Some(match best {
            None => c,
            Some(b) => {
                let better = if c.ai_enabled != b.ai_enabled {
                    i32::from(c.ai_enabled) - i32::from(b.ai_enabled)
                } else if c.daily_ai_calls != b.daily_ai_calls {
                    c.daily_ai_calls - b.daily_ai_calls
                } else {
                    tier_index(&c.tier) - tier_index(&b.tier)
                };
                if better > 0 {
                    c
                } else {
                    b
                }
            }
        });
    }
    Ok(best.unwrap_or_else(locked_plan))
}

/// v1 `QuotaService.assertCanCreateSchedule`.
async fn assert_can_create_schedule(state: &AppState, user_id: &str) -> ApiResult<()> {
    let count: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM "ScheduledQuery" WHERE "ownerId" = $1"#)
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    let plan = plan_for_user(state, user_id).await?;
    // v1 `MAX_SCHEDULED_QUERIES_PER_WORKSPACE`, `z.coerce.number().int().positive().default(50)`.
    let env_cap = std::env::var("MAX_SCHEDULED_QUERIES_PER_WORKSPACE")
        .ok()
        .and_then(|v| v.trim().parse::<i32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(50);
    let cap = plan.max_scheduled_queries.min(env_cap);
    if count >= cap as i64 {
        return Err(forbidden(&if cap == 0 {
            "You need an active subscription to schedule queries. Open Billing to choose a plan."
                .to_string()
        } else {
            format!(
                "Your {} plan allows {} scheduled queries. Upgrade your plan to add more.",
                plan.name, plan.max_scheduled_queries
            )
        }));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The schedulable-SQL gate — v1 SchedulerService.assertSchedulableSql
// ---------------------------------------------------------------------------

/// SECURITY: a scheduled statement runs unattended **as the connection owner**,
/// so scheduling has to face the same approval bar as running the statement by
/// hand. Without this an EDITOR could cron `DROP TABLE x` and step around the
/// review gate `/query` enforces. There is no interactive approval on a timer,
/// so this refuses outright rather than accepting a review-request id.
async fn assert_schedulable_sql(
    state: &AppState,
    user_id: &str,
    conn_id: &str,
    sql: &str,
) -> ApiResult<()> {
    let row = sqlx::query(
        r#"SELECT "dialect"::text AS "dialect","requireReview" FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(conn_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else { return Ok(()) }; // v1: `if (!conn?.requireReview) return`
    // Fail closed: a column that will not decode must not read as "review off".
    let require_review: bool = row
        .try_get("requireReview")
        .map_err(|e| ApiError::internal(format!("connection requireReview read failed: {e}")))?;
    if !require_review {
        return Ok(());
    }
    if conn_role(&state.pool, conn_id, user_id).await?.as_deref() == Some("OWNER") {
        return Ok(());
    }
    let dialect: String = row.try_get("dialect").unwrap_or_default();
    if crate::queue::classify(sql, &dialect).needs_review() {
        // v1 throws `ForbiddenException({ code, message, classification })`, but
        // its global `HttpExceptionFilter` keeps only `message` — the
        // `classification` payload never reaches a client. So the message is the
        // whole contract.
        return Err(forbidden(
            "This connection requires approval for destructive statements, so only the connection owner can schedule one.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/// Every `ScheduledQuery` scalar, in Prisma's declaration order — `create` and
/// `update` return the bare row (no `connection` include), unlike the read side.
const ROW_COLS: &str = r#""id","connectionId","ownerId","name","cron","timezone","schemaName",
       "sqlText","emailTo","slackWebhook","alertCondition","alertCooldownMin","lastAlertedAt",
       "enabled","lastRunAt","lastStatus"::text AS "lastStatus","nextRunAt","createdAt","updatedAt""#;

fn row_dto(r: &PgRow) -> Value {
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
    })
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    connection_id: String,
    name: String,
    cron: String,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    schema_name: Option<String>,
    sql_text: String,
    email_to: Vec<String>,
    #[serde(default)]
    slack_webhook: Option<String>,
    #[serde(default)]
    alert_condition: Option<Value>,
    #[serde(default)]
    alert_cooldown_min: Option<i64>,
    #[serde(default)]
    enabled: Option<bool>,
}

/// `PATCH` distinguishes "absent" from "null" for every nullable field — v1's
/// spread-if-defined build of the Prisma `data` object depends on it, and a
/// `null` timezone means "clear it" while an absent one means "leave it".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default)]
    cron: Option<String>,
    #[serde(default)]
    timezone: Option<Option<String>>,
    #[serde(default)]
    schema_name: Option<Option<String>>,
    #[serde(default)]
    sql_text: Option<String>,
    #[serde(default)]
    email_to: Option<Vec<String>>,
    #[serde(default)]
    slack_webhook: Option<Option<String>>,
    #[serde(default)]
    alert_condition: Option<Option<Value>>,
    #[serde(default)]
    alert_cooldown_min: Option<Option<i64>>,
    #[serde(default)]
    enabled: Option<bool>,
}

/// v1 `narrowAlertCondition` — anything that is not a well-formed condition
/// becomes `null` rather than an error.
fn narrow_alert_condition(v: Option<&Value>) -> Option<Value> {
    const OPS: [&str; 10] = [
        "gt", "gte", "lt", "lte", "eq", "neq", "rows_gt", "rows_gte", "rows_lt", "rows_eq",
    ];
    let o = v?.as_object()?;
    let op = o.get("op")?.as_str()?;
    if !OPS.contains(&op) {
        return None;
    }
    let value = o.get("value")?.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    let mut out = json!({ "op": op, "value": o.get("value")? });
    if let Some(col) = o.get("column").and_then(|c| c.as_str()) {
        if !col.is_empty() {
            out.as_object_mut()
                .expect("json! built an object")
                .insert("column".into(), json!(col));
        }
    }
    Some(out)
}

fn check_slack(url: &str) -> ApiResult<()> {
    if !url.is_empty() && !url.starts_with("https://hooks.slack.com/") {
        return Err(ApiError::bad("Slack webhook must be a hooks.slack.com URL"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/schedules — v1 `SchedulerService.create`. 201 (Nest's POST default).
///
/// Order of operations is v1's, and it matters: the cron shape is checked before
/// RBAC, the quota before the SQL gate, and the row is written *before* the
/// BullMQ registration. That last one means a cron pattern that passes
/// `CRON_RE` but that cron-parser cannot parse leaves a persisted row and
/// returns 500 — reproduced rather than "fixed", because a v2 that quietly
/// rejected a schedule v1 accepted (or vice versa) is the worse failure.
async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // --- class-validator, in DTO declaration order ---
    check_len("connectionId", &body.connection_id, 1, 200)?;
    check_len("name", &body.name, 1, 80)?;
    if !cron_shape_ok(&body.cron) {
        return Err(ApiError::bad(
            "cron must match /^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$/ regular expression",
        ));
    }
    if let Some(tz) = &body.timezone {
        check_len("timezone", tz, 0, 64)?;
    }
    if let Some(s) = &body.schema_name {
        check_len("schemaName", s, 0, 128)?;
    }
    check_len("sqlText", &body.sql_text, 1, 100_000)?;
    if body.email_to.is_empty() {
        return Err(ApiError::bad("emailTo should not be empty"));
    }
    if !body.email_to.iter().all(|e| is_email(e)) {
        return Err(ApiError::bad("each value in emailTo must be an email"));
    }
    if let Some(w) = &body.slack_webhook {
        check_len("slackWebhook", w, 0, 500)?;
    }
    if let Some(m) = body.alert_cooldown_min {
        if !(1..=1440).contains(&m) {
            return Err(ApiError::bad(if m < 1 {
                "alertCooldownMin must not be less than 1"
            } else {
                "alertCooldownMin must not be greater than 1440"
            }));
        }
    }

    // --- service ---
    rbac_require(&state, &body.connection_id, &user.id, "EDITOR").await?;
    assert_can_create_schedule(&state, &user.id).await?;
    assert_schedulable_sql(&state, &user.id, &body.connection_id, &body.sql_text).await?;
    if let Some(w) = &body.slack_webhook {
        check_slack(w)?;
    }

    let alert = narrow_alert_condition(body.alert_condition.as_ref());
    let enabled = body.enabled.unwrap_or(true);
    let row = sqlx::query(&format!(
        r#"INSERT INTO "ScheduledQuery"
             ("id","connectionId","ownerId","name","cron","timezone","schemaName","sqlText",
              "emailTo","slackWebhook","alertCondition","alertCooldownMin","enabled",
              "createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
           RETURNING {ROW_COLS}"#
    ))
    .bind(gen_id())
    .bind(&body.connection_id)
    .bind(&user.id)
    .bind(&body.name)
    .bind(&body.cron)
    .bind(body.timezone.as_deref())
    .bind(body.schema_name.as_deref())
    .bind(&body.sql_text)
    .bind(body.email_to.join(","))
    .bind(body.slack_webhook.as_deref())
    .bind(alert)
    .bind(body.alert_cooldown_min.map(|m| m as i32))
    .bind(enabled)
    .fetch_one(&state.pool)
    .await?;

    if enabled {
        let id: String = row.try_get("id").unwrap_or_default();
        bull::upsert_cron(&id, &body.cron, body.timezone.as_deref(), bull::wall_clock).await?;
    }
    Ok((StatusCode::CREATED, Json(row_dto(&row))))
}

/// v1 `assertCanManage`: the schedule's own owner, or the OWNER of the
/// connection it runs against.
async fn assert_can_manage(state: &AppState, user_id: &str, id: &str) -> ApiResult<()> {
    let row = sqlx::query(r#"SELECT "ownerId","connectionId" FROM "ScheduledQuery" WHERE "id" = $1"#)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| not_found("Schedule not found"))?;
    // Ownership decides the whole request — propagate a decode error instead of
    // letting it fall through to the RBAC branch.
    let owner: String = row
        .try_get("ownerId")
        .map_err(|e| ApiError::internal(format!("schedule owner read failed: {e}")))?;
    if owner == user_id {
        return Ok(());
    }
    let conn_id: String = row
        .try_get("connectionId")
        .map_err(|e| ApiError::internal(format!("schedule connection read failed: {e}")))?;
    if conn_role(&state.pool, &conn_id, user_id).await?.as_deref() != Some("OWNER") {
        return Err(forbidden("Only schedule or connection owner can modify"));
    }
    Ok(())
}

/// PATCH /api/schedules/:id — v1 `SchedulerService.update`.
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<Value>> {
    if let Some(n) = &body.name {
        check_len("name", n, 1, 80)?;
    }
    if let Some(c) = &body.cron {
        if !cron_shape_ok(c) {
            return Err(ApiError::bad(
                "cron must match /^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$/ regular expression",
            ));
        }
    }
    if let Some(Some(tz)) = &body.timezone {
        check_len("timezone", tz, 0, 64)?;
    }
    if let Some(Some(s)) = &body.schema_name {
        check_len("schemaName", s, 0, 128)?;
    }
    if let Some(s) = &body.sql_text {
        check_len("sqlText", s, 1, 100_000)?;
    }
    if let Some(list) = &body.email_to {
        if !list.iter().all(|e| is_email(e)) {
            return Err(ApiError::bad("each value in emailTo must be an email"));
        }
    }

    assert_can_manage(&state, &user.id, &id).await?;
    let existing =
        sqlx::query(r#"SELECT "connectionId" FROM "ScheduledQuery" WHERE "id" = $1"#)
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| not_found("Schedule not found"))?;
    let conn_id: String = existing
        .try_get("connectionId")
        .map_err(|e| ApiError::internal(format!("schedule connection read failed: {e}")))?;

    // SECURITY: re-run the gate on edit. Without it the check is trivially
    // skipped by creating a harmless SELECT schedule and swapping in the
    // destructive SQL afterwards.
    if let Some(sql) = &body.sql_text {
        assert_schedulable_sql(&state, &user.id, &conn_id, sql).await?;
    }
    if let Some(Some(w)) = &body.slack_webhook {
        check_slack(w)?;
    }

    // Prisma's `...(x !== undefined && { x })` spread, as a COALESCE-free
    // "update only what was sent" statement. Every parameter is bound; the
    // `$n::bool` flags say whether the column participates.
    let alert_present = body.alert_condition.is_some();
    let alert_value = body
        .alert_condition
        .as_ref()
        .and_then(|v| narrow_alert_condition(v.as_ref()));
    let row = sqlx::query(&format!(
        r#"UPDATE "ScheduledQuery" SET
             "name"             = CASE WHEN $2  THEN $3  ELSE "name" END,
             "cron"             = CASE WHEN $4  THEN $5  ELSE "cron" END,
             "timezone"         = CASE WHEN $6  THEN $7  ELSE "timezone" END,
             "schemaName"       = CASE WHEN $8  THEN $9  ELSE "schemaName" END,
             "sqlText"          = CASE WHEN $10 THEN $11 ELSE "sqlText" END,
             "emailTo"          = CASE WHEN $12 THEN $13 ELSE "emailTo" END,
             "slackWebhook"     = CASE WHEN $14 THEN $15 ELSE "slackWebhook" END,
             "alertCondition"   = CASE WHEN $16 THEN $17 ELSE "alertCondition" END,
             "alertCooldownMin" = CASE WHEN $18 THEN $19 ELSE "alertCooldownMin" END,
             "enabled"          = CASE WHEN $20 THEN $21 ELSE "enabled" END,
             "updatedAt"        = now()
           WHERE "id" = $1
           RETURNING {ROW_COLS}"#
    ))
    .bind(&id)
    .bind(body.name.is_some())
    .bind(body.name.as_deref().unwrap_or(""))
    .bind(body.cron.is_some())
    .bind(body.cron.as_deref().unwrap_or(""))
    .bind(body.timezone.is_some())
    .bind(body.timezone.clone().flatten())
    .bind(body.schema_name.is_some())
    .bind(body.schema_name.clone().flatten())
    .bind(body.sql_text.is_some())
    .bind(body.sql_text.as_deref().unwrap_or(""))
    .bind(body.email_to.is_some())
    .bind(body.email_to.as_ref().map(|v| v.join(",")).unwrap_or_default())
    .bind(body.slack_webhook.is_some())
    .bind(body.slack_webhook.clone().flatten())
    .bind(alert_present)
    .bind(alert_value)
    .bind(body.alert_cooldown_min.is_some())
    .bind(body.alert_cooldown_min.flatten().map(|m| m as i32))
    .bind(body.enabled.is_some())
    .bind(body.enabled.unwrap_or(false))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| not_found("Schedule not found"))?;

    // The cron trigger follows the *stored* row, not the patch — v1 reads
    // `updated.enabled/cron/timezone` so a patch that touched neither still
    // re-registers with the current values.
    let enabled: bool = row.try_get("enabled").unwrap_or(false);
    if enabled {
        let cron: String = row.try_get("cron").unwrap_or_default();
        let tz: Option<String> = row.try_get::<Option<String>, _>("timezone").ok().flatten();
        bull::upsert_cron(&id, &cron, tz.as_deref(), bull::wall_clock).await?;
    } else {
        bull::remove_cron(&id).await?;
    }
    Ok(Json(row_dto(&row)))
}

/// DELETE /api/schedules/:id — 204, and the repeatable job goes first. v1's
/// order: if the DB delete failed after the cron was removed the schedule is
/// merely inert; the other way round leaves a worker firing a schedule whose
/// row is gone, which is the failure that pages someone.
async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    assert_can_manage(&state, &user.id, &id).await?;
    bull::remove_cron(&id).await?;
    sqlx::query(r#"DELETE FROM "ScheduledQuery" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/schedules/:id/run — enqueue one ad-hoc execution. 201.
async fn run_now(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    assert_can_manage(&state, &user.id, &id).await?;
    bull::enqueue_exec(&id, bull::wall_clock).await?;
    Ok((StatusCode::CREATED, Json(json!({ "queued": true }))))
}

// ===========================================================================
// mod bull — the BullMQ wire format
// ===========================================================================

/// BullMQ-compatible queue writes.
///
/// Everything here is a reimplementation of what bullmq 5.76.0 does for the
/// three calls `QueuesService` makes, verified by diffing the resulting Redis
/// keyspace against the real client (see the tests). Three things make that
/// possible at all:
///
/// 1. **The msgpack must be byte-identical**, not merely equivalent. The job
///    hash's `opts` field is not the JSON the client sent — it is
///    `cjson.encode(cmsgpack.unpack(ARGV))` computed *inside* Redis, so its key
///    order is Lua's table order, which follows the order the keys were
///    inserted from the packed map. Ship a different map and the worker still
///    reads the job, but the stored `opts` string differs from v1's, which is
///    exactly the kind of drift that is invisible until someone diffs
///    production. msgpackr's framing is not the canonical-minimal one
///    (`rmp-serde` writes `fixmap`; msgpackr always writes `map16`, and any
///    integer ≥ 2^32 as a float64), so the packer below is explicit about every
///    byte and the tests pin the exact hex captured off the wire.
///
/// 2. **The Lua must run the same commands in the same order.** The four
///    scripts below are bullmq's with the branches this call site cannot reach
///    removed. Each removal is justified where it appears; in summary: no job
///    here has a parent (`args[5]`/`args[7]` are always nil), none has a
///    deduplication id (`opts.de` is never set), none is `lifo` or prioritized,
///    and `removeRepeatable`'s legacy half keys off a `""` member of the repeat
///    zset that only pre-3.0.0 bullmq ever created.
///
/// 3. **`meta` must exist.** bullmq's `Queue` constructor HMSETs it on connect;
///    reproduced on first use so a Redis this process reaches before v1 does is
///    still a well-formed bullmq queue.
mod bull {
    use std::sync::{Mutex, OnceLock};

    use redis::aio::ConnectionManager;

    use crate::{ApiError, ApiResult};

    /// v1 `QUEUE_EXEC`.
    const QUEUE: &str = "schedules-exec";
    /// bullmq's default key prefix; v1 never overrides it.
    const PREFIX: &str = "bull";
    /// Must track `backend/node_modules/bullmq`'s version. Only ever read back
    /// by `Queue.getVersion()`, which nothing calls — it is written so a queue
    /// this process creates is indistinguishable from one bullmq created.
    const BULLMQ_VERSION: &str = "bullmq:5.76.0";
    /// bullmq's `Queue.metaValues['opts.maxLenEvents']` default.
    const MAX_LEN_EVENTS: i64 = 10_000;

    fn key(name: &str) -> String {
        format!("{PREFIX}:{QUEUE}:{name}")
    }

    /// bullmq's `queueKeys['']` — the prefix every job key is built from.
    fn base() -> String {
        format!("{PREFIX}:{QUEUE}:")
    }

    /// v1 `QueuesService.repeatKey` — bullmq rejects custom repeat keys
    /// containing `:`, hence the double underscore.
    fn repeat_key(schedule_id: &str) -> String {
        format!("schedule__{schedule_id}")
    }

    /// The clock the handlers use. Split out so the equivalence tests can pin it
    /// to the same instant the Node run was pinned to.
    pub fn wall_clock() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    // -----------------------------------------------------------------------
    // Connection
    // -----------------------------------------------------------------------

    static MANAGER: OnceLock<Mutex<Option<ConnectionManager>>> = OnceLock::new();

    fn cell() -> &'static Mutex<Option<ConnectionManager>> {
        MANAGER.get_or_init(|| Mutex::new(None))
    }

    /// A live connection, opened on first use. `ConnectionManager` reconnects on
    /// its own, so this is opened once per process.
    ///
    /// The lock is a `std::sync::Mutex` and is never held across an `.await`:
    /// the connect happens outside it, and a lost race just drops the extra
    /// manager.
    async fn conn() -> ApiResult<ConnectionManager> {
        if let Some(c) = cell().lock().ok().and_then(|g| g.clone()) {
            return Ok(c);
        }
        let url = super::redis_url()
            .ok_or_else(|| ApiError::internal("REDIS_URL is not configured"))?;
        connect(url).await
    }

    async fn connect(url: &str) -> ApiResult<ConnectionManager> {
        let client = redis::Client::open(url)
            .map_err(|e| ApiError::internal(format!("redis url invalid: {e}")))?;
        let mut m = ConnectionManager::new(client)
            .await
            .map_err(|e| ApiError::internal(format!("redis connect failed: {e}")))?;
        // bullmq's `Queue` constructor: `client.hmset(this.keys.meta, this.metaValues)`.
        redis::cmd("HMSET")
            .arg(key("meta"))
            .arg("opts.maxLenEvents")
            .arg(MAX_LEN_EVENTS)
            .arg("version")
            .arg(BULLMQ_VERSION)
            .query_async::<()>(&mut m)
            .await
            .map_err(|e| ApiError::internal(format!("redis meta write failed: {e}")))?;
        if let Ok(mut g) = cell().lock() {
            if let Some(existing) = g.clone() {
                return Ok(existing);
            }
            *g = Some(m.clone());
        }
        Ok(m)
    }

    // -----------------------------------------------------------------------
    // msgpack — byte-compatible with msgpackr's
    // `Packr({ useRecords: false, encodeUndefinedAsNil: true })`
    // -----------------------------------------------------------------------

    pub enum Mp {
        Nil,
        Str(String),
        Uint(u64),
        Arr(Vec<Mp>),
        /// Key order is significant: it becomes the Lua table insertion order,
        /// which becomes the key order of the `opts` JSON stored on the job.
        Map(Vec<(&'static str, Mp)>),
    }

    impl Mp {
        fn s(v: impl Into<String>) -> Mp {
            Mp::Str(v.into())
        }
        fn opt_s(v: Option<&str>) -> Mp {
            match v {
                Some(x) => Mp::s(x),
                // `undefined` with `encodeUndefinedAsNil` — note the *key* is
                // still emitted; JS object spread keeps keys whose value is
                // undefined, and dropping them would change the map arity.
                None => Mp::Nil,
            }
        }
    }

    pub fn pack(v: &Mp) -> Vec<u8> {
        let mut out = Vec::new();
        write(v, &mut out);
        out
    }

    fn write(v: &Mp, out: &mut Vec<u8>) {
        match v {
            Mp::Nil => out.push(0xc0),
            Mp::Str(s) => {
                let b = s.as_bytes();
                match b.len() {
                    n if n < 32 => out.push(0xa0 | n as u8),
                    n if n < 256 => {
                        out.push(0xd9);
                        out.push(n as u8);
                    }
                    n if n < 65536 => {
                        out.push(0xda);
                        out.extend_from_slice(&(n as u16).to_be_bytes());
                    }
                    n => {
                        out.push(0xdb);
                        out.extend_from_slice(&(n as u32).to_be_bytes());
                    }
                }
                out.extend_from_slice(b);
            }
            // msgpackr's integer ladder. The last rung is the surprising one:
            // anything that does not fit a uint32 is written as a float64, not
            // a uint64. Job timestamps (~1.7e12) always take that branch, and
            // so does any delay over ~49.7 days (e.g. a yearly cron).
            Mp::Uint(n) => {
                let n = *n;
                if n < 128 {
                    out.push(n as u8);
                } else if n < 256 {
                    out.push(0xcc);
                    out.push(n as u8);
                } else if n < 65536 {
                    out.push(0xcd);
                    out.extend_from_slice(&(n as u16).to_be_bytes());
                } else if n <= u32::MAX as u64 {
                    out.push(0xce);
                    out.extend_from_slice(&(n as u32).to_be_bytes());
                } else {
                    out.push(0xcb);
                    out.extend_from_slice(&(n as f64).to_be_bytes());
                }
            }
            Mp::Arr(items) => {
                let n = items.len();
                if n < 16 {
                    out.push(0x90 | n as u8);
                } else {
                    out.push(0xdc);
                    out.extend_from_slice(&(n as u16).to_be_bytes());
                }
                for it in items {
                    write(it, out);
                }
            }
            // msgpackr always emits map16, even for a one-entry map.
            Mp::Map(entries) => {
                out.push(0xde);
                out.extend_from_slice(&(entries.len() as u16).to_be_bytes());
                for (k, v) in entries {
                    write(&Mp::Str((*k).to_string()), out);
                    write(v, out);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Lua
    // -----------------------------------------------------------------------

    /// `removeRepeatable-3.lua`, new-removal half.
    ///
    /// The legacy half is dropped: it runs only when `ZSCORE <repeat> ARGV[2]`
    /// hits, where bullmq passes `''` for a key-based removal
    /// (`removeRepeatableByKey` → `removeRepeatable(legacyId, '', key)` and
    /// `getRepeatConcatOptions` returns the `''` unchanged because our key has
    /// fewer than two colons). No bullmq version ever stores a `""` member in
    /// the repeat zset, so that branch cannot fire — which is also why the
    /// md5-derived `legacyRepeatJobId` it would have used is not computed here.
    ///
    /// KEYS: repeat, delayed, events.  ARGV: repeat job key, key prefix.
    const S_REMOVE_REPEATABLE: &str = r#"
local rcall = redis.call
local millis = rcall("ZSCORE", KEYS[1], ARGV[1])
if millis then
  local repeatJobId = "repeat:" .. ARGV[1] .. ":" .. millis
  if rcall("ZREM", KEYS[2], repeatJobId) == 1 then
    local jobKey = ARGV[2] .. repeatJobId
    rcall("DEL", jobKey, jobKey .. ':logs', jobKey .. ':dependencies',
      jobKey .. ':processed', jobKey .. ':failed', jobKey .. ':unsuccessful')
    rcall("XADD", KEYS[3], "*", "event", "removed", "jobId", repeatJobId, "prev", "delayed")
  end
end
if rcall("ZREM", KEYS[1], ARGV[1]) == 1 then
  rcall("DEL", KEYS[1] .. ":" .. ARGV[1])
  return 0
end
return 1
"#;

    /// `addRepeatableJob-2.lua`, verbatim apart from `removeJob`'s parent and
    /// deduplication legs — a repeatable job created from this call site has
    /// neither a `parentKey` nor a `deid` field, so both reduce to the
    /// `removeJobKeys` DEL that is inlined here.
    ///
    /// KEYS: repeat, delayed.
    /// ARGV: nextMillis, packed opts, legacy custom key, custom key, key prefix.
    const S_ADD_REPEATABLE: &str = r#"
local rcall = redis.call
local repeatKey = KEYS[1]
local delayedKey = KEYS[2]
local nextMillis = ARGV[1]
local legacyCustomKey = ARGV[3]
local customKey = ARGV[4]
local prefixKey = ARGV[5]

local function storeRepeatableJob(repeatKey, customKey, nextMillis, rawOpts)
  rcall("ZADD", repeatKey, nextMillis, customKey)
  local opts = cmsgpack.unpack(rawOpts)
  local optionalValues = {}
  if opts['tz'] then
    table.insert(optionalValues, "tz")
    table.insert(optionalValues, opts['tz'])
  end
  if opts['pattern'] then
    table.insert(optionalValues, "pattern")
    table.insert(optionalValues, opts['pattern'])
  end
  if opts['endDate'] then
    table.insert(optionalValues, "endDate")
    table.insert(optionalValues, opts['endDate'])
  end
  if opts['every'] then
    table.insert(optionalValues, "every")
    table.insert(optionalValues, opts['every'])
  end
  rcall("HMSET", repeatKey .. ":" .. customKey, "name", opts['name'], unpack(optionalValues))
  return customKey
end

local prevMillis = rcall("ZSCORE", repeatKey, customKey)
if prevMillis then
  local delayedJobId = "repeat:" .. customKey .. ":" .. prevMillis
  local nextDelayedJobId = repeatKey .. ":" .. customKey .. ":" .. nextMillis
  if rcall("ZSCORE", delayedKey, delayedJobId) and rcall("EXISTS", nextDelayedJobId) ~= 1 then
    local jobKey = prefixKey .. delayedJobId
    rcall("DEL", jobKey, jobKey .. ':logs', jobKey .. ':dependencies',
      jobKey .. ':processed', jobKey .. ':failed', jobKey .. ':unsuccessful')
    rcall("ZREM", delayedKey, delayedJobId)
  end
end

if rcall("ZSCORE", repeatKey, legacyCustomKey) ~= false then
  return storeRepeatableJob(repeatKey, legacyCustomKey, nextMillis, ARGV[2])
end
return storeRepeatableJob(repeatKey, customKey, nextMillis, ARGV[2])
"#;

    /// `addDelayedJob-6.lua` minus the parent (`args[5]`/`args[7]` are always
    /// nil here) and deduplication (`opts.de` is never set) legs.
    /// `handleDuplicatedJob` is kept: the delayed job id is
    /// `repeat:<key>:<nextMillis>`, and a worker that promotes that job between
    /// the remove and the re-add makes the hash outlive its zset entry, which is
    /// exactly the collision bullmq handles here.
    ///
    /// KEYS: marker, meta, id, delayed, completed, events.
    /// ARGV: packed args, job data JSON, packed opts.
    const S_ADD_DELAYED: &str = r#"
local rcall = redis.call
local metaKey = KEYS[2]
local idKey = KEYS[3]
local delayedKey = KEYS[4]
local eventsKey = KEYS[6]

local args = cmsgpack.unpack(ARGV[1])
local opts = cmsgpack.unpack(ARGV[3])
local repeatJobKey = args[8]

local jobCounter = rcall("INCR", idKey)

local maxEvents = rcall("HGET", metaKey, "opts.maxLenEvents")
if not maxEvents then
  maxEvents = 10000
  rcall("HSET", metaKey, "opts.maxLenEvents", maxEvents)
end

local timestamp = args[4]
local jobId
local jobIdKey
if args[2] == "" then
  jobId = jobCounter
  jobIdKey = args[1] .. jobId
else
  jobId = args[2]
  jobIdKey = args[1] .. jobId
  if rcall("EXISTS", jobIdKey) == 1 then
    rcall("XADD", eventsKey, "MAXLEN", "~", maxEvents, "*", "event", "duplicated", "jobId", jobId)
    return jobId .. ""
  end
end

local jsonOpts = cjson.encode(opts)
local delay = opts['delay'] or 0
local priority = opts['priority'] or 0
local optionalValues = {}
if repeatJobKey then
  table.insert(optionalValues, "rjk")
  table.insert(optionalValues, repeatJobKey)
end
rcall("HMSET", jobIdKey, "name", args[3], "data", ARGV[2], "opts", jsonOpts,
      "timestamp", timestamp, "delay", delay, "priority", priority,
      unpack(optionalValues))
rcall("XADD", eventsKey, "*", "event", "added", "jobId", jobId, "name", args[3])

local delayedTimestamp = (delay > 0 and (tonumber(timestamp) + delay)) or tonumber(timestamp)
local minScore = delayedTimestamp * 0x1000
local maxScore = (delayedTimestamp + 1) * 0x1000 - 1
local score = minScore
local result = rcall("ZREVRANGEBYSCORE", delayedKey, maxScore, minScore, "WITHSCORES", "LIMIT", 0, 1)
local currentMaxScore = tonumber(result[2])
if currentMaxScore ~= nil then
  if currentMaxScore >= maxScore then
    score = maxScore
  else
    score = currentMaxScore + 1
  end
end
rcall("ZADD", delayedKey, score, jobId)
rcall("XADD", eventsKey, "MAXLEN", "~", maxEvents, "*", "event", "delayed",
  "jobId", jobId, "delay", delayedTimestamp)

local nextResult = rcall("ZRANGE", delayedKey, 0, 0, "WITHSCORES")
local nextTimestamp = tonumber(nextResult[2])
if nextTimestamp ~= nil then
  rcall("ZADD", KEYS[1], nextTimestamp / 0x1000, "1")
end

return jobId .. ""
"#;

    /// `addStandardJob-9.lua` minus the same two legs, plus `lifo` (never set,
    /// so the push is always `LPUSH`).
    ///
    /// KEYS: wait, paused, meta, id, completed, delayed, active, events, marker.
    /// ARGV: packed args, job data JSON, packed opts.
    const S_ADD_STANDARD: &str = r#"
local rcall = redis.call
local metaKey = KEYS[3]
local eventsKey = KEYS[8]

local args = cmsgpack.unpack(ARGV[1])
local opts = cmsgpack.unpack(ARGV[3])
local repeatJobKey = args[8]

local jobCounter = rcall("INCR", KEYS[4])

local maxEvents = rcall("HGET", metaKey, "opts.maxLenEvents")
if not maxEvents then
  maxEvents = 10000
  rcall("HSET", metaKey, "opts.maxLenEvents", maxEvents)
end

local timestamp = args[4]
local jobId
local jobIdKey
if args[2] == "" then
  jobId = jobCounter
  jobIdKey = args[1] .. jobId
else
  jobId = args[2]
  jobIdKey = args[1] .. jobId
  if rcall("EXISTS", jobIdKey) == 1 then
    rcall("XADD", eventsKey, "MAXLEN", "~", maxEvents, "*", "event", "duplicated", "jobId", jobId)
    return jobId .. ""
  end
end

local jsonOpts = cjson.encode(opts)
local delay = opts['delay'] or 0
local priority = opts['priority'] or 0
local optionalValues = {}
if repeatJobKey then
  table.insert(optionalValues, "rjk")
  table.insert(optionalValues, repeatJobKey)
end
rcall("HMSET", jobIdKey, "name", args[3], "data", ARGV[2], "opts", jsonOpts,
      "timestamp", timestamp, "delay", delay, "priority", priority,
      unpack(optionalValues))
rcall("XADD", eventsKey, "*", "event", "added", "jobId", jobId, "name", args[3])

local target = KEYS[1]
local isPausedOrMaxed = false
local queueAttributes = rcall("HMGET", metaKey, "paused", "concurrency")
if queueAttributes[1] then
  target = KEYS[2]
  isPausedOrMaxed = true
elseif queueAttributes[2] then
  local activeCount = rcall("LLEN", KEYS[7])
  if activeCount >= tonumber(queueAttributes[2]) then
    isPausedOrMaxed = true
  end
end
rcall("LPUSH", target, jobId)
if not isPausedOrMaxed then
  rcall("ZADD", KEYS[9], 0, "0")
end

rcall("XADD", eventsKey, "MAXLEN", "~", maxEvents, "*", "event", "waiting", "jobId", jobId)

return jobId .. ""
"#;

    /// A cached Lua script, invoked `EVALSHA`-first with an `EVAL` fallback.
    ///
    /// `redis::Script` would do this, but it lives behind the crate's `script`
    /// feature, which this build does not enable — and `Cargo.toml` is not
    /// mine to change. The 20 lines below are that feature, using the `sha1`
    /// crate the TOTP port already pulls in.
    struct LuaScript {
        src: &'static str,
        sha: OnceLock<String>,
    }

    impl LuaScript {
        const fn new(src: &'static str) -> Self {
            LuaScript { src, sha: OnceLock::new() }
        }

        fn sha(&self) -> &str {
            self.sha.get_or_init(|| {
                use sha1::{Digest, Sha1};
                let mut h = Sha1::new();
                h.update(self.src.as_bytes());
                h.finalize().iter().map(|b| format!("{b:02x}")).collect()
            })
        }

        async fn invoke(
            &self,
            c: &mut ConnectionManager,
            keys: &[String],
            args: &[Vec<u8>],
        ) -> Result<redis::Value, redis::RedisError> {
            fn build(head: &str, body: &str, keys: &[String], args: &[Vec<u8>]) -> redis::Cmd {
                let mut cmd = redis::cmd(head);
                cmd.arg(body).arg(keys.len());
                for k in keys {
                    cmd.arg(k.as_bytes());
                }
                for a in args {
                    cmd.arg(a.as_slice());
                }
                cmd
            }
            match build("EVALSHA", self.sha(), keys, args)
                .query_async::<redis::Value>(c)
                .await
            {
                Ok(v) => Ok(v),
                // Cold script cache (fresh Redis, or a `SCRIPT FLUSH`).
                Err(e) if e.kind() == redis::ErrorKind::NoScriptError => {
                    build("EVAL", self.src, keys, args).query_async(c).await
                }
                Err(e) => Err(e),
            }
        }
    }

    static REMOVE_REPEATABLE: LuaScript = LuaScript::new(S_REMOVE_REPEATABLE);
    static ADD_REPEATABLE: LuaScript = LuaScript::new(S_ADD_REPEATABLE);
    static ADD_DELAYED: LuaScript = LuaScript::new(S_ADD_DELAYED);
    static ADD_STANDARD: LuaScript = LuaScript::new(S_ADD_STANDARD);

    fn bytes(s: &str) -> Vec<u8> {
        s.as_bytes().to_vec()
    }

    // -----------------------------------------------------------------------
    // Operations
    // -----------------------------------------------------------------------

    /// v1 `QueuesService.removeCron`.
    ///
    /// v1 lists every repeatable job and removes the ones whose key *or stored
    /// name* is ours, so a legacy entry registered under a hashed member is
    /// still cleaned up. Reproduced rather than shortened to a single
    /// `ZSCORE`, because the whole point of this call is that nothing is left
    /// behind to keep firing.
    pub async fn remove_cron(schedule_id: &str) -> ApiResult<()> {
        let mut c = conn().await?;
        let want = repeat_key(schedule_id);
        let members: Vec<String> = redis::cmd("ZREVRANGE")
            .arg(key("repeat"))
            .arg(0)
            .arg(-1)
            .query_async(&mut c)
            .await
            .map_err(redis_err)?;
        for member in members {
            let stored_name: Option<String> = redis::cmd("HGET")
                .arg(format!("{}:{}", key("repeat"), member))
                .arg("name")
                .query_async(&mut c)
                .await
                .map_err(redis_err)?;
            if member != want && stored_name.as_deref() != Some(want.as_str()) {
                continue;
            }
            REMOVE_REPEATABLE
                .invoke(
                    &mut c,
                    &[key("repeat"), key("delayed"), key("events")],
                    &[bytes(&member), bytes(&base())],
                )
                .await
                .map_err(redis_err)?;
        }
        Ok(())
    }

    /// v1 `QueuesService.upsertCron`: drop any existing registration, compute
    /// the next fire time, store the repeatable definition, and enqueue the
    /// delayed job that actually fires.
    ///
    /// `clock` is called twice, as v1 does (`Date.now()` in
    /// `updateRepeatableJob` for the cron's "current date", then again in
    /// `createNextJob` for the job's timestamp and delay).
    pub async fn upsert_cron(
        schedule_id: &str,
        cron: &str,
        tz: Option<&str>,
        clock: fn() -> i64,
    ) -> ApiResult<()> {
        let mut c = conn().await?;
        let k = repeat_key(schedule_id);

        // `await this.exec.removeRepeatableByKey(key).catch(() => {})` — v1
        // swallows the failure, so a Redis hiccup here must not fail the
        // request either.
        let _ = REMOVE_REPEATABLE
            .invoke(
                &mut c,
                &[key("repeat"), key("delayed"), key("events")],
                &[bytes(&k), bytes(&base())],
            )
            .await;

        let now1 = clock();
        // A pattern cron-parser cannot parse throws out of `Queue.add` in v1 →
        // 500, with the row already written. A pattern it parses but cannot
        // find a next occurrence for yields `undefined`, and v1 silently
        // registers nothing.
        let next = match super::cronparser::next_millis(cron, tz, now1) {
            Err(e) => return Err(ApiError::internal(format!("Internal server error ({e})"))),
            Ok(None) => return Ok(()),
            Ok(Some(n)) => n,
        };

        // `getRepeatConcatOptions(name, repeatOpts)` = `${name}:${jobId}:${endDate}:${tz}:${pattern}`,
        // all empty here except name/tz/pattern. Only used by the backwards
        // compatibility probe inside the script.
        let legacy = format!("{k}:::{}:{cron}", tz.unwrap_or(""));
        let repeat_opts = Mp::Map(vec![
            ("name", Mp::s(&k)),
            ("endDate", Mp::Nil),
            ("tz", Mp::opt_s(tz)),
            ("pattern", Mp::s(cron)),
            ("every", Mp::Nil),
        ]);
        ADD_REPEATABLE
            .invoke(
                &mut c,
                &[key("repeat"), key("delayed")],
                &[
                    bytes(&next.to_string()),
                    pack(&repeat_opts),
                    bytes(&legacy),
                    bytes(&k),
                    bytes(&base()),
                ],
            )
            .await
            .map_err(redis_err)?;

        // `Repeat.createNextJob`
        let now2 = clock();
        let job_id = format!("repeat:{k}:{next}");
        let delay = (next - now2).max(0) as u64;

        // Key order below is `Job`'s: the constructor seeds `{attempts: 0}` and
        // then spreads the merged options over it, so `attempts` leads and
        // `repeatJobKey` is pulled out entirely (it rides in `args[8]` instead).
        let job_opts = Mp::Map(vec![
            ("attempts", Mp::Uint(3)),
            (
                "repeat",
                Mp::Map(vec![
                    ("offset", Mp::Nil),
                    ("pattern", Mp::s(cron)),
                    ("tz", Mp::opt_s(tz)),
                    ("key", Mp::s(&k)),
                    ("count", Mp::Uint(1)),
                ]),
            ),
            ("removeOnComplete", Mp::Map(vec![("count", Mp::Uint(100))])),
            ("removeOnFail", Mp::Map(vec![("count", Mp::Uint(50))])),
            (
                "backoff",
                Mp::Map(vec![
                    ("type", Mp::s("exponential")),
                    ("delay", Mp::Uint(10_000)),
                ]),
            ),
            ("jobId", Mp::s(&job_id)),
            ("delay", Mp::Uint(delay)),
            ("timestamp", Mp::Uint(now2 as u64)),
            ("prevMillis", Mp::Uint(next as u64)),
        ]);
        let args = Mp::Arr(vec![
            Mp::s(base()),
            Mp::s(&job_id),
            Mp::s(&k), // job name
            Mp::Uint(now2 as u64),
            Mp::Nil, // parentKey
            Mp::Nil, // parent dependencies key
            Mp::Nil, // parent
            Mp::s(&k), // repeatJobKey
            Mp::Nil, // deduplication key
        ]);
        let data = serde_json::json!({ "scheduleId": schedule_id }).to_string();

        // `Scripts.addJob` dispatches on the options, and only `delay > 0`
        // reaches the delayed script. A cron whose next fire is the current
        // millisecond is not reachable in practice (the search always advances
        // at least one second) but is routed the way bullmq routes it anyway.
        if delay > 0 {
            ADD_DELAYED
                .invoke(
                    &mut c,
                    &[
                        key("marker"),
                        key("meta"),
                        key("id"),
                        key("delayed"),
                        key("completed"),
                        key("events"),
                    ],
                    &[pack(&args), bytes(&data), pack(&job_opts)],
                )
                .await
                .map_err(redis_err)?;
        } else {
            add_standard(&mut c, &args, &data, &job_opts).await?;
        }
        Ok(())
    }

    /// v1 `QueuesService.enqueueExec` — `Queue.add('manual:<id>', {...}, { attempts: 1 })`.
    pub async fn enqueue_exec(schedule_id: &str, clock: fn() -> i64) -> ApiResult<()> {
        let mut c = conn().await?;
        let now = clock();
        let name = format!("manual:{schedule_id}");
        let args = Mp::Arr(vec![
            Mp::s(base()),
            Mp::s(""), // no custom job id → the script uses the INCR counter
            Mp::s(&name),
            Mp::Uint(now as u64),
            Mp::Nil,
            Mp::Nil,
            Mp::Nil,
            Mp::Nil, // no repeatJobKey → no `rjk` field on the hash
            Mp::Nil,
        ]);
        // `Job`'s constructor seeds `{attempts: 0}`, the caller's `{attempts: 1}`
        // overwrites it in place, and `Backoffs.normalize(undefined)` leaves
        // `backoff` undefined, which `optsAsJSON` drops.
        let opts = Mp::Map(vec![("attempts", Mp::Uint(1))]);
        let data = serde_json::json!({ "scheduleId": schedule_id }).to_string();
        add_standard(&mut c, &args, &data, &opts).await
    }

    async fn add_standard(
        c: &mut ConnectionManager,
        args: &Mp,
        data: &str,
        opts: &Mp,
    ) -> ApiResult<()> {
        ADD_STANDARD
            .invoke(
                c,
                &[
                    key("wait"),
                    key("paused"),
                    key("meta"),
                    key("id"),
                    key("completed"),
                    key("delayed"),
                    key("active"),
                    key("events"),
                    key("marker"),
                ],
                &[pack(args), bytes(data), pack(opts)],
            )
            .await
            .map_err(redis_err)?;
        Ok(())
    }

    fn redis_err(e: redis::RedisError) -> ApiError {
        ApiError::internal(format!("redis command failed: {e}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// The exact bytes captured off ioredis for
        /// `upsertCron('sched1', '*/5 * * * *', 'Asia/Baghdad')` at
        /// `Date.now() === 1754236800000`.
        #[test]
        fn repeat_opts_pack_matches_msgpackr() {
            let v = Mp::Map(vec![
                ("name", Mp::s("schedule__sched1")),
                ("endDate", Mp::Nil),
                ("tz", Mp::opt_s(Some("Asia/Baghdad"))),
                ("pattern", Mp::s("*/5 * * * *")),
                ("every", Mp::Nil),
            ]);
            assert_eq!(
                hex(&pack(&v)),
                "de0005a46e616d65b07363686564756c655f5f736368656431a7656e6444617465c0a2747a\
ac417369612f42616768646164a77061747465726eab2a2f35202a202a202a202aa56576657279c0"
            );
        }

        #[test]
        fn job_args_pack_matches_msgpackr() {
            let v = Mp::Arr(vec![
                Mp::s("bull:schedules-exec:"),
                Mp::s("repeat:schedule__sched1:1754237100000"),
                Mp::s("schedule__sched1"),
                Mp::Uint(1_754_236_800_000),
                Mp::Nil,
                Mp::Nil,
                Mp::Nil,
                Mp::s("schedule__sched1"),
                Mp::Nil,
            ]);
            assert_eq!(
                hex(&pack(&v)),
                "99b462756c6c3a7363686564756c65732d657865633ad9257265706561743a736368656475\
6c655f5f7363686564313a31373534323337313030303030b07363686564756c655f5f736368656431\
cb4279870a94c00000c0c0c0b07363686564756c655f5f736368656431c0"
            );
        }

        #[test]
        fn job_opts_pack_matches_msgpackr() {
            let v = Mp::Map(vec![
                ("attempts", Mp::Uint(3)),
                (
                    "repeat",
                    Mp::Map(vec![
                        ("offset", Mp::Nil),
                        ("pattern", Mp::s("*/5 * * * *")),
                        ("tz", Mp::opt_s(Some("Asia/Baghdad"))),
                        ("key", Mp::s("schedule__sched1")),
                        ("count", Mp::Uint(1)),
                    ]),
                ),
                ("removeOnComplete", Mp::Map(vec![("count", Mp::Uint(100))])),
                ("removeOnFail", Mp::Map(vec![("count", Mp::Uint(50))])),
                (
                    "backoff",
                    Mp::Map(vec![
                        ("type", Mp::s("exponential")),
                        ("delay", Mp::Uint(10_000)),
                    ]),
                ),
                ("jobId", Mp::s("repeat:schedule__sched1:1754237100000")),
                ("delay", Mp::Uint(300_000)),
                ("timestamp", Mp::Uint(1_754_236_800_000)),
                ("prevMillis", Mp::Uint(1_754_237_100_000)),
            ]);
            assert_eq!(
                hex(&pack(&v)),
                "de0009a8617474656d70747303a6726570656174de0005a66f6666736574c0a77061747465\
726eab2a2f35202a202a202a202aa2747aac417369612f42616768646164a36b6579b07363686564756\
c655f5f736368656431a5636f756e7401b072656d6f76654f6e436f6d706c657465de0001a5636f756e7\
464ac72656d6f76654f6e4661696cde0001a5636f756e7432a76261636b6f6666de0002a474797065ab6\
578706f6e656e7469616ca564656c6179cd2710a56a6f624964d9257265706561743a7363686564756c6\
55f5f7363686564313a31373534323337313030303030a564656c6179ce000493e0a974696d657374616\
d70cb4279870a94c00000aa707265764d696c6c6973cb4279870addfe0000"
            );
        }

        #[test]
        fn exec_job_pack_matches_msgpackr() {
            let args = Mp::Arr(vec![
                Mp::s("bull:schedules-exec:"),
                Mp::s(""),
                Mp::s("manual:sched1"),
                Mp::Uint(1_754_236_800_000),
                Mp::Nil,
                Mp::Nil,
                Mp::Nil,
                Mp::Nil,
                Mp::Nil,
            ]);
            assert_eq!(
                hex(&pack(&args)),
                "99b462756c6c3a7363686564756c65732d657865633aa0ad6d616e75616c3a736368656431\
cb4279870a94c00000c0c0c0c0c0"
            );
            let opts = Mp::Map(vec![("attempts", Mp::Uint(1))]);
            assert_eq!(hex(&pack(&opts)), "de0001a8617474656d70747301");
        }

        /// msgpackr's integer ladder, which is not the canonical-minimal one.
        #[test]
        fn integer_widths_match_msgpackr() {
            let cases: [(u64, &str); 10] = [
                (0, "00"),
                (127, "7f"),
                (128, "cc80"),
                (255, "ccff"),
                (256, "cd0100"),
                (65535, "cdffff"),
                (65536, "ce00010000"),
                (4_294_967_295, "ceffffffff"),
                (4_294_967_296, "cb41f0000000000000"),
                (1_754_236_800_000, "cb4279870a94c00000"),
            ];
            for (n, want) in cases {
                assert_eq!(hex(&pack(&Mp::Uint(n))), want, "n = {n}");
            }
        }

        #[test]
        fn string_widths_match_msgpackr() {
            assert_eq!(hex(&pack(&Mp::s(""))), "a0");
            assert_eq!(&hex(&pack(&Mp::s("a".repeat(31))))[..2], "bf");
            assert_eq!(&hex(&pack(&Mp::s("a".repeat(32))))[..4], "d920");
            assert_eq!(&hex(&pack(&Mp::s("a".repeat(255))))[..4], "d9ff");
            assert_eq!(&hex(&pack(&Mp::s("a".repeat(256))))[..6], "da0100");
        }

        fn hex(b: &[u8]) -> String {
            b.iter().map(|x| format!("{x:02x}")).collect()
        }
    }
}

// ===========================================================================
// mod cronparser — a port of cron-parser 4.9.0 (the version bullmq 5.76.0 pins)
// ===========================================================================

/// `parseExpression(pattern, { currentDate, tz }).next().getTime()`.
///
/// Ported rather than delegated to the `cron` crate, which disagrees with
/// cron-parser on things that decide when a customer's job runs: it rejects
/// `0` as a day-of-week (so `0 0 * * 0` — the "every Sunday" preset — will not
/// even parse), it intersects day-of-month with day-of-week where cron's
/// historical semantics (which cron-parser implements) take their union, and it
/// has no `L`. "Handle the divergences" would mean rewriting the field parser
/// and the day-matching rule anyway, so the algorithm below is cron-parser's.
///
/// The date arithmetic is luxon's, because cron-parser 4.9 does its stepping on
/// luxon `DateTime`s and the DST edge cases come straight from luxon's
/// `objToTS` guess-and-correct resolution — including its choice, for a local
/// time that does not exist, of the *smaller* of the two candidate offsets.
mod cronparser {
    use chrono::{Datelike, NaiveDate, NaiveDateTime, TimeZone, Timelike};
    use chrono_tz::Tz;

    /// One parsed field entry. `Str` only ever holds an `L`-bearing token —
    /// cron-parser keeps those unparsed and compares them at match time.
    #[derive(Clone, Debug, PartialEq)]
    enum Val {
        Num(i64),
        Str(String),
    }

    #[derive(Debug)]
    struct Fields {
        second: Vec<Val>,
        minute: Vec<Val>,
        hour: Vec<Val>,
        day_of_month: Vec<Val>,
        month: Vec<Val>,
        day_of_week: Vec<Val>,
    }

    /// `[min, max]` per field, plus the characters the field may carry
    /// unparsed. Index order is cron-parser's `CronExpression.map`.
    const CONSTRAINTS: [(i64, i64, bool); 6] = [
        (0, 59, false), // second
        (0, 59, false), // minute
        (0, 23, false), // hour
        (1, 31, true),  // dayOfMonth  — 'L'
        (1, 12, false), // month
        (0, 7, true),   // dayOfWeek   — 'L'
    ];

    const DAYS_IN_MONTH: [i64; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const DEFAULTS: [&str; 6] = ["0", "*", "*", "*", "*", "*"];

    /// Ok(Some(ms)) — the next fire time.
    /// Ok(None)     — parsed, but `next()` threw (loop limit, or an `L` in a
    ///                day-of-week that has no weekday digit). bullmq catches
    ///                that and registers nothing.
    /// Err(msg)     — a *parse* error, which in v1 escapes `Queue.add` and
    ///                becomes a 500 after the row has already been written.
    pub fn next_millis(pattern: &str, tz: Option<&str>, now_ms: i64) -> Result<Option<i64>, String> {
        let (fields, nth_day_of_week) = parse(pattern)?;
        let zone = zone_for(tz)?;
        Ok(find_next(&fields, nth_day_of_week, zone, now_ms))
    }

    /// cron-parser hands `tz` straight to luxon. An unknown zone makes luxon
    /// produce an invalid DateTime and `new CronDate` throws — a parse-time
    /// failure, so it is an `Err` here too.
    ///
    /// No `tz` means luxon's default zone, i.e. the *process* timezone. Both the
    /// v1 and v2 containers run `TZ` unset on a UTC host (verified), so this
    /// reads `TZ` the way Node does and falls back to UTC.
    fn zone_for(tz: Option<&str>) -> Result<Tz, String> {
        let name = match tz.filter(|s| !s.is_empty()) {
            Some(t) => t.to_string(),
            None => std::env::var("TZ").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "UTC".into()),
        };
        name.parse::<Tz>()
            .map_err(|_| format!("CronDate: unhandled timestamp / invalid zone {name}"))
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    fn parse(expression: &str) -> Result<(Fields, i64), String> {
        let atoms: Vec<&str> = expression.trim().split_whitespace().collect();
        if atoms.len() > 6 {
            return Err("Invalid cron expression".into());
        }
        let start = 6usize.saturating_sub(atoms.len());
        let mut nth_day_of_week = 0i64;
        let mut out: Vec<Vec<Val>> = Vec::with_capacity(6);
        for i in 0..6usize {
            let raw = if i < start { None } else { atoms.get(i - start).copied() };
            let value = match raw {
                Some(v) if !v.is_empty() => v.to_string(),
                _ => DEFAULTS[i].to_string(),
            };
            let value = if i == 5 && raw.is_some() {
                parse_nth_day(&value, &mut nth_day_of_week)?
            } else {
                value
            };
            out.push(parse_field(i, &value)?);
        }
        let mut fields = Fields {
            second: out[0].clone(),
            minute: out[1].clone(),
            hour: out[2].clone(),
            day_of_month: out[3].clone(),
            month: out[4].clone(),
            day_of_week: out[5].clone(),
        };
        // `_handleMaxDaysInMonth`: with exactly one month pinned, a day-of-month
        // the month cannot have is a hard error, and the rest are filtered.
        if fields.month.len() == 1 {
            if let Val::Num(m) = fields.month[0] {
                let dim = DAYS_IN_MONTH[(m - 1).clamp(0, 11) as usize];
                if let Some(Val::Num(first)) = fields.day_of_month.first() {
                    if *first > dim {
                        return Err("Invalid explicit day of month definition".into());
                    }
                }
                let mut kept: Vec<Val> = fields
                    .day_of_month
                    .iter()
                    .filter(|v| match v {
                        Val::Str(_) => true,
                        Val::Num(d) => *d <= dim,
                    })
                    .cloned()
                    .collect();
                sort_vals(&mut kept);
                fields.day_of_month = kept;
            }
        }
        Ok((fields, nth_day_of_week))
    }

    /// `parseNthDay` — pulls `#n` off the day-of-week field.
    fn parse_nth_day(val: &str, nth: &mut i64) -> Result<String, String> {
        let parts: Vec<&str> = val.split('#').collect();
        if parts.len() <= 1 {
            return Ok(val.to_string());
        }
        if val.contains(',') {
            return Err(
                "Constraint error, invalid dayOfWeek `#` and `,` special characters are incompatible"
                    .into(),
            );
        }
        if val.contains('/') {
            return Err(
                "Constraint error, invalid dayOfWeek `#` and `/` special characters are incompatible"
                    .into(),
            );
        }
        if val.contains('-') {
            return Err(
                "Constraint error, invalid dayOfWeek `#` and `-` special characters are incompatible"
                    .into(),
            );
        }
        let n = parts[parts.len() - 1].parse::<i64>().ok();
        match n {
            Some(n) if parts.len() == 2 && (1..=5).contains(&n) => {
                *nth = n;
                Ok(parts[0].to_string())
            }
            _ => Err("Constraint error, invalid dayOfWeek occurrence number (#)".into()),
        }
    }

    /// `_parseField`.
    fn parse_field(idx: usize, value: &str) -> Result<Vec<Val>, String> {
        let (min, max, has_l) = CONSTRAINTS[idx];
        // Alias substitution runs first, and it replaces *every* run of three
        // letters — so "MONDAY" resolves "MON" then dies on "DAY", exactly as
        // the JS regex does.
        let value = if idx == 4 || idx == 5 {
            replace_aliases(value, idx == 4)?
        } else {
            value.to_string()
        };
        if !valid_characters(idx, &value) {
            return Err(format!("Invalid characters, got value: {value}"));
        }
        let value = if value.contains('*') {
            value.replace('*', &format!("{min}-{max}"))
        } else if value.contains('?') {
            value.replace('?', &format!("{min}-{max}"))
        } else {
            value
        };

        let atoms: Vec<&str> = value.split(',').collect();
        if atoms.iter().any(|a| a.is_empty()) {
            return Err("Invalid list value format".into());
        }
        let mut stack: Vec<Val> = Vec::new();
        if atoms.len() > 1 {
            for a in &atoms {
                push_result(parse_repeat(a, idx, min, max)?, idx, min, max, has_l, &mut stack)?;
            }
        } else {
            push_result(parse_repeat(&value, idx, min, max)?, idx, min, max, has_l, &mut stack)?;
        }
        sort_vals(&mut stack);
        Ok(stack)
    }

    /// The result of `parseRepeat`: either a materialised range or a scalar.
    enum Parsed {
        List(Vec<i64>),
        Scalar(String),
        Num(i64),
    }

    /// `handleResult`.
    fn push_result(
        r: Parsed,
        idx: usize,
        min: i64,
        max: i64,
        has_l: bool,
        stack: &mut Vec<Val>,
    ) -> Result<(), String> {
        match r {
            Parsed::List(items) => {
                for v in items {
                    if v < min || v > max {
                        return Err(format!(
                            "Constraint error, got value {v} expected range {min}-{max}"
                        ));
                    }
                    stack.push(Val::Num(v));
                }
            }
            Parsed::Scalar(s) => {
                // `_isValidConstraintChar` — the field allows 'L' and the token
                // carries one, so it survives to match time unparsed.
                if has_l && s.contains('L') {
                    stack.push(Val::Str(s));
                    return Ok(());
                }
                return Err(format!(
                    "Constraint error, got value {s} expected range {min}-{max}"
                ));
            }
            Parsed::Num(mut n) => {
                if n < min || n > max {
                    return Err(format!(
                        "Constraint error, got value {n} expected range {min}-{max}"
                    ));
                }
                // Only the scalar path normalises 7 → 0; a *range* ending at 7
                // is handled inside `parse_range`.
                if idx == 5 {
                    n %= 7;
                }
                stack.push(Val::Num(n));
            }
        }
        Ok(())
    }

    /// `parseRepeat`.
    fn parse_repeat(val: &str, idx: usize, min: i64, max: i64) -> Result<Parsed, String> {
        let atoms: Vec<&str> = val.split('/').collect();
        if atoms.len() > 2 {
            return Err(format!("Invalid repeat: {val}"));
        }
        if atoms.len() > 1 {
            // `atoms[0] == +atoms[0]` — a bare number becomes "n-max".
            let lhs = if atoms[0].parse::<f64>().is_ok() && !atoms[0].is_empty() {
                format!("{}-{max}", atoms[0])
            } else {
                atoms[0].to_string()
            };
            return parse_range(&lhs, atoms[atoms.len() - 1], idx, min, max);
        }
        parse_range(val, "1", idx, min, max)
    }

    /// `parseRange`.
    fn parse_range(
        val: &str,
        repeat_interval: &str,
        idx: usize,
        min_c: i64,
        max_c: i64,
    ) -> Result<Parsed, String> {
        let atoms: Vec<&str> = val.split('-').collect();
        if atoms.len() > 1 {
            if atoms[0].is_empty() {
                if atoms[1].is_empty() {
                    return Err(format!("Invalid range: {val}"));
                }
                return Ok(scalar(val));
            }
            let min = atoms[0].parse::<f64>().ok();
            let max = atoms[1].parse::<f64>().ok();
            let (min, max) = match (min, max) {
                (Some(a), Some(b)) => (a as i64, b as i64),
                _ => {
                    return Err(format!(
                        "Constraint error, got range NaN-NaN expected range {min_c}-{max_c}"
                    ))
                }
            };
            if min < min_c || max > max_c {
                return Err(format!(
                    "Constraint error, got range {min}-{max} expected range {min_c}-{max_c}"
                ));
            }
            if min > max {
                return Err(format!("Invalid range: {val}"));
            }
            let step = match repeat_interval.parse::<f64>() {
                Ok(s) if s > 0.0 => s as i64,
                _ => {
                    return Err(format!(
                        "Constraint error, cannot repeat at every {repeat_interval} time."
                    ))
                }
            };
            let mut stack: Vec<i64> = Vec::new();
            // "0-7" and friends: a day-of-week range whose end is a multiple of
            // 7 gains Sunday-as-0 up front.
            if idx == 5 && max % 7 == 0 {
                stack.push(0);
            }
            let mut repeat_index = step;
            let mut i = min;
            while i <= max {
                let exists = stack.contains(&i);
                if !exists && repeat_index > 0 && repeat_index % step == 0 {
                    repeat_index = 1;
                    stack.push(i);
                } else {
                    repeat_index += 1;
                }
                i += 1;
            }
            return Ok(Parsed::List(stack));
        }
        Ok(scalar(val))
    }

    /// `Number.isNaN(+val) ? val : +val`.
    fn scalar(val: &str) -> Parsed {
        match val.parse::<f64>() {
            Ok(n) if n.is_finite() => Parsed::Num(n as i64),
            _ => Parsed::Scalar(val.to_string()),
        }
    }

    /// `_sortCompareFn`: numbers ascending, then strings.
    fn sort_vals(v: &mut [Val]) {
        v.sort_by(|a, b| match (a, b) {
            (Val::Num(x), Val::Num(y)) => x.cmp(y),
            (Val::Num(_), Val::Str(_)) => std::cmp::Ordering::Less,
            (Val::Str(_), Val::Num(_)) => std::cmp::Ordering::Greater,
            (Val::Str(x), Val::Str(y)) => x.cmp(y),
        });
    }

    fn valid_characters(idx: usize, v: &str) -> bool {
        if v.is_empty() {
            return false;
        }
        v.chars().all(|c| match idx {
            3 => matches!(c, '?' | ',' | '*' | '0'..='9' | 'L' | '/' | '-'),
            5 => matches!(c, '?' | ',' | '*' | '0'..='9' | 'L' | '#' | '/' | '-'),
            _ => matches!(c, ',' | '*' | '0'..='9' | '/' | '-'),
        })
    }

    fn replace_aliases(value: &str, is_month: bool) -> Result<String, String> {
        const MONTHS: [&str; 12] = [
            "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        ];
        const DAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
        let b: Vec<char> = value.chars().collect();
        let mut out = String::new();
        let mut i = 0usize;
        while i < b.len() {
            if i + 2 < b.len() && b[i..i + 3].iter().all(|c| c.is_ascii_alphabetic()) {
                let word: String = b[i..i + 3].iter().collect::<String>().to_lowercase();
                let found = if is_month {
                    MONTHS.iter().position(|m| *m == word).map(|p| p as i64 + 1)
                } else {
                    DAYS.iter().position(|d| *d == word).map(|p| p as i64)
                };
                match found {
                    Some(n) => {
                        out.push_str(&n.to_string());
                        i += 3;
                        continue;
                    }
                    None => {
                        return Err(format!("Validation error, cannot resolve alias \"{word}\""))
                    }
                }
            }
            out.push(b[i]);
            i += 1;
        }
        Ok(out)
    }

    // -----------------------------------------------------------------------
    // luxon-compatible zoned datetime
    // -----------------------------------------------------------------------

    /// A luxon `DateTime`: an instant plus the offset it was resolved with.
    /// Carrying the offset is not redundant — it is the guess luxon feeds into
    /// the next `objToTS`, and it is what makes ambiguous local times resolve
    /// the way luxon resolves them.
    #[derive(Clone, Copy)]
    struct Dt {
        ts: i64,  // epoch millis
        off: i32, // seconds east of UTC
        tz: Tz,
    }

    fn naive_utc(ms: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap_or_else(|| chrono::DateTime::from_timestamp_millis(0).expect("epoch is valid"))
            .naive_utc()
    }

    fn zone_offset(tz: Tz, ts: i64) -> i32 {
        use chrono::Offset;
        tz.offset_from_utc_datetime(&naive_utc(ts)).fix().local_minus_utc()
    }

    /// luxon's `objToTS(obj, guessOffset, zone)`: guess, correct once, and if
    /// the correction disagrees fall back to the *smaller* of the two offsets —
    /// which is what shifts a non-existent local time forward across a
    /// spring-forward gap.
    fn obj_to_ts(local_ms: i64, guess: i32, tz: Tz) -> (i64, i32) {
        let mut ts = local_ms - guess as i64 * 1000;
        let o = zone_offset(tz, ts);
        if o == guess {
            return (ts, o);
        }
        ts -= (o - guess) as i64 * 1000;
        let o2 = zone_offset(tz, ts);
        if o == o2 {
            return (ts, o);
        }
        let m = o.min(o2);
        (local_ms - m as i64 * 1000, m)
    }

    /// `Date.UTC(y, mo - 1, d, h, mi, s, ms)` — every argument may be out of
    /// range and rolls over.
    fn utc_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> i64 {
        let (mut y, mut mo) = (y, mo);
        // Normalise a 1-based month that may sit outside 1..=12.
        let z = mo - 1;
        y += z.div_euclid(12);
        mo = z.rem_euclid(12) + 1;
        let base = NaiveDate::from_ymd_opt(y as i32, mo as u32, 1)
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(1970, 1, 1).expect("epoch is a valid date"));
        let date = base + chrono::Duration::days(d - 1);
        date.and_hms_opt(0, 0, 0)
            .expect("midnight is a valid time")
            .and_utc()
            .timestamp_millis()
            + h * 3_600_000
            + mi * 60_000
            + s * 1_000
            + ms
    }

    fn days_in_month(y: i64, mo: i64) -> i64 {
        let z = mo - 1;
        let y = y + z.div_euclid(12);
        let m = z.rem_euclid(12) + 1;
        match m {
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            4 | 6 | 9 | 11 => 30,
            _ => {
                if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                    29
                } else {
                    28
                }
            }
        }
    }

    impl Dt {
        fn new(ts: i64, tz: Tz) -> Dt {
            Dt { ts, off: zone_offset(tz, ts), tz }
        }
        /// The wall-clock reading in the zone.
        fn local(&self) -> NaiveDateTime {
            naive_utc(self.ts + self.off as i64 * 1000)
        }
        fn month(&self) -> i64 {
            self.local().month() as i64
        }
        fn day(&self) -> i64 {
            self.local().day() as i64
        }
        fn hour(&self) -> i64 {
            self.local().hour() as i64
        }
        fn minute(&self) -> i64 {
            self.local().minute() as i64
        }
        fn second(&self) -> i64 {
            self.local().second() as i64
        }
        fn millis(&self) -> i64 {
            self.ts.rem_euclid(1000)
        }
        /// cron-parser's `getDay()` — luxon 1..7 (Mon..Sun) folded to 0..6 (Sun..Sat).
        fn dow(&self) -> i64 {
            self.local().weekday().num_days_from_sunday() as i64
        }

        fn set_local(&mut self, y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) {
            let (ts, off) = obj_to_ts(utc_ms(y, mo, d, h, mi, s, ms), self.off, self.tz);
            self.ts = ts;
            self.off = off;
        }

        /// luxon `plus({ years, months, days })` — calendar units, day clamped
        /// to the target month before the delta is applied.
        fn plus_cal(&mut self, dy: i64, dmo: i64, dd: i64) {
            let l = self.local();
            let y = l.year() as i64 + dy;
            let mo = l.month() as i64 + dmo;
            let d = (l.day() as i64).min(days_in_month(y, mo)) + dd;
            self.set_local(
                y,
                mo,
                d,
                l.hour() as i64,
                l.minute() as i64,
                l.second() as i64,
                self.millis(),
            );
        }

        /// luxon `plus({ hours | minutes | seconds })` — exact elapsed time.
        fn plus_exact(&mut self, ms: i64) {
            self.ts += ms;
            self.off = zone_offset(self.tz, self.ts);
        }

        fn start_of_month(&mut self) {
            let l = self.local();
            self.set_local(l.year() as i64, l.month() as i64, 1, 0, 0, 0, 0);
        }
        fn start_of_day(&mut self) {
            let l = self.local();
            self.set_local(l.year() as i64, l.month() as i64, l.day() as i64, 0, 0, 0, 0);
        }
        fn start_of_hour(&mut self) {
            let l = self.local();
            self.set_local(
                l.year() as i64,
                l.month() as i64,
                l.day() as i64,
                l.hour() as i64,
                0,
                0,
                0,
            );
        }
        fn start_of_minute(&mut self) {
            let l = self.local();
            self.set_local(
                l.year() as i64,
                l.month() as i64,
                l.day() as i64,
                l.hour() as i64,
                l.minute() as i64,
                0,
                0,
            );
        }
        fn start_of_second(&mut self) {
            let l = self.local();
            self.set_local(
                l.year() as i64,
                l.month() as i64,
                l.day() as i64,
                l.hour() as i64,
                l.minute() as i64,
                l.second() as i64,
                0,
            );
        }

        // CronDate's mutators.
        fn add_month(&mut self) {
            self.plus_cal(0, 1, 0);
            self.start_of_month();
        }
        fn add_day(&mut self) {
            self.plus_cal(0, 0, 1);
            self.start_of_day();
        }
        fn add_hour(&mut self) {
            let prev = self.ts;
            self.plus_exact(3_600_000);
            self.start_of_hour();
            if self.ts <= prev {
                self.plus_exact(3_600_000);
            }
        }
        fn subtract_hour(&mut self) {
            let prev = self.ts;
            self.plus_exact(-3_600_000);
            // `.endOf('hour').startOf('second')` — the last whole second of the
            // previous hour.
            let l = self.local();
            self.set_local(
                l.year() as i64,
                l.month() as i64,
                l.day() as i64,
                l.hour() as i64,
                59,
                59,
                0,
            );
            if self.ts >= prev {
                self.plus_exact(-3_600_000);
            }
        }
        fn add_minute(&mut self) {
            let prev = self.ts;
            self.plus_exact(60_000);
            self.start_of_minute();
            if self.ts < prev {
                self.plus_exact(3_600_000);
            }
        }
        fn add_second(&mut self) {
            let prev = self.ts;
            self.plus_exact(1_000);
            self.start_of_second();
            if self.ts < prev {
                self.plus_exact(3_600_000);
            }
        }

        fn is_last_day_of_month(&self) -> bool {
            let mut n = *self;
            n.plus_cal(0, 0, 1);
            n.start_of_day();
            n.month() != self.month()
        }
        fn is_last_weekday_of_month(&self) -> bool {
            let mut n = *self;
            n.plus_cal(0, 0, 7);
            n.start_of_day();
            n.month() != self.month()
        }
    }

    // -----------------------------------------------------------------------
    // The search
    // -----------------------------------------------------------------------

    /// `matchSchedule(value, sequence)`. String entries sort last and never
    /// satisfy `>=` in JS (the comparison is against NaN), so they are skipped
    /// and only the first element can match on the fallthrough.
    fn match_schedule(value: i64, seq: &[Val]) -> bool {
        for v in seq {
            if let Val::Num(n) = v {
                if *n >= value {
                    return *n == value;
                }
            }
        }
        matches!(seq.first(), Some(Val::Num(n)) if *n == value)
    }

    fn has_l(seq: &[Val]) -> bool {
        seq.iter().any(|v| matches!(v, Val::Str(s) if s.contains('L')))
    }

    /// `isNthDayMatch`.
    fn is_nth_day_match(date: i64, nth: i64) -> bool {
        if nth >= 6 {
            return false;
        }
        if date < 8 && nth == 1 {
            return true;
        }
        let offset = if date % 7 != 0 { 1 } else { 0 };
        let adjusted = date - (date % 7);
        (adjusted / 7) + offset == nth
    }

    /// `isLastWeekdayOfMonthMatch` — `Number.parseInt(expr[0]) % 7`, and a
    /// leading non-digit (a bare `L`) throws, which bullmq catches into "no next
    /// occurrence".
    fn last_weekday_match(seq: &[Val], cur: &Dt) -> Result<bool, ()> {
        let mut any = false;
        for v in seq {
            let Val::Str(s) = v else { continue };
            if !s.contains('L') {
                continue;
            }
            let first = s.chars().next().and_then(|c| c.to_digit(10));
            let Some(d) = first else { return Err(()) };
            let weekday = (d as i64) % 7;
            if cur.dow() == weekday && cur.is_last_weekday_of_month() {
                any = true;
            }
        }
        Ok(any)
    }

    const LOOP_LIMIT: usize = 10_000;

    fn find_next(fields: &Fields, nth_day_of_week: i64, tz: Tz, start_ms: i64) -> Option<i64> {
        let mut cur = Dt::new(start_ms, tz);
        let start_ts = cur.ts;
        let mut dst_start: Option<i64> = None;
        let mut dst_end: Option<i64> = None;
        let hour_is_wildcard = fields.hour.len() == 24;

        // `_applyTimezoneShift` for the calendar units, including its DST-hole
        // rescue when the add lands on the same instant.
        let shift_cal = |cur: &mut Dt, month: bool| {
            let prev = cur.ts;
            if month {
                cur.add_month();
            } else {
                cur.add_day();
            }
            if prev == cur.ts {
                if cur.minute() == 0 && cur.second() == 0 {
                    cur.add_hour();
                } else if cur.minute() == 59 && cur.second() == 59 {
                    cur.subtract_hour();
                }
            }
        };

        for _ in 0..LOOP_LIMIT {
            // Day-of-month / day-of-week are unioned when both are restricted —
            // the historical crontab rule cron-parser implements.
            let mut dom_match = match_schedule(cur.day(), &fields.day_of_month);
            if has_l(&fields.day_of_month) {
                dom_match = dom_match || cur.is_last_day_of_month();
            }
            let mut dow_match = match_schedule(cur.dow(), &fields.day_of_week);
            if has_l(&fields.day_of_week) {
                match last_weekday_match(&fields.day_of_week, &cur) {
                    Ok(m) => dow_match = dow_match || m,
                    // `Invalid last weekday of the month expression` — thrown
                    // inside `next()`, so bullmq registers nothing.
                    Err(()) => return None,
                }
            }
            let dom_wildcard =
                fields.day_of_month.len() as i64 >= DAYS_IN_MONTH[(cur.month() - 1) as usize];
            let dow_wildcard = fields.day_of_week.len() == 8;
            let current_hour = cur.hour();

            if !dom_match && (!dow_match || dow_wildcard) {
                shift_cal(&mut cur, false);
                continue;
            }
            if !dom_wildcard && dow_wildcard && !dom_match {
                shift_cal(&mut cur, false);
                continue;
            }
            if dom_wildcard && !dow_wildcard && !dow_match {
                shift_cal(&mut cur, false);
                continue;
            }
            if nth_day_of_week > 0 && !is_nth_day_match(cur.day(), nth_day_of_week) {
                shift_cal(&mut cur, false);
                continue;
            }
            if !match_schedule(cur.month(), &fields.month) {
                shift_cal(&mut cur, true);
                continue;
            }

            if !match_schedule(current_hour, &fields.hour) {
                if dst_start != Some(current_hour) {
                    dst_start = None;
                    apply_shift_time(&mut cur, Unit::Hour, hour_is_wildcard, &mut dst_start, &mut dst_end);
                    continue;
                } else if !match_schedule(current_hour - 1, &fields.hour) {
                    cur.add_hour();
                    continue;
                }
            } else if dst_end == Some(current_hour) {
                dst_end = None;
                apply_shift_time(&mut cur, Unit::Hour, hour_is_wildcard, &mut dst_start, &mut dst_end);
                continue;
            }

            if !match_schedule(cur.minute(), &fields.minute) {
                apply_shift_time(&mut cur, Unit::Minute, hour_is_wildcard, &mut dst_start, &mut dst_end);
                continue;
            }
            if !match_schedule(cur.second(), &fields.second) {
                apply_shift_time(&mut cur, Unit::Second, hour_is_wildcard, &mut dst_start, &mut dst_end);
                continue;
            }

            // The start instant itself matched — step one second so `next()` is
            // strictly in the future. (cron-parser's `setMilliseconds(0)`
            // alternative is only reachable when stepping backwards, and
            // `next()` never does.)
            if start_ts == cur.ts {
                apply_shift_time(&mut cur, Unit::Second, hour_is_wildcard, &mut dst_start, &mut dst_end);
                continue;
            }
            return Some(cur.ts);
        }
        // 'Invalid expression, loop limit exceeded' — caught by bullmq.
        None
    }

    enum Unit {
        Hour,
        Minute,
        Second,
    }

    /// `_applyTimezoneShift` for the sub-day units: it also detects the two DST
    /// transitions by how the local hour moved, and remembers them so the hour
    /// matcher can let a schedule through on a day the hour it wants does not
    /// exist (spring forward) or exists twice (fall back).
    fn apply_shift_time(
        cur: &mut Dt,
        unit: Unit,
        hour_is_wildcard: bool,
        dst_start: &mut Option<i64>,
        dst_end: &mut Option<i64>,
    ) {
        let previous_hour = cur.hour();
        match unit {
            Unit::Hour => cur.add_hour(),
            Unit::Minute => cur.add_minute(),
            Unit::Second => cur.add_second(),
        }
        let current_hour = cur.hour();
        let diff = current_hour - previous_hour;
        if diff == 2 {
            if !hour_is_wildcard {
                *dst_start = Some(current_hour);
            }
        } else if diff == 0 && cur.minute() == 0 && cur.second() == 0 && !hour_is_wildcard {
            *dst_end = Some(current_hour);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn n(pattern: &str, tz: Option<&str>, now: i64) -> i64 {
            next_millis(pattern, tz, now).expect("parses").expect("has a next")
        }

        #[test]
        fn hourly_utc() {
            // 2025-08-03T16:00:00Z -> 17:00Z
            assert_eq!(n("0 * * * *", None, 1_754_236_800_000), 1_754_240_400_000);
        }

        #[test]
        fn every_five_minutes_is_zone_independent() {
            assert_eq!(
                n("*/5 * * * *", Some("Asia/Baghdad"), 1_754_236_800_000),
                1_754_237_100_000
            );
        }

        #[test]
        fn first_of_month() {
            assert_eq!(n("0 0 1 * *", None, 1_754_236_800_000), 1_756_674_000_000);
        }

        #[test]
        fn sunday_is_both_zero_and_seven() {
            let a = n("0 9 * * 0", None, 1_754_236_800_000);
            let b = n("0 9 * * 7", None, 1_754_236_800_000);
            assert_eq!(a, b);
        }

        #[test]
        fn day_of_month_and_day_of_week_are_unioned() {
            // "30 4 1,15 * 5": the 1st, the 15th, *or* any Friday.
            let ms = n("30 4 1,15 * 5", None, 1_754_236_800_000);
            // 2025-08-08 is the next Friday; 04:30 UTC.
            assert_eq!(ms, 1_754_627_400_000);
        }

        #[test]
        fn month_and_day_aliases_resolve() {
            assert_eq!(
                n("0 0 1 JAN *", None, 1_754_236_800_000),
                n("0 0 1 1 *", None, 1_754_236_800_000)
            );
            assert_eq!(
                n("0 9 * * MON", None, 1_754_236_800_000),
                n("0 9 * * 1", None, 1_754_236_800_000)
            );
        }

        #[test]
        fn unparseable_patterns_are_parse_errors() {
            assert!(next_millis("a b c d e", None, 0).is_err());
            assert!(next_millis("0 0 30 2 *", None, 0).is_err());
            assert!(next_millis("60 * * * *", None, 0).is_err());
        }

        #[test]
        fn bare_l_in_day_of_week_yields_no_next() {
            // cron-parser parses it, then throws inside next(); bullmq swallows
            // that and registers nothing.
            assert_eq!(next_millis("0 0 * * L", None, 1_754_236_800_000), Ok(None));
        }

        #[test]
        fn dst_spring_forward_skips_the_missing_hour() {
            // Europe/Berlin 2026-03-29: 02:00 -> 03:00. A 02:30 daily job runs
            // at 03:30 local that day, i.e. 01:30Z.
            let mar28_12z = 1_774_699_200_000; // 2026-03-28T12:00:00Z
            let ms = n("30 2 * * *", Some("Europe/Berlin"), mar28_12z);
            let dt = chrono::DateTime::from_timestamp_millis(ms).expect("valid instant");
            assert_eq!(dt.to_rfc3339(), "2026-03-29T01:30:00+00:00");
        }
    }
}
