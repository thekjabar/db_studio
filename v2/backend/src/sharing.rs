//! Sharing + governance — Rust port of four small v1 NestJS modules:
//!
//!   backend/src/shared-query/{shared-query.controller.ts, shared-query.service.ts}
//!   backend/src/query-review/{query-review.controller.ts, query-review.service.ts}
//!   backend/src/slow-query/{slow-query.controller.ts,  slow-query.service.ts}
//!   backend/src/schema-docs/{schema-docs.controller.ts, schema-docs.service.ts}
//!
//! Wire-compatible with them: same paths, methods, status codes, error messages
//! and JSON field names. All four models live in the *app* database, so this is
//! app-DB CRUD only — no target-database access.
//!
//! Schema notes (there is no `@map` anywhere in the Prisma schema):
//!   * every table/column is the quoted PascalCase / camelCase identifier Prisma
//!     created (`"SharedQuery"."createdById"`, …);
//!   * every `DateTime` is `TIMESTAMP(3)` *without* time zone → it decodes as
//!     `chrono::NaiveDateTime`, never `DateTime<Utc>`;
//!   * `@default(cuid())` is generated client-side, so `"id"` has no database
//!     default and every INSERT must supply `crate::gen_id()`;
//!   * `@updatedAt` is also client-side (`"updatedAt"` is NOT NULL with no
//!     default) → every INSERT/UPDATE writes it explicitly.
//!
//! Two POSTs are deliberately NOT served here and fall through to the v1 proxy
//! (`crate::proxy` registered as the method handler so they don't 405):
//! creating a share and submitting a review request. Both run v1's
//! `SqlClassifierService`, which is a full `node-sql-parser` AST classification —
//! v2 has no SQL parser crate and a keyword heuristic would disagree with v1 on
//! exactly the statements the gate exists for. `POST /public/shared-queries/
//! /:token/run` is likewise left to v1: it executes the frozen SQL against the
//! target database through a VIEWER-role driver carrying the *sharer's* row
//! filters and column masks, machinery that lives only in the Node backend.

use std::collections::HashSet;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

/// Every route the four controllers expose, at its full v1 path (the Nest app
/// sets a global `api` prefix, so `@Controller('connections/:id/shared-queries')`
/// serves `/api/connections/:id/shared-queries`).
pub fn routes() -> Router<AppState> {
    Router::new()
        // --- shared queries (SharedQueryController, JwtAuthGuard) ---
        // POST → v1: create runs the SQL classifier (see the module header).
        .route(
            "/api/connections/:id/shared-queries",
            get(shares_list).post(crate::proxy),
        )
        .route(
            "/api/connections/:id/shared-queries/:shareId",
            delete(share_revoke),
        )
        // --- public share (PublicSharedQueryController: @Public, no JWT) ---
        // `…/:token/run` is not registered → it hits the strangler fallback.
        .route("/api/public/shared-queries/:token", get(public_share_meta))
        // --- query review (QueryReviewController, JwtAuthGuard) ---
        // POST → v1: submit stores the classifier's verdict.
        .route(
            "/api/connections/:id/review-requests",
            get(reviews_list).post(crate::proxy),
        )
        // Must stay a distinct route from `:reviewId` below; matchit gives the
        // static segment priority, so `/review-requests/inbox` never falls into it.
        .route("/api/review-requests/inbox", get(reviews_inbox))
        .route("/api/review-requests/:reviewId/approve", post(review_approve))
        .route("/api/review-requests/:reviewId/reject", post(review_reject))
        // --- slow queries (SlowQueryController, JwtAuthGuard + RbacGuard) ---
        .route("/api/connections/:id/slow-queries", get(slow_list))
        .route("/api/connections/:id/slow-queries/:hash/runs", get(slow_runs))
        // --- schema docs (SchemaDocsController, JwtAuthGuard) ---
        .route(
            "/api/connections/:id/schema-docs",
            get(docs_list).post(docs_upsert),
        )
        .route("/api/connections/:id/schema-docs/:docId", delete(docs_delete))
}

