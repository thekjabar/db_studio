//! Instance-admin endpoints — Rust port of v1's `AdminController` +
//! `AdminService` (`backend/src/admin/`) and the admin half of
//! `StatusController` + `StatusService` (`backend/src/status/`, the
//! `@Controller('admin/incidents')` block).
//!
//! Wire-compatible with v1: same paths, same JSON field names, same status
//! codes and the same human error strings, because both stacks are driven by
//! the same frontend (`frontend/src/lib/api.ts` → `adminOverview`,
//! `adminQueryVolume`, `adminTopConnections`, `adminTopUsers`, `adminListUsers`,
//! `adminSetUserAdmin`, `adminListIncidents`, `adminCreateIncident`,
//! `adminAddIncidentUpdate`, `adminDeleteIncident`).
//!
//! ## Access control
//!
//! v1 stacks `JwtAuthGuard` then `AdminGuard` on every route here. `AdminGuard`
//! (`backend/src/auth/guards/admin.guard.ts`) deliberately re-reads
//! `User.isAdmin` from the database on *every* request instead of trusting a
//! JWT claim, so promotion/demotion takes effect immediately and a stolen token
//! can't retain admin after a server-side demotion. `isAdmin` is not a claim in
//! v1's token (`{sub, email, iat, exp}`) and must never become one. `require_admin`
//! below reproduces that lookup verbatim; nothing from the token is trusted
//! beyond the subject id.
//!
//! ## Timestamps
//!
//! Every Prisma `DateTime` maps to `TIMESTAMP(3)` — i.e. `timestamp WITHOUT
//! time zone` — so every read goes through `chrono::NaiveDateTime`. Decoding
//! one as `DateTime<Utc>` fails at runtime and (with `.ok()`) silently nulls the
//! column, so security-relevant columns (`isAdmin`) are read with an explicit
//! typed `try_get` whose error is propagated rather than swallowed.
//!
//! ## Not ported
//!
//! * `GET /metrics` (`MetricsController`, same folder in v1) — it is not
//!   admin-guarded (bearer `METRICS_TOKEN`) and renders v1's in-process
//!   Prometheus registry, which is fed by `metrics.middleware.ts` across the
//!   whole Nest request pipeline. v2 has no such registry; a port would answer
//!   with structurally valid but empty/incorrect counters. Left to the v1 proxy.
//! * `GET /status` (`PublicStatusController`) — public, not admin, and probes
//!   Redis. Left to the v1 proxy.
//! * `admin/compliance` (`ComplianceController`) — a separate v1 module,
//!   outside this port's scope.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/admin/overview", get(overview))
        .route("/api/admin/query-volume", get(query_volume))
        .route("/api/admin/top-connections", get(top_connections))
        .route("/api/admin/top-users", get(top_users))
        .route("/api/admin/users", get(list_users))
        .route("/api/admin/users/:id", patch(set_admin))
        .route("/api/admin/incidents", get(list_incidents).post(create_incident))
        .route("/api/admin/incidents/:id/updates", post(add_incident_update))
        .route("/api/admin/incidents/:id", delete(remove_incident))
}

// ---------------------------------------------------------------------------
// AdminGuard
// ---------------------------------------------------------------------------

