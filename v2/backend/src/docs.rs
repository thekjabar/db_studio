//! Notebooks + dashboards — Rust port of the v1 NestJS `src/notebooks/` and
//! `src/dashboards/` modules (controller + service), wire-compatible with them:
//! same paths, methods, status codes, error messages and JSON field names.
//!
//! Both models live in the app database, so this is app-DB CRUD plus one
//! target-database path (running a tile's saved query). There is no `@map` in
//! the Prisma schema, so every table/column below is the quoted PascalCase /
//! camelCase identifier Prisma created (`"Notebook"."ownerId"`, …), and
//! `DateTime` columns are `TIMESTAMP(3)` *without* time zone → they decode as
//! `chrono::NaiveDateTime`, not `DateTime<Utc>`.
//!
//! v1 sources of truth:
//!   backend/src/notebooks/notebooks.{controller,service}.ts
//!   backend/src/dashboards/dashboards.{controller,service}.ts

use std::time::Instant;

use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgRow, PgSslMode};
use sqlx::{Column, Connection, Executor, PgConnection, PgPool, Row, TypeInfo};

use crate::{gen_id, ApiError, ApiResult, AppState, AuthUser};

/// Every notebook + dashboard route, at its full v1 path (the Nest app sets a
/// global `api` prefix, so `@Controller('notebooks')` serves `/api/notebooks`).
pub fn routes() -> Router<AppState> {
    Router::new()
        // --- notebooks (JwtAuthGuard on the whole controller) ---
        .route("/api/notebooks", get(notebook_list).post(notebook_create))
        .route(
            "/api/notebooks/:id",
            get(notebook_get).patch(notebook_update).delete(notebook_delete),
        )
        // --- dashboards (JwtAuthGuard on the whole controller) ---
        .route("/api/dashboards", get(dashboard_list).post(dashboard_create))
        .route(
            "/api/dashboards/:id",
            get(dashboard_get).patch(dashboard_update).delete(dashboard_delete),
        )
        .route("/api/dashboards/:id/share", post(dashboard_share))
        .route("/api/dashboards/:id/tiles", post(tile_add).put(tiles_reorder))
        .route(
            "/api/dashboards/:id/tiles/:tileId",
            patch(tile_update).delete(tile_delete),
        )
        .route("/api/dashboards/:id/tiles/:tileId/run", post(tile_run))
        // --- public share (PublicDashboardsController: @Public, no JWT) ---
        .route("/api/public/dashboards/:token", get(public_dashboard_get))
        .route(
            "/api/public/dashboards/:token/tiles/:tileId/run",
            post(public_tile_run),
        )
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/// Render a `TIMESTAMP(3)` column the way the Node API does (`Date.toISOString()`:
/// UTC, exactly milliseconds, trailing `Z`). Prisma stores these without a time
/// zone, so they come back as `NaiveDateTime`; `DateTime<Utc>` is accepted too
/// in case a column is ever migrated to `timestamptz`.
fn ts(r: &PgRow, col: &str) -> Option<String> {
    if let Ok(d) = r.try_get::<Option<chrono::NaiveDateTime>, _>(col) {
        return d.map(|d| d.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    r.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col)
        .ok()
        .flatten()
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn text(r: &PgRow, col: &str) -> String {
    r.try_get::<String, _>(col).unwrap_or_default()
}

fn opt_text_col(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(col).ok().flatten()
}

fn json_col(r: &PgRow, col: &str) -> Option<Value> {
    r.try_get::<Option<Value>, _>(col).ok().flatten()
}

/// JS `s.trim().slice(0, max)`. Rust slices by chars where JS slices by UTF-16
/// code units; identical for everything short of astral-plane text, and never
/// panics mid-codepoint the way byte slicing would.
fn trim_cap(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

/// v1 writes `description?.trim().slice(0,500) || null` — note the `||`, so an
/// all-whitespace description is stored as NULL, not as "".
fn opt_desc(s: Option<&str>) -> Option<String> {
    let v = trim_cap(s?, 500);
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// The PATCH variant: `patch.description ? patch.description.trim().slice(0,500) : null`.
/// The ternary tests the RAW string, so only null/"" clear the column — an
/// all-whitespace description trims down to "" and is stored as "". Subtle, but
/// it is the difference between v1's create and update paths and the round-trip
/// is visible to the client.
fn patch_desc(s: Option<&str>) -> Option<String> {
    match s {
        None | Some("") => None,
        Some(v) => Some(trim_cap(v, 500)),
    }
}

fn role_rank(role: &str) -> i32 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        "VIEWER" => 1,
        _ => 0,
    }
}

/// v1 `RbacService.require`: no role at all → 404 when the connection itself is
/// gone, else 403; too low a role → 403 naming both the required and held role.
/// `crate::conn_role` already implements `effectiveRole`'s precedence
/// (connection owner > direct member grant > workspace member).
async fn require_role(pool: &PgPool, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match crate::conn_role(pool, conn_id, user_id).await? {
        Some(role) => {
            if role_rank(&role) < role_rank(min) {
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    format!("Requires {min} role (have {role})"),
                ));
            }
            Ok(role)
        }
        None => {
            let exists: Option<String> = sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                .bind(conn_id)
                .fetch_optional(pool)
                .await?;
            if exists.is_none() {
                Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))
            } else {
                Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"))
            }
        }
    }
}