// ---------------------------------------------------------------------------
// Shared helpers
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

/// v1 `RbacService.require`: no role at all → 404 when the connection itself is
/// gone, else 403; too low a role → 403 naming both the required and held role.
/// `crate::conn_role` already reproduces `effectiveRole`'s precedence
/// (connection owner → ConnectionMember grant → WorkspaceMember).
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match crate::conn_role(&state.pool, conn_id, user_id).await? {
        None => {
            // v1 re-checks existence so a bad id reads as 404, not 403.
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                    .bind(conn_id)
                    .fetch_optional(&state.pool)
                    .await?;
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

fn text(r: &PgRow, col: &str) -> String {
    r.try_get::<String, _>(col).unwrap_or_default()
}

fn opt_text(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(col).unwrap_or(None)
}

fn opt_int(r: &PgRow, col: &str) -> Option<i32> {
    r.try_get::<Option<i32>, _>(col).unwrap_or(None)
}

/// `{ email, displayName }` for a relation Prisma selects with exactly those two
/// fields. `"User"."email"` is NOT NULL, so a NULL here means the LEFT JOIN
/// found no row → v1 serialises the relation as `null`.
fn user_contact(r: &PgRow, email_col: &str, name_col: &str) -> Value {
    match opt_text(r, email_col) {
        Some(email) => json!({ "email": email, "displayName": opt_text(r, name_col) }),
        None => Value::Null,
    }
}

/// `{ id, email, displayName }`, the shape v1 selects for requester/reviewer.
fn user_ref(r: &PgRow, id_col: &str, email_col: &str, name_col: &str) -> Value {
    match opt_text(r, id_col) {
        Some(id) => json!({
            "id": id,
            "email": text(r, email_col),
            "displayName": opt_text(r, name_col),
        }),
        None => Value::Null,
    }
}

/// `crate::iso` for a value already in hand (used where the timestamp is read
/// out separately so a decode failure can be propagated instead of swallowed).
fn iso_dt(d: chrono::NaiveDateTime) -> String {
    d.and_utc().to_rfc3339()
}

/// JS `s.slice(0, max)`. Rust slices by chars where JS slices by UTF-16 code
/// units; identical for everything short of astral-plane text, and never panics
/// mid-codepoint the way byte slicing would.
fn cap(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// JS `parseInt(s, 10)`: optional leading whitespace, optional sign, then the
/// leading run of digits; anything else is NaN (`None` here). Values too large
/// for `i64` saturate — every caller clamps immediately afterwards, so the exact
/// magnitude of an absurd input never reaches SQL.
fn parse_int_js(s: &str) -> Option<i64> {
    let t = s.trim_start();
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let n = digits.parse::<i64>().unwrap_or(i64::MAX);
    Some(if neg { -n } else { n })
}

/// `parseInt(raw ?? String(default), 10) || default` — note the `||`, so both
/// NaN *and* a parsed `0` fall back to the default.
fn int_param(raw: Option<&str>, default: i64) -> i64 {
    match raw {
        None => default,
        Some(s) => parse_int_js(s).filter(|v| *v != 0).unwrap_or(default),
    }
}

// ---------------------------------------------------------------------------
// Shared queries — /api/connections/:id/shared-queries
// ---------------------------------------------------------------------------

/// `SharedQueryService.listForConnection` — every share on the connection,
/// newest first. VIEWER: anyone who can read the connection can see what has
/// been shared from it (and, with the token, open it).
async fn shares_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(
        r#"SELECT s."id", s."token", s."title", s."sqlText", s."expiresAt", s."viewCount",
                  s."createdAt",
                  u."email" AS "cbEmail", u."displayName" AS "cbDisplayName"
             FROM "SharedQuery" s
             JOIN "User" u ON u."id" = s."createdById"
            WHERE s."connectionId" = $1
            ORDER BY s."createdAt" DESC, s."id" ASC"#, // id tiebreaker = stable order
    )
    .bind(&conn_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": text(r, "id"),
                    "token": text(r, "token"),
                    "title": opt_text(r, "title"),
                    "sqlText": text(r, "sqlText"),
                    "expiresAt": iso(r, "expiresAt"),
                    "viewCount": r.try_get::<i32, _>("viewCount").unwrap_or(0),
                    "createdAt": iso(r, "createdAt"),
                    "createdBy": user_contact(r, "cbEmail", "cbDisplayName"),
                })
            })
            .collect(),
    )))
}