/// v1 `AdminGuard.canActivate`: look `User.isAdmin` up by id on every request
/// and 403 `Admin access required` unless it is true. A missing user row is
/// treated exactly as v1's `!row?.isAdmin` — denied.
///
/// The `isAdmin` read is a typed `try_get` with the error propagated: a column
/// type mistake here must fail the request loudly, never decode to a
/// fail-open `false`/`None`.
async fn require_admin(state: &AppState, user_id: &str) -> ApiResult<()> {
    let row = sqlx::query(r#"SELECT "isAdmin" FROM "User" WHERE "id" = $1"#)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let is_admin = match row {
        Some(r) => r.try_get::<bool, _>("isAdmin").map_err(|e| {
            ApiError::internal(format!("admin check failed: {e}"))
        })?,
        None => false,
    };
    if !is_admin {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Admin access required"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `since(ms)` in v1 is `new Date(Date.now() - ms)`, bound by Prisma as a
/// `timestamp` in UTC. The column is `timestamp WITHOUT time zone` holding UTC
/// instants, so the naive-UTC clock reading is the exact equivalent.
fn since_hours(h: i64) -> chrono::NaiveDateTime {
    chrono::Utc::now().naive_utc() - chrono::Duration::hours(h)
}

/// JS `Date.prototype.toISOString()` — millisecond precision, `Z` suffix. Used
/// for values persisted *inside* JSON (incident update timeline entries), where
/// v1's exact string ends up on the public status page.
fn now_iso_ms() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Same rendering as the crate-level `iso()` helper but for a NOT NULL column
/// whose decode failure must surface instead of becoming `null`.
fn iso_req(r: &PgRow, col: &str) -> ApiResult<String> {
    let d: chrono::NaiveDateTime = r
        .try_get(col)
        .map_err(|e| ApiError::internal(format!("bad timestamp in {col}: {e}")))?;
    Ok(d.and_utc().to_rfc3339())
}

/// `parseInt(s, 10)` semantics: optional sign then leading digits, trailing
/// junk ignored. `None` when nothing parses (v1 would hand Prisma a `NaN`;
/// falling back to the route default is the sane equivalent).
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

#[derive(Deserialize)]
struct LimitQuery {
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Deserialize)]
struct UsersQuery {
    #[serde(default)]
    search: Option<String>,
    #[serde(default)]
    limit: Option<String>,
    #[serde(default)]
    cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview
// ---------------------------------------------------------------------------

/// v1 `AdminService.overview()` — ten independent counts issued concurrently.
/// Folded into one round trip here as scalar sub-selects; each sub-select is
/// the literal equivalent of its Prisma `count({ where })`, so the numbers are
/// identical. `activeUsers` is Prisma's `distinct: ['userId']` + `.length`,
/// i.e. `COUNT(DISTINCT "userId")`.
async fn overview(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    let since = since_hours(24);

    let r = sqlx::query(
        r#"SELECT
             (SELECT COUNT(*) FROM "User")::bigint                                    AS users,
             (SELECT COUNT(*) FROM "User" WHERE "isAdmin" = true)::bigint             AS admins,
             (SELECT COUNT(*) FROM "Workspace")::bigint                               AS workspaces,
             (SELECT COUNT(*) FROM "Connection")::bigint                              AS connections,
             (SELECT COUNT(*) FROM "ScheduledQuery" WHERE "enabled" = true)::bigint   AS scheduled,
             (SELECT COUNT(*) FROM "Webhook" WHERE "enabled" = true)::bigint          AS webhooks,
             (SELECT COUNT(*) FROM "ApiKey" WHERE "revokedAt" IS NULL)::bigint        AS api_keys,
             (SELECT COUNT(*) FROM "AuditLog"
                WHERE "action" = 'LOGIN_FAILED' AND "createdAt" >= $1)::bigint        AS failed_logins,
             (SELECT COUNT(*) FROM "AuditLog"
                WHERE "action" = 'SIGNUP' AND "createdAt" >= $1)::bigint              AS signups,
             (SELECT COUNT(DISTINCT "userId") FROM "AuditLog"
                WHERE "createdAt" >= $1 AND "userId" IS NOT NULL)::bigint             AS active_users"#,
    )
    .bind(since)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "users": r.try_get::<i64, _>("users")?,
        "admins": r.try_get::<i64, _>("admins")?,
        "workspaces": r.try_get::<i64, _>("workspaces")?,
        "connections": r.try_get::<i64, _>("connections")?,
        "scheduledQueriesEnabled": r.try_get::<i64, _>("scheduled")?,
        "webhooksEnabled": r.try_get::<i64, _>("webhooks")?,
        "apiKeysActive": r.try_get::<i64, _>("api_keys")?,
        "last24h": {
            "failedLogins": r.try_get::<i64, _>("failed_logins")?,
            "signups": r.try_get::<i64, _>("signups")?,
            "activeUsers": r.try_get::<i64, _>("active_users")?,
        },
    })))
}

// ---------------------------------------------------------------------------
// GET /api/admin/query-volume
// ---------------------------------------------------------------------------