/// The `where` clause v1 uses when listing notebooks/dashboards without a
/// `connectionId`: rows you own, plus every row on a connection you own or are
/// a member of (directly or via its workspace). `$1` = caller id, and the outer
/// table must be aliased `t`.
///
/// v1 *replaces* this with a bare `{ connectionId }` when the query param is
/// present, which returns every dashboard/notebook on any connection id you can
/// guess — a cross-tenant read behind nothing but a valid JWT. We keep the
/// access predicate and AND the filter onto it: identical results for anyone
/// who can actually see the connection, empty list for anyone who cannot.
const ACCESS_WHERE: &str = r#"(
        t."ownerId" = $1
        OR EXISTS (
          SELECT 1 FROM "Connection" c
           WHERE c."id" = t."connectionId"
             AND (
               c."ownerId" = $1
               OR EXISTS (SELECT 1 FROM "ConnectionMember" m
                           WHERE m."connectionId" = c."id" AND m."userId" = $1)
               OR EXISTS (SELECT 1 FROM "WorkspaceMember" wm
                           WHERE wm."workspaceId" = c."workspaceId" AND wm."userId" = $1)
             )
        )
      )"#;

#[derive(Deserialize)]
struct ListQ {
    #[serde(rename = "connectionId")]
    connection_id: Option<String>,
}

impl ListQ {
    /// v1 passes `connectionId || undefined`, so "" means "no filter".
    fn filter(&self) -> Option<String> {
        self.connection_id.clone().filter(|s| !s.is_empty())
    }
}

fn owner_json(r: &PgRow) -> Value {
    json!({
        "id": text(r, "ownerUserId"),
        "email": text(r, "ownerEmail"),
        "displayName": opt_text_col(r, "ownerDisplayName"),
    })
}

// ---------------------------------------------------------------------------
// Notebooks — /api/notebooks
// ---------------------------------------------------------------------------

const NOTEBOOK_COLS: &str =
    r#""id","name","description","connectionId","ownerId","cells","createdAt","updatedAt""#;

fn notebook_dto(r: &PgRow) -> Value {
    // Key order mirrors the Prisma model so the JSON is byte-comparable with v1.
    json!({
        "id": text(r, "id"),
        "name": text(r, "name"),
        "description": opt_text_col(r, "description"),
        "connectionId": text(r, "connectionId"),
        "ownerId": text(r, "ownerId"),
        "cells": json_col(r, "cells").unwrap_or_else(|| json!([])),
        "createdAt": ts(r, "createdAt"),
        "updatedAt": ts(r, "updatedAt"),
    })
}

/// `NotebooksService.list` — summary rows + the owner, newest edit first.
async fn notebook_list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQ>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT t."id", t."name", t."description", t."connectionId", t."updatedAt",
                  u."id" AS "ownerUserId", u."email" AS "ownerEmail", u."displayName" AS "ownerDisplayName"
             FROM "Notebook" t
             JOIN "User" u ON u."id" = t."ownerId"
            WHERE {ACCESS_WHERE}
              AND ($2::text IS NULL OR t."connectionId" = $2)
            ORDER BY t."updatedAt" DESC, t."id" ASC"# // id tiebreaker = stable paging
    ))
    .bind(&user.id)
    .bind(q.filter())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": text(r, "id"),
                    "name": text(r, "name"),
                    "description": opt_text_col(r, "description"),
                    "connectionId": text(r, "connectionId"),
                    "updatedAt": ts(r, "updatedAt"),
                    "owner": owner_json(r),
                })
            })
            .collect(),
    )))
}

/// `NotebooksService.get` — owner, or anyone with at least VIEWER on the
/// notebook's connection.
async fn notebook_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = sqlx::query(&format!(
        r#"SELECT {NOTEBOOK_COLS} FROM "Notebook" WHERE "id" = $1"#
    ))
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Notebook not found"))?;
    if text(&r, "ownerId") != user.id {
        require_role(&state.pool, &text(&r, "connectionId"), &user.id, "VIEWER").await?;
    }
    Ok(Json(notebook_dto(&r)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateNotebook {
    // All optional so a malformed body yields v1's 400 rather than axum's 422.
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    connection_id: Option<String>,
}

/// `NotebooksService.create` — 201, seeded with the same two starter cells v1
/// writes so a fresh notebook opens identically.
async fn notebook_create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateNotebook>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = body.name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err(ApiError::bad("Name required"));
    }
    let connection_id = body
        .connection_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("connectionId must be a string"))?;
    require_role(&state.pool, &connection_id, &user.id, "EDITOR").await?;

    let trimmed = name.trim().to_string();
    let cells = json!([
        {
            "id": random_cell_id(),
            "kind": "md",
            "source": format!("# {trimmed}\n\n_Add SQL and markdown cells to build your runbook._"),
        },
        { "id": random_cell_id(), "kind": "sql", "source": "SELECT 1;" },
    ]);

    let r = sqlx::query(&format!(
        r#"INSERT INTO "Notebook" ("id","name","description","connectionId","ownerId","cells","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,now(),now()) RETURNING {NOTEBOOK_COLS}"#
    ))
    // Prisma generates `@default(cuid())` client-side, so Postgres has no
    // default for "id" — every INSERT must supply one.
    .bind(gen_id())
    .bind(trim_cap(&name, 120))
    .bind(opt_desc(body.description.as_deref()))
    .bind(&connection_id)
    .bind(&user.id)
    .bind(&cells)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(notebook_dto(&r))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateNotebook {
    #[serde(default)]
    name: Option<String>,
    // Double Option: absent = leave alone, `null` = clear (v1 distinguishes the
    // two — `patch.description !== undefined`).
    #[serde(default, deserialize_with = "double_opt")]
    description: Option<Option<String>>,
    #[serde(default)]
    cells: Option<Value>,
}