/// `SharedQueryService.revoke` — the creator, or an OWNER on the share's own
/// connection.
///
/// v1 quirk reproduced deliberately: the controller takes only `:shareId` and
/// never passes the `:id` connection segment to the service, which looks the row
/// up by primary key and then authorises against the row's *own* `connectionId`.
/// Adding the path connection to the WHERE would 404 requests v1 serves. There
/// is no leak in it — a foreign share id still has to survive the OWNER check on
/// the connection that share actually belongs to.
async fn share_revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path((_conn_id, share_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let row = sqlx::query(r#"SELECT "connectionId", "createdById" FROM "SharedQuery" WHERE "id" = $1"#)
        .bind(&share_id)
        .fetch_optional(&state.pool)
        .await?
        // v1 throws a bare `new NotFoundException()` → message "Not Found".
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    // SECURITY: ownership decides the whole check — never `.ok().flatten()` it.
    let created_by: String = row.try_get("createdById")?;
    let share_conn: String = row.try_get("connectionId")?;
    if created_by != user.id {
        require_role(&state, &share_conn, &user.id, "OWNER").await?;
    }
    sqlx::query(r#"DELETE FROM "SharedQuery" WHERE "id" = $1"#)
        .bind(&share_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// `SharedQueryService.getPublicMeta` — unauthenticated. Metadata only, no
/// execution: enough to render the public page shell before the viewer hits Run.
async fn public_share_meta(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = sqlx::query(
        r#"SELECT s."title", s."sqlText", s."expiresAt", s."rowLimit",
                  c."name" AS "connectionName", c."dialect"::text AS "dialect"
             FROM "SharedQuery" s
             JOIN "Connection" c ON c."id" = s."connectionId"
            WHERE s."token" = $1"#,
    )
    .bind(&token)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Share not found"))?;

    // SECURITY: expiry is the only thing gating an unauthenticated read, so a
    // decode failure must surface as an error — swallowing it into `None` would
    // silently turn every expired share back into a live one.
    let expires: Option<chrono::NaiveDateTime> = r.try_get("expiresAt")?;
    if let Some(exp) = expires {
        // The column is `timestamp WITHOUT time zone` holding a UTC instant, so
        // compare against UTC-now rather than letting Postgres apply a session
        // time zone to the cast.
        if exp < chrono::Utc::now().naive_utc() {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "This shared link has expired.",
            ));
        }
    }
    Ok(Json(json!({
        "title": opt_text(&r, "title"),
        "sqlText": text(&r, "sqlText"),
        "expiresAt": expires.map(iso_dt),
        "rowLimit": r.try_get::<i32, _>("rowLimit").unwrap_or(1000),
        "connectionName": text(&r, "connectionName"),
        "dialect": text(&r, "dialect"),
    })))
}

// ---------------------------------------------------------------------------
// Query review — /api/connections/:id/review-requests, /api/review-requests/*
// ---------------------------------------------------------------------------

/// Every scalar column of `QueryReviewRequest`, aliased `r`. The Postgres enum
/// is read as text so it needs no client-side enum type.
const REVIEW_COLS: &str = r#"r."id", r."connectionId", r."requesterId", r."reviewerId",
        r."sqlText", r."classification", r."reason", r."reviewComment",
        r."status"::text AS "status", r."approvedAt", r."executedAt",
        r."executedRowsAffected", r."createdAt", r."updatedAt""#;

/// Same list for a bare `RETURNING` (no table alias).
const REVIEW_COLS_BARE: &str = r#""id", "connectionId", "requesterId", "reviewerId",
        "sqlText", "classification", "reason", "reviewComment",
        "status"::text AS "status", "approvedAt", "executedAt",
        "executedRowsAffected", "createdAt", "updatedAt""#;

/// Key order mirrors the Prisma model so the JSON is comparable with v1's.
fn review_dto(r: &PgRow) -> Value {
    json!({
        "id": text(r, "id"),
        "connectionId": text(r, "connectionId"),
        "requesterId": text(r, "requesterId"),
        "reviewerId": opt_text(r, "reviewerId"),
        "sqlText": text(r, "sqlText"),
        "classification": text(r, "classification"),
        "reason": opt_text(r, "reason"),
        "reviewComment": opt_text(r, "reviewComment"),
        "status": text(r, "status"),
        "approvedAt": iso(r, "approvedAt"),
        "executedAt": iso(r, "executedAt"),
        "executedRowsAffected": opt_int(r, "executedRowsAffected"),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

#[derive(Deserialize)]
struct StatusQ {
    #[serde(default)]
    status: Option<String>,
}

/// `QueryReviewService.list` — the connection's requests, newest first, capped
/// at 200. VIEWER, so the whole team can see what is queued for approval.
///
/// v1 drops `?status=` straight into Prisma's `where`, which throws (500) on a
/// value outside the enum; comparing as text instead returns an empty list. No
/// caller sends an invalid status.
async fn reviews_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
    Query(q): Query<StatusQ>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {REVIEW_COLS},
                  rq."id" AS "rqId", rq."email" AS "rqEmail", rq."displayName" AS "rqDisplayName",
                  rv."id" AS "rvId", rv."email" AS "rvEmail", rv."displayName" AS "rvDisplayName"
             FROM "QueryReviewRequest" r
             JOIN "User" rq ON rq."id" = r."requesterId"
             LEFT JOIN "User" rv ON rv."id" = r."reviewerId"
            WHERE r."connectionId" = $1
              AND ($2::text IS NULL OR r."status"::text = $2)
            ORDER BY r."createdAt" DESC, r."id" ASC
            LIMIT 200"#
    ))
    .bind(&conn_id)
    // v1 passes `status ? { status } : {}` — "" means "no filter".
    .bind(q.status.filter(|s| !s.is_empty()))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                let mut v = review_dto(r);
                v["requester"] = user_ref(r, "rqId", "rqEmail", "rqDisplayName");
                v["reviewer"] = user_ref(r, "rvId", "rvEmail", "rvDisplayName");
                v
            })
            .collect(),
    )))
}