/// v1 `AdminService.queryVolume24h()`. The SQL is v1's raw query verbatim —
/// including the `NOW() - INTERVAL '24 hours'` bound (a timestamptz compared
/// against a timestamp column, resolved in the session time zone; keeping the
/// literal keeps the behaviour identical) — and the fold that collapses the
/// (hour, action) rows into one entry per hour. `ORDER BY 1 ASC` already yields
/// v1's post-fold `localeCompare` ordering, so the first-seen order is kept.
async fn query_volume(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;

    let rows = sqlx::query(
        r#"SELECT date_trunc('hour', "createdAt") AS hour, "action"::text AS action, COUNT(*)::bigint AS count
           FROM "AuditLog"
           WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
             AND "action" IN ('QUERY_RUN', 'SCHEMA_CHANGE')
           GROUP BY 1, 2
           ORDER BY 1 ASC"#,
    )
    .fetch_all(&state.pool)
    .await?;

    // Insertion-ordered accumulation — the equivalent of v1's Map keyed by the
    // ISO hour, which it then sorts ascending (already the SQL order).
    let mut out: Vec<(String, i64, i64)> = Vec::new();
    for r in &rows {
        let hour = iso_req(r, "hour")?;
        let action: String = r.try_get("action")?;
        let count: i64 = r.try_get("count")?;
        let slot = match out.iter_mut().find(|(h, _, _)| *h == hour) {
            Some(s) => s,
            None => {
                out.push((hour, 0, 0));
                out.last_mut().expect("just pushed")
            }
        };
        if action == "QUERY_RUN" {
            slot.1 += count;
        } else {
            slot.2 += count;
        }
    }

    Ok(Json(Value::Array(
        out.into_iter()
            .map(|(hour, queries, schema_changes)| {
                json!({ "hour": hour, "queries": queries, "schemaChanges": schema_changes })
            })
            .collect(),
    )))
}

// ---------------------------------------------------------------------------
// GET /api/admin/top-connections
// ---------------------------------------------------------------------------

/// v1 `AdminService.topConnections7d(limit = 10)` — a Prisma `groupBy` over
/// `AuditLog` (action `QUERY_RUN`, last 7d, non-null `connectionId`) ordered by
/// count desc, then a second lookup that resolves names. Kept as two queries so
/// the aggregate still runs against the audit table alone (v1's "intentionally
/// cheap" contract). `"connectionId" ASC` is appended to the ordering as a
/// deterministic tiebreaker — Prisma emits no tiebreaker, so ties there pick an
/// arbitrary row at the LIMIT boundary.
async fn top_connections(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<LimitQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    let limit = q
        .limit
        .as_deref()
        .and_then(parse_int)
        .unwrap_or(10)
        // Prisma's `take: 0` yields an empty page; `LIMIT 0` does the same.
        // Only a negative value has to be clamped — Postgres rejects it.
        .max(0);

    let rows = sqlx::query(
        r#"SELECT "connectionId", COUNT(*)::bigint AS count
           FROM "AuditLog"
           WHERE "action" = 'QUERY_RUN' AND "createdAt" >= $1 AND "connectionId" IS NOT NULL
           GROUP BY "connectionId"
           ORDER BY COUNT(*) DESC, "connectionId" ASC
           LIMIT $2"#,
    )
    .bind(since_hours(7 * 24))
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let ids: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>("connectionId"))
        .collect::<Result<_, _>>()?;

    let conns = sqlx::query(
        r#"SELECT "id", "name", "dialect"::text AS dialect FROM "Connection" WHERE "id" = ANY($1)"#,
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: String = r.try_get("connectionId")?;
        let hit = conns
            .iter()
            .find(|c| c.try_get::<String, _>("id").map(|x| x == id).unwrap_or(false));
        let (name, dialect) = match hit {
            Some(c) => (
                c.try_get::<String, _>("name")?,
                Some(c.try_get::<String, _>("dialect")?),
            ),
            // v1: `byId.get(id)?.name ?? '(deleted)'` — audit rows outlive the
            // connection (FK is ON DELETE SET NULL only for the column, and the
            // groupBy can still hold ids removed between the two queries).
            None => ("(deleted)".to_string(), None),
        };
        out.push(json!({
            "connectionId": id,
            "name": name,
            "dialect": dialect,
            "queries": r.try_get::<i64, _>("count")?,
        }));
    }
    Ok(Json(Value::Array(out)))
}

// ---------------------------------------------------------------------------
// GET /api/admin/top-users
// ---------------------------------------------------------------------------