/// `NotebooksService.update`. Prisma's `@updatedAt` always bumps on update, even
/// for an empty patch, so `"updatedAt"` is set unconditionally.
async fn notebook_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateNotebook>,
) -> ApiResult<Json<Value>> {
    assert_manage_notebook(&state, &id, &user.id).await?;
    let name = body.name.as_deref().map(|n| trim_cap(n, 120));
    let (desc_set, desc) = match &body.description {
        None => (false, None),
        Some(d) => (true, patch_desc(d.as_deref())),
    };
    let (cells_set, cells) = match &body.cells {
        None => (false, None),
        Some(c) => (true, Some(sanitize_cells(c))),
    };
    let r = sqlx::query(&format!(
        r#"UPDATE "Notebook" SET
             "name" = COALESCE($2, "name"),
             "description" = CASE WHEN $3 THEN $4::text ELSE "description" END,
             "cells" = CASE WHEN $5 THEN $6::jsonb ELSE "cells" END,
             "updatedAt" = now()
           WHERE "id" = $1 RETURNING {NOTEBOOK_COLS}"#
    ))
    .bind(&id)
    .bind(name)
    .bind(desc_set)
    .bind(desc)
    .bind(cells_set)
    .bind(cells)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Notebook not found"))?;
    Ok(Json(notebook_dto(&r)))
}

async fn notebook_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    assert_manage_notebook(&state, &id, &user.id).await?;
    sqlx::query(r#"DELETE FROM "Notebook" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// `NotebooksService.assertManage`: the notebook owner, or the OWNER of its
/// connection (same policy as dashboards / scheduled queries). Returns the
/// notebook's connection id.
async fn assert_manage_notebook(state: &AppState, id: &str, user_id: &str) -> ApiResult<String> {
    let r = sqlx::query(r#"SELECT "id","ownerId","connectionId" FROM "Notebook" WHERE "id" = $1"#)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Notebook not found"))?;
    let connection_id = text(&r, "connectionId");
    if text(&r, "ownerId") == user_id {
        return Ok(connection_id);
    }
    // v1 calls effectiveRole (not require) here, so "no access at all" and
    // "member but not OWNER" both surface as this one 403.
    match crate::conn_role(&state.pool, &connection_id, user_id).await?.as_deref() {
        Some("OWNER") => Ok(connection_id),
        _ => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the notebook owner or connection owner can modify",
        )),
    }
}

/// v1 `randomCellId()`: `c_` + 12 base36 chars.
fn random_cell_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let s: String = (0..12)
        .map(|_| std::char::from_digit(rng.gen_range(0..36), 36).unwrap())
        .collect();
    format!("c_{s}")
}

/// v1 `sanitizeCells`: drop anything that isn't `{kind: 'md'|'sql'}`, cap the
/// field lengths, mint a cell id when one is missing, and cap the notebook at
/// 200 cells (abuse protection — real notebooks stay far under).
fn sanitize_cells(cells: &Value) -> Value {
    let arr = match cells.as_array() {
        Some(a) => a,
        None => return json!([]),
    };
    let mut out: Vec<Value> = Vec::new();
    for c in arr {
        let o = match c.as_object() {
            Some(o) => o,
            None => continue,
        };
        let kind = match o.get("kind").and_then(|v| v.as_str()) {
            Some("md") => "md",
            Some("sql") => "sql",
            _ => continue,
        };
        let id = match o.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.is_empty() => s.chars().take(40).collect::<String>(),
            _ => random_cell_id(),
        };
        let source: String = o
            .get("source")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().take(100_000).collect())
            .unwrap_or_default();
        let mut cell = serde_json::Map::new();
        cell.insert("id".into(), json!(id));
        cell.insert("kind".into(), json!(kind));
        cell.insert("source".into(), json!(source));
        if let Some(t) = o.get("title").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            cell.insert("title".into(), json!(t.chars().take(200).collect::<String>()));
        }
        out.push(Value::Object(cell));
        if out.len() >= 200 {
            break;
        }
    }
    Value::Array(out)
}

// ---------------------------------------------------------------------------
// Dashboards — /api/dashboards
// ---------------------------------------------------------------------------

const DASHBOARD_COLS: &str = r#""id","name","description","connectionId","ownerId","shareToken","refreshSec","createdAt","updatedAt""#;