/// `QueryReviewService.pendingMine` — the top-bar inbox: PENDING requests on
/// connections the caller owns, oldest first, capped at 100.
///
/// The membership test is deliberately narrower than `crate::conn_role`: v1 asks
/// for `connection.ownerId = me` OR a `ConnectionMember` row with role OWNER. A
/// workspace-level OWNER is NOT included, so this reproduces that exactly rather
/// than reusing the effective-role helper.
async fn reviews_inbox(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT {REVIEW_COLS},
                  c."id" AS "connId", c."name" AS "connName", c."dialect"::text AS "connDialect",
                  rq."id" AS "rqId", rq."email" AS "rqEmail", rq."displayName" AS "rqDisplayName"
             FROM "QueryReviewRequest" r
             JOIN "Connection" c ON c."id" = r."connectionId"
             JOIN "User" rq ON rq."id" = r."requesterId"
            WHERE r."status"::text = 'PENDING'
              AND (
                c."ownerId" = $1
                OR EXISTS (SELECT 1 FROM "ConnectionMember" m
                            WHERE m."connectionId" = c."id"
                              AND m."userId" = $1
                              AND m."role"::text = 'OWNER')
              )
            ORDER BY r."createdAt" ASC, r."id" ASC
            LIMIT 100"#
    ))
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                let mut v = review_dto(r);
                v["connection"] = json!({
                    "id": text(r, "connId"),
                    "name": text(r, "connName"),
                    "dialect": text(r, "connDialect"),
                });
                v["requester"] = user_ref(r, "rqId", "rqEmail", "rqDisplayName");
                v
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
struct ReviewAction {
    #[serde(default)]
    comment: Option<String>,
}