/// v1 `AdminService.topUsers7d(limit = 10)`. Same shape as `topConnections7d`.
async fn top_users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<LimitQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;
    let limit = q
        .limit
        .as_deref()
        .and_then(parse_int)
        .unwrap_or(10)
        // Prisma's `take: 0` yields an empty page; `LIMIT 0` does the same.
        // Only a negative value has to be clamped — Postgres rejects it.
        .max(0);

    let rows = sqlx::query(
        r#"SELECT "userId", COUNT(*)::bigint AS count
           FROM "AuditLog"
           WHERE "action" = 'QUERY_RUN' AND "createdAt" >= $1 AND "userId" IS NOT NULL
           GROUP BY "userId"
           ORDER BY COUNT(*) DESC, "userId" ASC
           LIMIT $2"#,
    )
    .bind(since_hours(7 * 24))
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    let ids: Vec<String> = rows
        .iter()
        .map(|r| r.try_get::<String, _>("userId"))
        .collect::<Result<_, _>>()?;

    let users = sqlx::query(
        r#"SELECT "id", "email", "displayName" FROM "User" WHERE "id" = ANY($1)"#,
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id: String = r.try_get("userId")?;
        let hit = users
            .iter()
            .find(|u| u.try_get::<String, _>("id").map(|x| x == id).unwrap_or(false));
        let (email, display_name) = match hit {
            Some(u) => (
                u.try_get::<String, _>("email")?,
                u.try_get::<Option<String>, _>("displayName")?,
            ),
            None => ("(deleted)".to_string(), None),
        };
        out.push(json!({
            "userId": id,
            "email": email,
            "displayName": display_name,
            "queries": r.try_get::<i64, _>("count")?,
        }));
    }
    Ok(Json(Value::Array(out)))
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------

/// v1 `AdminService.listUsers({ search, limit, cursor })`.
///
/// * `take = min(max(limit ?? 50, 1), 200)`, fetch `take + 1` to detect the
///   next page, return `nextCursor` = last returned row's id (key omitted
///   entirely when there is no next page, matching `undefined` in JSON).
/// * `search` is Prisma `contains` + `mode: 'insensitive'` on `email` and
///   `displayName` → `ILIKE '%' || $1 || '%'`. Prisma does not escape `%`/`_`
///   in `contains`, so neither does this.
/// * The cursor is a bare user id (that is what v1 hands out). Prisma's
///   `cursor` + `skip: 1` is reproduced as keyset pagination on
///   `("createdAt","id")`, with the id appended to the ORDER BY as a
///   tiebreaker. v1 orders on `createdAt` alone, whose ties make both the page
///   order and Prisma's cursor arithmetic non-deterministic; identical rows
///   come back whenever `createdAt` is distinct.
async fn list_users(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<UsersQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;

    let requested = q.limit.as_deref().and_then(parse_int).unwrap_or(50);
    let take = requested.max(1).min(200);
    let search = q.search.filter(|s| !s.is_empty());
    let cursor = q.cursor.filter(|s| !s.is_empty());

    let rows = sqlx::query(
        r#"SELECT "id", "email", "displayName", "isAdmin", "emailVerifiedAt",
                  "oauthProvider", "createdAt"
           FROM "User"
           WHERE ($1::text IS NULL
                  OR "email" ILIKE '%' || $1::text || '%'
                  OR "displayName" ILIKE '%' || $1::text || '%')
             AND ($2::text IS NULL
                  OR ("createdAt", "id")
                     < ((SELECT "createdAt" FROM "User" WHERE "id" = $2::text), $2::text))
           ORDER BY "createdAt" DESC, "id" DESC
           LIMIT $3"#,
    )
    .bind(&search)
    .bind(&cursor)
    .bind(take + 1)
    .fetch_all(&state.pool)
    .await?;

    let has_more = (rows.len() as i64) > take;
    let items_rows = if has_more { &rows[..take as usize] } else { &rows[..] };

    let mut items = Vec::with_capacity(items_rows.len());
    for r in items_rows {
        items.push(json!({
            "id": r.try_get::<String, _>("id")?,
            "email": r.try_get::<String, _>("email")?,
            "displayName": r.try_get::<Option<String>, _>("displayName")?,
            // Security-relevant: a decode failure must surface, never fall back
            // to `false` (which would silently mislabel admins in the UI).
            "isAdmin": r.try_get::<bool, _>("isAdmin").map_err(|e| {
                ApiError::internal(format!("bad isAdmin column: {e}"))
            })?,
            "emailVerifiedAt": iso(r, "emailVerifiedAt"),
            "oauthProvider": r.try_get::<Option<String>, _>("oauthProvider")?,
            "createdAt": iso_req(r, "createdAt")?,
        }));
    }

    let mut out = json!({ "items": items });
    if has_more {
        if let Some(last) = items.last() {
            out["nextCursor"] = last["id"].clone();
        }
    }
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/:id
// ---------------------------------------------------------------------------

/// v1 `AdminController.setAdmin` + `AdminService.setAdmin`.
///
/// Order of checks mirrors Nest: the `ValidationPipe` rejects a non-boolean
/// `isAdmin` (400) before the handler body runs, then the self-demotion guard
/// (403), then the update.
async fn set_admin(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;

    // `@IsBoolean()` under `transformOptions: { enableImplicitConversion: true }`
    // — a real JSON boolean, or the strings "true"/"false".
    let is_admin = match body.get("isAdmin") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) if s == "true" => true,
        Some(Value::String(s)) if s == "false" => false,
        _ => return Err(ApiError::bad("isAdmin must be a boolean value")),
    };

    // The overview UI hides this too, but an empty admin set bricks /admin, so
    // the server refuses as well. v1's message is intentionally verbatim.
    if user.id == id && !is_admin {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "You can't demote yourself while you're the only admin",
        ));
    }

    let row = sqlx::query(
        r#"UPDATE "User" SET "isAdmin" = $2, "updatedAt" = now()
           WHERE "id" = $1
           RETURNING "id", "email", "isAdmin""#,
    )
    .bind(&id)
    .bind(is_admin)
    .fetch_optional(&state.pool)
    .await?;

    // v1 lets Prisma's P2025 escape into the global filter (a 500). 404 is the
    // honest status for "no such user" and is the one deliberate deviation here.
    let row = row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User not found"))?;

    Ok(Json(json!({
        "id": row.try_get::<String, _>("id")?,
        "email": row.try_get::<String, _>("email")?,
        "isAdmin": row.try_get::<bool, _>("isAdmin")?,
    })))
}