fn dashboard_dto(r: &PgRow) -> Value {
    json!({
        "id": text(r, "id"),
        "name": text(r, "name"),
        "description": opt_text_col(r, "description"),
        "connectionId": text(r, "connectionId"),
        "ownerId": text(r, "ownerId"),
        "shareToken": opt_text_col(r, "shareToken"),
        "refreshSec": r.try_get::<Option<i32>, _>("refreshSec").ok().flatten(),
        "createdAt": ts(r, "createdAt"),
        "updatedAt": ts(r, "updatedAt"),
    })
}

const TILE_COLS: &str = r#""id","dashboardId","savedQueryId","chartOverride","title","x","y","w","h","createdAt""#;

fn tile_dto(r: &PgRow) -> Value {
    json!({
        "id": text(r, "id"),
        "dashboardId": text(r, "dashboardId"),
        "savedQueryId": text(r, "savedQueryId"),
        "chartOverride": json_col(r, "chartOverride"),
        "title": opt_text_col(r, "title"),
        "x": r.try_get::<i32, _>("x").unwrap_or(0),
        "y": r.try_get::<i32, _>("y").unwrap_or(0),
        "w": r.try_get::<i32, _>("w").unwrap_or(6),
        "h": r.try_get::<i32, _>("h").unwrap_or(4),
        "createdAt": ts(r, "createdAt"),
    })
}

/// `DashboardsService.list` — same access rules as notebooks, plus the tile
/// count (`_count: { tiles }` in Prisma's shape) and share token.
async fn dashboard_list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQ>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(&format!(
        r#"SELECT t."id", t."name", t."description", t."connectionId", t."refreshSec",
                  t."shareToken", t."updatedAt",
                  (SELECT COUNT(*) FROM "DashboardTile" dt WHERE dt."dashboardId" = t."id")::int AS "tileCount",
                  u."id" AS "ownerUserId", u."email" AS "ownerEmail", u."displayName" AS "ownerDisplayName"
             FROM "Dashboard" t
             JOIN "User" u ON u."id" = t."ownerId"
            WHERE {ACCESS_WHERE}
              AND ($2::text IS NULL OR t."connectionId" = $2)
            ORDER BY t."updatedAt" DESC, t."id" ASC"#
    ))
    .bind(&user.id)
    .bind(q.filter())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": text(r, "id"),
                    "name": text(r, "name"),
                    "description": opt_text_col(r, "description"),
                    "connectionId": text(r, "connectionId"),
                    "refreshSec": r.try_get::<Option<i32>, _>("refreshSec").ok().flatten(),
                    "shareToken": opt_text_col(r, "shareToken"),
                    "updatedAt": ts(r, "updatedAt"),
                    "_count": { "tiles": r.try_get::<i32, _>("tileCount").unwrap_or(0) },
                    "owner": owner_json(r),
                })
            })
            .collect(),
    )))
}

/// `DashboardsService.getOr403` — dashboard + its tiles (each with the saved
/// query it renders), ordered top-to-bottom.
async fn dashboard_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let d = load_dashboard(&state, &id).await?;
    if text(&d, "ownerId") != user.id {
        require_role(&state.pool, &text(&d, "connectionId"), &user.id, "VIEWER").await?;
    }
    Ok(Json(dashboard_with_tiles(&state, &d).await?))
}

async fn load_dashboard(state: &AppState, id: &str) -> ApiResult<PgRow> {
    sqlx::query(&format!(
        r#"SELECT {DASHBOARD_COLS} FROM "Dashboard" WHERE "id" = $1"#
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Dashboard not found"))
}

async fn dashboard_with_tiles(state: &AppState, d: &PgRow) -> ApiResult<Value> {
    let tiles = sqlx::query(
        r#"SELECT t."id", t."dashboardId", t."savedQueryId", t."chartOverride", t."title",
                  t."x", t."y", t."w", t."h", t."createdAt",
                  sq."id" AS "sqId", sq."name" AS "sqName", sq."sqlText" AS "sqSqlText",
                  sq."chartConfig" AS "sqChartConfig"
             FROM "DashboardTile" t
             JOIN "SavedQuery" sq ON sq."id" = t."savedQueryId"
            WHERE t."dashboardId" = $1
            ORDER BY t."y" ASC, t."id" ASC"#, // id tiebreaker: y collides constantly on a grid
    )
    .bind(text(d, "id"))
    .fetch_all(&state.pool)
    .await?;
    let mut out = dashboard_dto(d);
    let list: Vec<Value> = tiles
        .iter()
        .map(|r| {
            let mut t = tile_dto(r);
            t["savedQuery"] = json!({
                "id": text(r, "sqId"),
                "name": text(r, "sqName"),
                "sqlText": text(r, "sqSqlText"),
                "chartConfig": json_col(r, "sqChartConfig"),
            });
            t
        })
        .collect();
    out["tiles"] = Value::Array(list);
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDashboard {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    connection_id: Option<String>,
    #[serde(default)]
    refresh_sec: Option<f64>,
}

/// `DashboardsService.create` — 201. EDITOR to create: viewers can see a
/// connection's dashboards but not add to them.
async fn dashboard_create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateDashboard>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = body.name.unwrap_or_default();
    if name.trim().is_empty() {
        return Err(ApiError::bad("Name required"));
    }
    let connection_id = body
        .connection_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("connectionId must be a string"))?;
    require_role(&state.pool, &connection_id, &user.id, "EDITOR").await?;
    let r = sqlx::query(&format!(
        r#"INSERT INTO "Dashboard" ("id","name","description","connectionId","ownerId","refreshSec","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,now(),now()) RETURNING {DASHBOARD_COLS}"#
    ))
    .bind(gen_id())
    .bind(trim_cap(&name, 120))
    .bind(opt_desc(body.description.as_deref()))
    .bind(&connection_id)
    .bind(&user.id)
    .bind(sanitize_refresh(body.refresh_sec))
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(dashboard_dto(&r))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDashboard {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, deserialize_with = "double_opt")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_opt")]
    refresh_sec: Option<Option<f64>>,
}

/// `DashboardsService.update` — writes the patch, then returns the full
/// dashboard (v1 re-reads through getOr403).
async fn dashboard_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateDashboard>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    let (desc_set, desc) = match &body.description {
        None => (false, None),
        Some(d) => (true, patch_desc(d.as_deref())),
    };
    // `refreshSec: null` is a real value here (disable auto-refresh), so the
    // "was the key present" flag is what decides whether we write.
    let (refresh_set, refresh) = match body.refresh_sec {
        None => (false, None),
        Some(v) => (true, sanitize_refresh(v)),
    };
    let d = sqlx::query(&format!(
        r#"UPDATE "Dashboard" SET
             "name" = COALESCE($2, "name"),
             "description" = CASE WHEN $3 THEN $4::text ELSE "description" END,
             "refreshSec" = CASE WHEN $5 THEN $6::int ELSE "refreshSec" END,
             "updatedAt" = now()
           WHERE "id" = $1 RETURNING {DASHBOARD_COLS}"#
    ))
    .bind(&id)
    .bind(body.name.as_deref().map(|n| trim_cap(n, 120)))
    .bind(desc_set)
    .bind(desc)
    .bind(refresh_set)
    .bind(refresh)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Dashboard not found"))?;
    Ok(Json(dashboard_with_tiles(&state, &d).await?))
}