/// v1 `assertCanReview`: the request must exist, the caller must not be the
/// requester (no self-approval), and their effective role on the request's own
/// connection must be OWNER. Returns the current status.
async fn assert_can_review(state: &AppState, user_id: &str, id: &str) -> ApiResult<String> {
    let r = sqlx::query(
        r#"SELECT "requesterId", "connectionId", "status"::text AS "status"
             FROM "QueryReviewRequest" WHERE "id" = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Review request not found"))?;

    // SECURITY: all three columns decide authorisation — propagate a decode
    // error rather than defaulting any of them.
    let requester: String = r.try_get("requesterId")?;
    if requester == user_id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "You cannot review your own request",
        ));
    }
    let conn_id: String = r.try_get("connectionId")?;
    // v1 calls effectiveRole (not require) here, so "no access at all" and
    // "member but not OWNER" both surface as this one 403.
    match crate::conn_role(&state.pool, &conn_id, user_id).await?.as_deref() {
        Some("OWNER") => {}
        _ => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Only connection owners can review requests",
            ))
        }
    }
    Ok(r.try_get::<String, _>("status")?)
}

/// `POST /review-requests/:id/approve` — 200. The requester may then run the
/// frozen SQL once, within v1's 24h approval TTL (enforced by v1's query path,
/// which is where `fetchRunnable` lives).
async fn review_approve(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<ReviewAction>>,
) -> ApiResult<Json<Value>> {
    let status = assert_can_review(&state, &user.id, &id).await?;
    if status != "PENDING" {
        return Err(ApiError::bad(format!(
            "Cannot approve a {} request",
            status.to_lowercase()
        )));
    }
    let comment = body.and_then(|Json(b)| b.comment).map(|c| cap(&c, 1000));
    let r = sqlx::query(&format!(
        r#"UPDATE "QueryReviewRequest"
              SET "status" = 'APPROVED'::"ReviewStatus",
                  "reviewerId" = $2,
                  "approvedAt" = now(),
                  "reviewComment" = $3,
                  "updatedAt" = now()
            WHERE "id" = $1
        RETURNING {REVIEW_COLS_BARE}"#
    ))
    .bind(&id)
    .bind(&user.id)
    .bind(comment)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Review request not found"))?;
    Ok(Json(review_dto(&r)))
}

/// `POST /review-requests/:id/reject` — 200. `approvedAt` is left untouched.
async fn review_reject(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<ReviewAction>>,
) -> ApiResult<Json<Value>> {
    let status = assert_can_review(&state, &user.id, &id).await?;
    if status != "PENDING" {
        return Err(ApiError::bad(format!(
            "Cannot reject a {} request",
            status.to_lowercase()
        )));
    }
    let comment = body.and_then(|Json(b)| b.comment).map(|c| cap(&c, 1000));
    let r = sqlx::query(&format!(
        r#"UPDATE "QueryReviewRequest"
              SET "status" = 'REJECTED'::"ReviewStatus",
                  "reviewerId" = $2,
                  "reviewComment" = $3,
                  "updatedAt" = now()
            WHERE "id" = $1
        RETURNING {REVIEW_COLS_BARE}"#
    ))
    .bind(&id)
    .bind(&user.id)
    .bind(comment)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Review request not found"))?;
    Ok(Json(review_dto(&r)))
}