// ---------------------------------------------------------------------------
// Incidents — v1 `IncidentsAdminController` + `StatusService` (admin half)
// ---------------------------------------------------------------------------

/// Always selected through the `i` alias so the `LEFT JOIN "User"` in `list`
/// can't make `"id"`/`"email"`/`"createdAt"` ambiguous.
const INCIDENT_COLS: &str = r#"i."id", i."title", i."status"::text AS status, i."severity"::text AS severity,
    i."impact", i."updates", i."startedAt", i."resolvedAt", i."createdById", i."createdAt", i."updatedAt""#;

fn incident_dto(r: &PgRow) -> ApiResult<Value> {
    Ok(json!({
        "id": r.try_get::<String, _>("id")?,
        "title": r.try_get::<String, _>("title")?,
        "status": r.try_get::<String, _>("status")?,
        "severity": r.try_get::<String, _>("severity")?,
        "impact": r.try_get::<Option<String>, _>("impact")?,
        "updates": r.try_get::<Value, _>("updates")?,
        "startedAt": iso_req(r, "startedAt")?,
        "resolvedAt": iso(r, "resolvedAt"),
        "createdById": r.try_get::<Option<String>, _>("createdById")?,
        "createdAt": iso_req(r, "createdAt")?,
        "updatedAt": iso_req(r, "updatedAt")?,
    }))
}

/// class-validator `@IsString()` + `@Length(min, max)`, with the same message
/// text the frontend surfaces today.
fn validated_str(body: &Value, field: &str, min: usize, max: usize) -> ApiResult<String> {
    let v = match body.get(field) {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(ApiError::bad(format!("{field} must be a string"))),
    };
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

fn validated_enum(body: &Value, field: &str, allowed: &[&str]) -> ApiResult<Option<String>> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if allowed.contains(&s.as_str()) => Ok(Some(s.clone())),
        _ => Err(ApiError::bad(format!(
            "{field} must be one of the following values: {}",
            allowed.join(", ")
        ))),
    }
}

const SEVERITIES: [&str; 3] = ["MINOR", "MAJOR", "CRITICAL"];
const STATUSES: [&str; 4] = ["INVESTIGATING", "IDENTIFIED", "MONITORING", "RESOLVED"];

/// v1 `StatusService.list()` — newest first, capped at 100, with the author
/// joined in (`include: { createdBy: { select: { email, displayName } } }`,
/// which is `null` when `createdById` is null or the user was deleted).
/// `"id" DESC` is appended purely as a tiebreaker for identical `startedAt`.
async fn list_incidents(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;

    let rows = sqlx::query(&format!(
        r#"SELECT {INCIDENT_COLS},
                  u."email" AS creator_email, u."displayName" AS creator_display_name,
                  (u."id" IS NOT NULL) AS has_creator
           FROM "Incident" i
           LEFT JOIN "User" u ON u."id" = i."createdById"
           ORDER BY i."startedAt" DESC, i."id" DESC
           LIMIT 100"#
    ))
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let mut dto = incident_dto(r)?;
        dto["createdBy"] = if r.try_get::<bool, _>("has_creator")? {
            json!({
                "email": r.try_get::<String, _>("creator_email")?,
                "displayName": r.try_get::<Option<String>, _>("creator_display_name")?,
            })
        } else {
            Value::Null
        };
        out.push(dto);
    }
    Ok(Json(Value::Array(out)))
}