async fn dashboard_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    sqlx::query(r#"DELETE FROM "Dashboard" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RotateShare {
    #[serde(default)]
    share: Option<bool>,
}

/// `POST /:id/share` — 200. Rotating mints a fresh token (old links die);
/// `{share:false}` unpublishes. v1 stores the plaintext token because the URL
/// itself is the credential and the dialog has to show it again.
async fn dashboard_share(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<RotateShare>>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    // v1: `dto.share !== false` — a missing body still means "share".
    let share = body.and_then(|Json(b)| b.share).unwrap_or(true);
    let token = if share { Some(share_token()) } else { None };
    sqlx::query(r#"UPDATE "Dashboard" SET "shareToken" = $2, "updatedAt" = now() WHERE "id" = $1"#)
        .bind(&id)
        .bind(&token)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "shareToken": token })))
}

/// v1 `randomBytes(24).toString('base64url')` — 24 bytes, URL-safe, unpadded.
fn share_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// `DashboardsService.assertManage`: dashboard owner, or the connection OWNER.
/// Returns the dashboard's connection id.
async fn assert_manage_dashboard(state: &AppState, id: &str, user_id: &str) -> ApiResult<String> {
    let r = sqlx::query(r#"SELECT "id","ownerId","connectionId" FROM "Dashboard" WHERE "id" = $1"#)
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Dashboard not found"))?;
    let connection_id = text(&r, "connectionId");
    if text(&r, "ownerId") == user_id {
        return Ok(connection_id);
    }
    match crate::conn_role(&state.pool, &connection_id, user_id).await?.as_deref() {
        Some("OWNER") => Ok(connection_id),
        _ => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the dashboard owner or connection owner can modify",
        )),
    }
}

/// v1 `sanitizeRefresh`: null/non-finite disables; otherwise clamp to
/// 10s..86400s — a 1-second shared dashboard would DOS the backing DB.
fn sanitize_refresh(v: Option<f64>) -> Option<i32> {
    let v = v?;
    if !v.is_finite() {
        return None;
    }
    if v < 10.0 {
        return Some(10);
    }
    if v > 86_400.0 {
        return Some(86_400);
    }
    Some(v.floor() as i32)
}

/// v1 `clampInt`.
fn clamp_int(v: f64, lo: i32, hi: i32) -> i32 {
    let n = v.floor();
    if !n.is_finite() {
        return lo;
    }
    if n < lo as f64 {
        return lo;
    }
    if n > hi as f64 {
        return hi;
    }
    n as i32
}

// ---------------------------------------------------------------------------
// Dashboard tiles
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTile {
    #[serde(default)]
    saved_query_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    chart_override: Option<Value>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    w: Option<f64>,
    #[serde(default)]
    h: Option<f64>,
}