// ---------------------------------------------------------------------------
// Slow queries — /api/connections/:id/slow-queries
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SlowQ {
    #[serde(default)]
    hours: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

#[derive(Deserialize)]
struct LimitQ {
    #[serde(default)]
    limit: Option<String>,
}

/// `SlowQueryService.listGroups` — one row per query *shape*, ranked by total
/// time burned. v1 needs three Prisma round-trips (groupBy, distinct-on example,
/// errored groupBy) because Prisma can't express this; one SQL statement does
/// the same work here.
///
/// The example row is deliberately NOT filtered by `since`: v1's `examples`
/// lookup omits the time window, so a shape whose only recent runs are inside
/// the window still shows its most recent example ever. Matching that keeps
/// `exampleSql`/`normalizedSql` identical.
async fn slow_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
    Query(q): Query<SlowQ>,
) -> ApiResult<Json<Value>> {
    // @RequireRole('VIEWER') via RbacGuard, resolved off the `:id` path param.
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    // Controller: `Math.max(1, Math.min(parseInt(hours ?? '168') || 168, 24*30))`.
    let hours = int_param(q.hours.as_deref(), 168).min(24 * 30).max(1);
    // Controller passes `parseInt(limit ?? '100') || 100`; the service then
    // clamps it to 1..500.
    let limit = int_param(q.limit.as_deref(), 100).max(1).min(500);
    let since = chrono::Utc::now().naive_utc() - chrono::Duration::hours(hours);

    let rows = sqlx::query(
        r#"WITH g AS (
             SELECT "shapeHash",
                    COUNT(*)::int                          AS "count",
                    COALESCE(SUM("durationMs"), 0)::bigint AS "totalDurationMs",
                    COALESCE(AVG("durationMs"), 0)::float8 AS "avgDurationMs",
                    COALESCE(MAX("durationMs"), 0)::int    AS "maxDurationMs",
                    MAX("createdAt")                       AS "lastSeen",
                    COUNT(*) FILTER (WHERE "errored")::int AS "erroredCount"
               FROM "SlowQueryLog"
              WHERE "connectionId" = $1 AND "createdAt" >= $2
              GROUP BY "shapeHash"
              ORDER BY "totalDurationMs" DESC, "shapeHash" ASC
              LIMIT $3
           )
           SELECT g.*, ex."exampleSql", ex."normalizedSql"
             FROM g
             LEFT JOIN LATERAL (
                   SELECT l."exampleSql", l."normalizedSql"
                     FROM "SlowQueryLog" l
                    WHERE l."connectionId" = $1 AND l."shapeHash" = g."shapeHash"
                    ORDER BY l."createdAt" DESC, l."id" ASC
                    LIMIT 1
                 ) ex ON TRUE
            ORDER BY g."totalDurationMs" DESC, g."shapeHash" ASC"#,
    )
    .bind(&conn_id)
    .bind(since)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                let avg = r.try_get::<f64, _>("avgDurationMs").unwrap_or(0.0);
                json!({
                    "shapeHash": text(r, "shapeHash"),
                    // v1: `ex?.normalizedSql ?? '(unknown)'`
                    "normalizedSql": opt_text(r, "normalizedSql")
                        .unwrap_or_else(|| "(unknown)".to_string()),
                    "count": r.try_get::<i32, _>("count").unwrap_or(0),
                    "totalDurationMs": r.try_get::<i64, _>("totalDurationMs").unwrap_or(0),
                    // v1: Math.round — positive durations only, so half-up and
                    // half-away-from-zero agree.
                    "avgDurationMs": avg.round() as i64,
                    "maxDurationMs": r.try_get::<i32, _>("maxDurationMs").unwrap_or(0),
                    // v1: `?? new Date(0)`; a group always has rows, so this is
                    // unreachable in practice.
                    "lastSeen": iso(r, "lastSeen")
                        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string()),
                    "erroredCount": r.try_get::<i32, _>("erroredCount").unwrap_or(0),
                    "exampleSql": opt_text(r, "exampleSql").unwrap_or_default(),
                })
            })
            .collect(),
    )))
}