/// v1 `StatusService.create()`. Nest's default POST status (201) applies — the
/// controller carries no `@HttpCode`. The seed update entry is written with the
/// same `{ at, status, message }` shape the public status page renders, with
/// `at` in `toISOString()` form.
async fn create_incident(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_admin(&state, &user.id).await?;

    let title = validated_str(&body, "title", 1, 200)?;
    let message = validated_str(&body, "message", 1, 2000)?;
    let severity = validated_enum(&body, "severity", &SEVERITIES)?;
    let impact = match body.get("impact") {
        None | Some(Value::Null) => None,
        Some(_) => Some(validated_str(&body, "impact", 0, 500)?),
    };

    // Service-level guards run after the DTO validation, exactly as in v1.
    if title.trim().is_empty() {
        return Err(ApiError::bad("Title required"));
    }
    if message.trim().is_empty() {
        return Err(ApiError::bad("Initial update message required"));
    }

    let first_update = json!([{
        "at": now_iso_ms(),
        "status": "INVESTIGATING",
        "message": truncate(&message, 2000),
    }]);

    let row = sqlx::query(&format!(
        r#"INSERT INTO "Incident" AS i
             ("id","title","status","severity","impact","updates","startedAt","createdById","createdAt","updatedAt")
           VALUES ($1,$2,'INVESTIGATING',$3::"IncidentSeverity",$4,$5::jsonb,now(),$6,now(),now())
           RETURNING {INCIDENT_COLS}"#
    ))
    // Prisma generates `@default(cuid())` client-side; the column has no DB default.
    .bind(gen_id())
    .bind(truncate(&title, 200))
    .bind(severity.unwrap_or_else(|| "MINOR".to_string()))
    .bind(impact.as_ref().map(|s| truncate(s, 500)))
    .bind(first_update)
    .bind(&user.id)
    .fetch_one(&state.pool)
    .await?;

    Ok((StatusCode::CREATED, Json(incident_dto(&row)?)))
}

/// v1 `StatusService.addUpdate()` — appends to the `updates` timeline, moves
/// `status`, and stamps `resolvedAt` the first time the incident reaches
/// RESOLVED. `@HttpCode(200)` on the route, so 200 (not Nest's POST default).
async fn add_incident_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &user.id).await?;

    let status = validated_enum(&body, "status", &STATUSES)?.ok_or_else(|| {
        ApiError::bad(format!(
            "status must be one of the following values: {}",
            STATUSES.join(", ")
        ))
    })?;
    let message = validated_str(&body, "message", 1, 2000)?;
    if message.trim().is_empty() {
        return Err(ApiError::bad("Message required"));
    }

    let existing = sqlx::query(r#"SELECT "updates", "resolvedAt" FROM "Incident" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    let mut updates = match existing.try_get::<Value, _>("updates")? {
        Value::Array(a) => a,
        // `updates` is NOT NULL DEFAULT '[]', but v1 still tolerates a
        // non-array with `?? []`.
        _ => Vec::new(),
    };
    updates.push(json!({
        "at": now_iso_ms(),
        "status": status,
        "message": truncate(&message, 2000),
    }));

    let already_resolved = existing
        .try_get::<Option<chrono::NaiveDateTime>, _>("resolvedAt")?
        .is_some();
    let set_resolved = status == "RESOLVED" && !already_resolved;

    let row = sqlx::query(&format!(
        r#"UPDATE "Incident" AS i
           SET "status" = $2::"IncidentStatus",
               "updates" = $3::jsonb,
               "resolvedAt" = CASE WHEN $4::boolean THEN now() ELSE i."resolvedAt" END,
               "updatedAt" = now()
           WHERE i."id" = $1
           RETURNING {INCIDENT_COLS}"#
    ))
    .bind(&id)
    .bind(&status)
    .bind(Value::Array(updates))
    .bind(set_resolved)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    Ok(Json(incident_dto(&row)?))
}

/// v1 `StatusService.remove()` — 404 when absent, `@HttpCode(204)` otherwise.
async fn remove_incident(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    require_admin(&state, &user.id).await?;

    let done = sqlx::query(r#"DELETE FROM "Incident" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// JS `String.prototype.slice(0, n)` operates on UTF-16 code units; chars are
/// close enough here and never split a code point.
fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