/// `POST /:id/tiles` — 201.
async fn tile_add(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<CreateTile>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let connection_id = assert_manage_dashboard(&state, &id, &user.id).await?;
    let saved_query_id = body
        .saved_query_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("savedQueryId must be a string"))?;
    // The saved query must live on the same connection — a cross-connection tile
    // would break share links and confuse RBAC.
    let sq_conn: Option<String> = sqlx::query_scalar(r#"SELECT "connectionId" FROM "SavedQuery" WHERE "id" = $1"#)
        .bind(&saved_query_id)
        .fetch_optional(&state.pool)
        .await?;
    let sq_conn = sq_conn.ok_or_else(|| ApiError::bad("Saved query not found"))?;
    if sq_conn != connection_id {
        return Err(ApiError::bad("Saved query must belong to this dashboard's connection"));
    }
    // Auto-layout: append below the current content. v1 adds the two maxima
    // independently (max(y) + max(h)), which is what this reproduces.
    let default_y: i32 = sqlx::query_scalar(
        r#"SELECT COALESCE(MAX("y"),0) + COALESCE(MAX("h"),0) FROM "DashboardTile" WHERE "dashboardId" = $1"#,
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;

    let r = sqlx::query(&format!(
        r#"INSERT INTO "DashboardTile" ("id","dashboardId","savedQueryId","chartOverride","title","x","y","w","h","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING {TILE_COLS}"#
    ))
    .bind(gen_id())
    .bind(&id)
    .bind(&saved_query_id)
    .bind(&body.chart_override)
    .bind(body.title.as_deref().map(|t| t.chars().take(120).collect::<String>()))
    .bind(clamp_int(body.x.unwrap_or(0.0), 0, 12))
    .bind(clamp_int(body.y.unwrap_or(default_y as f64), 0, 10_000))
    .bind(clamp_int(body.w.unwrap_or(6.0), 1, 12))
    .bind(clamp_int(body.h.unwrap_or(4.0), 1, 20))
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(tile_dto(&r))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTile {
    #[serde(default, deserialize_with = "double_opt")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_opt")]
    chart_override: Option<Option<Value>>,
    #[serde(default)]
    x: Option<f64>,
    #[serde(default)]
    y: Option<f64>,
    #[serde(default)]
    w: Option<f64>,
    #[serde(default)]
    h: Option<f64>,
}

/// `PATCH /:id/tiles/:tileId`.
async fn tile_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, tile_id)): Path<(String, String)>,
    Json(body): Json<UpdateTile>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    let (title_set, title) = match &body.title {
        None => (false, None),
        // v1: `patch.title ? slice(0,120) : null` — "" clears the override.
        Some(t) => (
            true,
            t.as_deref()
                .map(|t| t.chars().take(120).collect::<String>())
                .filter(|t| !t.is_empty()),
        ),
    };
    let (chart_set, chart) = match &body.chart_override {
        None => (false, None),
        // v1: `patch.chartOverride ?? Prisma.DbNull` — an explicit null stores
        // SQL NULL, not a JSON `null`.
        Some(c) => (true, c.clone()),
    };
    // SECURITY: both ids in the WHERE. Scoping by tile id alone let a tile id
    // from someone else's dashboard (share links expose them) be written to
    // after authorizing your own dashboard.
    let r = sqlx::query(&format!(
        r#"UPDATE "DashboardTile" SET
             "title" = CASE WHEN $3 THEN $4::text ELSE "title" END,
             "chartOverride" = CASE WHEN $5 THEN $6::jsonb ELSE "chartOverride" END,
             "x" = CASE WHEN $7::int IS NULL THEN "x" ELSE $7::int END,
             "y" = CASE WHEN $8::int IS NULL THEN "y" ELSE $8::int END,
             "w" = CASE WHEN $9::int IS NULL THEN "w" ELSE $9::int END,
             "h" = CASE WHEN $10::int IS NULL THEN "h" ELSE $10::int END
           WHERE "id" = $1 AND "dashboardId" = $2 RETURNING {TILE_COLS}"#
    ))
    .bind(&tile_id)
    .bind(&id)
    .bind(title_set)
    .bind(title)
    .bind(chart_set)
    .bind(chart)
    .bind(body.x.map(|v| clamp_int(v, 0, 12)))
    .bind(body.y.map(|v| clamp_int(v, 0, 10_000)))
    .bind(body.w.map(|v| clamp_int(v, 1, 12)))
    .bind(body.h.map(|v| clamp_int(v, 1, 20)))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Tile not found"))?;
    Ok(Json(tile_dto(&r)))
}