/// `SlowQueryService.listRunsForShape` — the individual executions behind one
/// shape, newest first. Scoped by connection *and* hash so a hash lifted from
/// another tenant's connection returns an empty list rather than their runs.
async fn slow_runs(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conn_id, hash)): Path<(String, String)>,
    Query(q): Query<LimitQ>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    let limit = int_param(q.limit.as_deref(), 50).max(1).min(200);
    let rows = sqlx::query(
        r#"SELECT l."id", l."connectionId", l."userId", l."shapeHash", l."normalizedSql",
                  l."exampleSql", l."durationMs", l."rowCount", l."rowsAffected", l."errored",
                  l."errorMessage", l."createdAt",
                  u."email" AS "uEmail", u."displayName" AS "uDisplayName"
             FROM "SlowQueryLog" l
             LEFT JOIN "User" u ON u."id" = l."userId"
            WHERE l."connectionId" = $1 AND l."shapeHash" = $2
            ORDER BY l."createdAt" DESC, l."id" ASC
            LIMIT $3"#,
    )
    .bind(&conn_id)
    .bind(&hash)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": text(r, "id"),
                    "connectionId": text(r, "connectionId"),
                    "userId": opt_text(r, "userId"),
                    "shapeHash": text(r, "shapeHash"),
                    "normalizedSql": text(r, "normalizedSql"),
                    "exampleSql": text(r, "exampleSql"),
                    "durationMs": r.try_get::<i32, _>("durationMs").unwrap_or(0),
                    "rowCount": opt_int(r, "rowCount"),
                    "rowsAffected": opt_int(r, "rowsAffected"),
                    "errored": r.try_get::<bool, _>("errored").unwrap_or(false),
                    "errorMessage": opt_text(r, "errorMessage"),
                    "createdAt": iso(r, "createdAt"),
                    "user": user_contact(r, "uEmail", "uDisplayName"),
                })
            })
            .collect(),
    )))
}

// ---------------------------------------------------------------------------
// Schema docs — /api/connections/:id/schema-docs
// ---------------------------------------------------------------------------

const DOC_COLS: &str = r#""id", "connectionId", "schemaName", "tableName", "columnName",
        "description", "tags", "ownerEmail", "updatedById", "createdAt", "updatedAt""#;