/// `DELETE /:id/tiles/:tileId`.
async fn tile_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, tile_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    // SECURITY: as above — without dashboardId this deleted any tile by id.
    let res = sqlx::query(r#"DELETE FROM "DashboardTile" WHERE "id" = $1 AND "dashboardId" = $2"#)
        .bind(&tile_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Tile not found"));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct ReorderTile {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Deserialize)]
struct ReorderTiles {
    #[serde(default)]
    tiles: Vec<ReorderTile>,
}

/// `PUT /:id/tiles` — one transaction, so a failure mid-drag can't leave half
/// the grid moved.
async fn tiles_reorder(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<ReorderTiles>,
) -> ApiResult<Json<Value>> {
    assert_manage_dashboard(&state, &id, &user.id).await?;
    let mut tx = state.pool.begin().await?;
    for t in &body.tiles {
        // SECURITY: dashboardId in the WHERE so a foreign tile id in the payload
        // matches nothing instead of being repositioned.
        sqlx::query(
            r#"UPDATE "DashboardTile" SET "x" = $3, "y" = $4, "w" = $5, "h" = $6
                WHERE "id" = $1 AND "dashboardId" = $2"#,
        )
        .bind(&t.id)
        .bind(&id)
        .bind(clamp_int(t.x, 0, 12))
        .bind(clamp_int(t.y, 0, 10_000))
        .bind(clamp_int(t.w, 1, 12))
        .bind(clamp_int(t.h, 1, 20))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

/// `POST /:id/tiles/:tileId/run` — 200. Separate from /query so dashboard polls
/// don't burn the ad-hoc query throttle bucket.
async fn tile_run(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, tile_id)): Path<(String, String)>,
    req: Request,
) -> Result<Response, ApiError> {
    // Access gate — same logic as GET /:id, so connection viewers can refresh
    // tiles on a dashboard they didn't create.
    let d = load_dashboard(&state, &id).await?;
    if text(&d, "ownerId") != user.id {
        require_role(&state.pool, &text(&d, "connectionId"), &user.id, "VIEWER").await?;
    }
    // SECURITY: the tile must belong to the dashboard we just authorized.
    // Looking it up by tileId alone authorized *your* dashboard and then ran
    // *someone else's* tile against *their* connection.
    let tile = load_tile_query(&state, &tile_id, &text(&d, "id")).await?;
    // Masks are the caller's; the dashboard being someone else's changes nothing.
    run_saved_query(&state, &tile.1, &tile.0, &user.id, req).await
}

/// Resolve a tile's SQL + connection, scoped to its dashboard. Returns
/// `(sqlText, connectionId)`.
async fn load_tile_query(state: &AppState, tile_id: &str, dashboard_id: &str) -> ApiResult<(String, String)> {
    let r = sqlx::query(
        r#"SELECT sq."sqlText", sq."connectionId"
             FROM "DashboardTile" t
             JOIN "SavedQuery" sq ON sq."id" = t."savedQueryId"
            WHERE t."id" = $1 AND t."dashboardId" = $2"#,
    )
    .bind(tile_id)
    .bind(dashboard_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Tile not found"))?;
    Ok((text(&r, "sqlText"), text(&r, "connectionId")))
}

// ---------------------------------------------------------------------------
// Public share — /api/public/dashboards/:token (no JWT)
// ---------------------------------------------------------------------------

/// Read-only view for anyone holding the share token. Only what's needed to
/// render is returned — no owner, no connection id, no share token.
async fn public_dashboard_get(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    let d = load_shared_dashboard(&state, &token).await?;
    let tiles = sqlx::query(
        r#"SELECT t."id", t."title", t."chartOverride", t."x", t."y", t."w", t."h",
                  sq."name" AS "sqName", sq."chartConfig" AS "sqChartConfig"
             FROM "DashboardTile" t
             JOIN "SavedQuery" sq ON sq."id" = t."savedQueryId"
            WHERE t."dashboardId" = $1
            ORDER BY t."y" ASC, t."id" ASC"#,
    )
    .bind(text(&d, "id"))
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "id": text(&d, "id"),
        "name": text(&d, "name"),
        "description": opt_text_col(&d, "description"),
        "refreshSec": d.try_get::<Option<i32>, _>("refreshSec").ok().flatten(),
        "tiles": tiles.iter().map(|r| json!({
            "id": text(r, "id"),
            // v1: `t.title ?? t.savedQuery.name`
            "title": opt_text_col(r, "title").unwrap_or_else(|| text(r, "sqName")),
            // v1: `t.chartOverride ?? t.savedQuery.chartConfig`. A JSON `null`
            // reads back as JS null through Prisma, so it falls back too.
            "chartConfig": json_col(r, "chartOverride")
                .filter(|v| !v.is_null())
                .or_else(|| json_col(r, "sqChartConfig")),
            "x": r.try_get::<i32, _>("x").unwrap_or(0),
            "y": r.try_get::<i32, _>("y").unwrap_or(0),
            "w": r.try_get::<i32, _>("w").unwrap_or(6),
            "h": r.try_get::<i32, _>("h").unwrap_or(4),
        })).collect::<Vec<_>>(),
    })))
}

/// `POST /public/dashboards/:token/tiles/:tileId/run` — 200, unauthenticated.
async fn public_tile_run(
    State(state): State<AppState>,
    Path((token, tile_id)): Path<(String, String)>,
    req: Request,
) -> Result<Response, ApiError> {
    let d = load_shared_dashboard(&state, &token).await?;
    let tile = load_tile_query(&state, &tile_id, &text(&d, "id")).await?;
    // SECURITY: mask as the publisher. This endpoint is unauthenticated, so
    // without it a masked user could publish a dashboard and read their masked
    // columns straight back out of a public URL. A share can never reveal more
    // than the person who published it could see.
    run_saved_query(&state, &tile.1, &tile.0, &text(&d, "ownerId"), req).await
}

async fn load_shared_dashboard(state: &AppState, token: &str) -> ApiResult<PgRow> {
    sqlx::query(
        r#"SELECT "id","name","description","refreshSec","ownerId"
             FROM "Dashboard" WHERE "shareToken" = $1"#,
    )
    .bind(token)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Dashboard not found"))
}

// ---------------------------------------------------------------------------
// Tile execution against the target database
// ---------------------------------------------------------------------------

/// Run a tile's saved query and shape the result like v1's `QueryResult`
/// (`{rows, fields, rowCount, command, durationMs}`).
///
/// v1 always runs tiles as VIEWER — charting a destructive statement on a timer
/// would be a footgun — which means a read-only session, so this sets
/// `SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` plus the connection's
/// statement timeout, exactly as the Node Postgres driver does per checkout.
/// `mask_user_id`'s column masks are applied to every row on the way out.
///
/// Anything Rust can't execute faithfully (agent tunnel, non-Postgres dialect,
/// no ENCRYPTION_KEY) falls through to the v1 proxy rather than failing.
async fn run_saved_query(
    state: &AppState,
    connection_id: &str,
    sql: &str,
    mask_user_id: &str,
    req: Request,
) -> Result<Response, ApiError> {
    let conn = sqlx::query(
        r#"SELECT "credentialsCt", "dialect"::text AS dialect, "statementTimeoutMs", "viaAgent"
             FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::bad("Connection not found"))?;

    let dialect = text(&conn, "dialect").to_lowercase();
    let via_agent = conn.try_get::<bool, _>("viaAgent").unwrap_or(false);
    // The agent tunnel lives only in the Node backend, and v2 has no non-Postgres
    // drivers — hand those to v1 instead of erroring (mirrors `agent_guard`).
    if via_agent || !dialect.contains("postgres") || state.crypto.is_none() {
        return Ok(crate::proxy(State(state.clone()), req).await);
    }
    let crypto = state.crypto.as_ref().expect("checked above");
    let ct = text(&conn, "credentialsCt");
    let creds_json = crypto
        .decrypt(&ct, &crate::crypto::Crypto::conn_purpose(connection_id))
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

    let timeout_ms = conn.try_get::<i32, _>("statementTimeoutMs").unwrap_or(30_000);
    let _ = sqlx::query(&format!("SET statement_timeout = {timeout_ms}"))
        .execute(&mut c)
        .await;
    // VIEWER == read-only driver in v1.
    let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        .execute(&mut c)
        .await;

    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    let command = trimmed.split_whitespace().next().unwrap_or("").to_uppercase();
    let start = Instant::now();
    let lower = trimmed.to_lowercase();
    let is_select = lower.starts_with("select") || lower.starts_with("with") || lower.starts_with("table");

    let masked = masked_columns(&state.pool, connection_id, mask_user_id).await?;

    let out = if is_select {
        // Column metadata via describe so a zero-row result still names its
        // columns (v1 gets these from pg's result descriptor).
        let fields: Vec<Value> = match (&mut c).describe(trimmed.as_str()).await {
            Ok(d) => d
                .columns()
                .iter()
                .map(|col| json!({ "name": col.name(), "dataType": col.type_info().name() }))
                .collect(),
            Err(_) => vec![],
        };
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM ({trimmed}) t",
        );
        let mut rows: Value = sqlx::query_scalar(&wrapped).fetch_one(&mut c).await?;
        let dur = ms(start);
        apply_masks(&mut rows, &masked);
        let row_count = rows.as_array().map(|a| a.len()).unwrap_or(0);
        let fields = if fields.is_empty() {
            rows.as_array()
                .and_then(|a| a.first())
                .and_then(|r| r.as_object())
                .map(|o| o.keys().map(|k| json!({ "name": k })).collect())
                .unwrap_or_default()
        } else {
            fields
        };
        json!({
            "rows": rows,
            "fields": fields,
            "rowCount": row_count,
            "command": command,
            "durationMs": dur,
        })
    } else {
        // Non-SELECT tiles hit the read-only session and error, exactly as in v1.
        let affected = sqlx::query(&trimmed).execute(&mut c).await?.rows_affected();
        json!({
            "rows": [],
            "fields": [],
            "rowCount": affected,
            "command": command,
            "durationMs": ms(start),
        })
    };
    Ok(Json(out).into_response())
}

/// The column names masked for this user on this connection. v1 wraps the whole
/// driver so masked columns can never come back; here there is a single row
/// path, so the null-out happens on it.
async fn masked_columns(pool: &PgPool, connection_id: &str, user_id: &str) -> ApiResult<Vec<String>> {
    Ok(
        sqlx::query_scalar::<_, String>(
            r#"SELECT DISTINCT "columnName" FROM "ColumnMask" WHERE "connectionId" = $1 AND "userId" = $2"#,
        )
        .bind(connection_id)
        .bind(user_id)
        .fetch_all(pool)
        .await?,
    )
}

fn apply_masks(rows: &mut Value, masked: &[String]) {
    if masked.is_empty() {
        return;
    }
    if let Some(arr) = rows.as_array_mut() {
        for row in arr.iter_mut() {
            if let Some(obj) = row.as_object_mut() {
                for col in masked {
                    if obj.contains_key(col.as_str()) {
                        obj.insert(col.clone(), Value::Null);
                    }
                }
            }
        }
    }
}

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_micros() as f64) / 1000.0
}

/// serde helper: distinguish "key absent" from "key present but null" so a
/// PATCH can clear a nullable column (`Option<Option<T>>`).
fn double_opt<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}