fn doc_dto(r: &PgRow) -> Value {
    json!({
        "id": text(r, "id"),
        "connectionId": text(r, "connectionId"),
        "schemaName": text(r, "schemaName"),
        "tableName": text(r, "tableName"),
        "columnName": text(r, "columnName"),
        "description": opt_text(r, "description"),
        "tags": opt_text(r, "tags"),
        "ownerEmail": opt_text(r, "ownerEmail"),
        "updatedById": opt_text(r, "updatedById"),
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

/// v1 `IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/` — 1..64 chars, ASCII only.
fn doc_ident_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    if !(b[0].is_ascii_alphabetic() || b[0] == b'_') {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// v1 `sanitizeTags`: split on comma, trim + lowercase, drop anything outside
/// `^[a-z0-9_-]{1,40}$`, keep first-seen order, cap at 16. Empty → NULL.
fn sanitize_tags(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let t = part.trim().to_lowercase();
        if t.is_empty() || t.len() > 40 {
            continue;
        }
        if !t
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
        {
            continue;
        }
        if !seen.insert(t.clone()) {
            continue;
        }
        out.push(t);
        if out.len() >= 16 {
            break;
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out.join(","))
    }
}

#[derive(Deserialize)]
struct DocFilterQ {
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    table: Option<String>,
}

/// `SchemaDocsService.list` — every doc on the connection, optionally narrowed
/// to one schema/table.
async fn docs_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
    Query(q): Query<DocFilterQ>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(
        r#"SELECT d."id", d."connectionId", d."schemaName", d."tableName", d."columnName",
                  d."description", d."tags", d."ownerEmail", d."updatedById",
                  d."createdAt", d."updatedAt",
                  u."email" AS "ubEmail", u."displayName" AS "ubDisplayName"
             FROM "SchemaDoc" d
             LEFT JOIN "User" u ON u."id" = d."updatedById"
            WHERE d."connectionId" = $1
              AND ($2::text IS NULL OR d."schemaName" = $2)
              AND ($3::text IS NULL OR d."tableName" = $3)
            ORDER BY d."schemaName" ASC, d."tableName" ASC, d."columnName" ASC"#,
    )
    .bind(&conn_id)
    // v1: `schemaName ? { schemaName } : {}` — "" means "no filter".
    .bind(q.schema.filter(|s| !s.is_empty()))
    .bind(q.table.filter(|s| !s.is_empty()))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                let mut v = doc_dto(r);
                v["updatedBy"] = user_contact(r, "ubEmail", "ubDisplayName");
                v
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertDoc {
    // All optional so a malformed body yields v1's 400 rather than axum's 422.
    #[serde(default)]
    schema_name: Option<String>,
    #[serde(default)]
    table_name: Option<String>,
    #[serde(default)]
    column_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Option<String>,
    #[serde(default)]
    owner_email: Option<String>,
}

/// `SchemaDocsService.upsert` — 200 (not 201; v1 sets `@HttpCode(200)` because
/// the same call both creates and edits). EDITOR to document: the same level as
/// the data being documented.
///
/// `columnName` is `''` for a table-level doc — the composite unique is
/// `(connectionId, schemaName, tableName, columnName)` and Prisma stores the
/// empty string rather than NULL so the lookup needs no NULL semantics.
async fn docs_upsert(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
    Json(body): Json<UpsertDoc>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "EDITOR").await?;
    let schema_name = body.schema_name.unwrap_or_default();
    let table_name = body.table_name.unwrap_or_default();
    if !doc_ident_ok(&schema_name) || !doc_ident_ok(&table_name) {
        return Err(ApiError::bad("Invalid schema/table identifier"));
    }
    // v1 skips the check for null/"" and stores '' (a table-level doc).
    let column_name = body.column_name.filter(|c| !c.is_empty());
    if let Some(c) = column_name.as_deref() {
        if !doc_ident_ok(c) {
            return Err(ApiError::bad("Invalid column identifier"));
        }
    }
    let column_name = column_name.unwrap_or_default();

    let r = sqlx::query(&format!(
        r#"INSERT INTO "SchemaDoc"
             ("id","connectionId","schemaName","tableName","columnName","description","tags",
              "ownerEmail","updatedById","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
           ON CONFLICT ("connectionId","schemaName","tableName","columnName")
           DO UPDATE SET "description"  = EXCLUDED."description",
                         "tags"         = EXCLUDED."tags",
                         "ownerEmail"   = EXCLUDED."ownerEmail",
                         "updatedById"  = EXCLUDED."updatedById",
                         "updatedAt"    = now()
           RETURNING {DOC_COLS}"#
    ))
    // Prisma generates `@default(cuid())` client-side, so Postgres has no
    // default for "id" — every INSERT must supply one.
    .bind(gen_id())
    .bind(&conn_id)
    .bind(&schema_name)
    .bind(&table_name)
    .bind(&column_name)
    // v1: `description?.slice(0, 10_000) ?? null` — "" is stored as "", not NULL.
    .bind(body.description.as_deref().map(|d| cap(d, 10_000)))
    .bind(sanitize_tags(body.tags.as_deref()))
    // v1: `ownerEmail?.trim().toLowerCase() || null` — blank collapses to NULL.
    .bind(
        body.owner_email
            .as_deref()
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty()),
    )
    .bind(&user.id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(doc_dto(&r)))
}

/// `SchemaDocsService.remove` — EDITOR, and the doc must belong to the
/// connection in the path (v1 does a `findFirst({ id, connectionId })` first, so
/// another tenant's doc id is "not found" rather than deleted). A miss is v1's
/// `BadRequestException` — 400, not 404.
async fn docs_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((conn_id, doc_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &conn_id, &user.id, "EDITOR").await?;
    let res = sqlx::query(r#"DELETE FROM "SchemaDoc" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&doc_id)
        .bind(&conn_id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::bad("Doc not found"));
    }
    Ok(Json(json!({ "ok": true })))
}
