//! Audit log endpoints — Rust port of v1's `AuditController` + `AuditService`
//! (`backend/src/audit/`).
//!
//! Wire-compatible with v1 by design: same paths, same status codes, same error
//! messages, same JSON field names and the same `{ items, nextCursor? }` keyset
//! pagination envelope (`"<iso createdAt>|<id>"`), so the cursor a v1 response
//! handed out still resolves here and vice-versa.
//!
//! Ported: list, query-history, export.csv, revert-preview.
//! `POST .../revert` lives in `lastmile.rs` — it writes to the *target*
//! database, so it needs the driver layer (`connect_target` + the row writers)
//! rather than just the app DB. It reuses `audit_require_role` from here so
//! both halves of the audit surface enforce RBAC identically.

use std::collections::HashSet;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connections/:id/audit", get(audit_list))
        // Static siblings must be registered alongside the `:entryId` param
        // segment; matchit prefers the literal, so these never shadow.
        .route("/api/connections/:id/audit/export.csv", get(audit_export_csv))
        .route("/api/connections/:id/audit/query-history", get(audit_query_history))
        .route(
            "/api/connections/:id/audit/:entryId/revert-preview",
            get(audit_revert_preview),
        )
    // NOTE: POST "/api/connections/:id/audit/:entryId/revert" is registered by
    // `lastmile::routes()` (same `:id` / `:entryId` param names, so the merge
    // does not conflict).
}

// ---------------------------------------------------------------------------
// RBAC — mirrors v1 RbacService.effectiveRole / .require exactly.
// ---------------------------------------------------------------------------

fn role_rank(role: &str) -> i32 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        "VIEWER" => 1,
        _ => 0,
    }
}

/// v1 `RbacService.require`: owner > direct ConnectionMember > WorkspaceMember,
/// first hit wins. 404 when the connection does not exist, 403 when the caller
/// has no role at all or ranks below `min` — with v1's exact messages.
///
/// `pub(crate)` so `lastmile::audit_revert` gates on the identical check.
pub(crate) async fn audit_require_role(
    state: &AppState,
    conn_id: &str,
    user_id: &str,
    min: &str,
) -> ApiResult<String> {
    let row = sqlx::query(
        r#"SELECT CASE
               WHEN c."ownerId" = $2 THEN 'OWNER'
               WHEN m."role" IS NOT NULL THEN m."role"::text
               WHEN wm."role" IS NOT NULL THEN wm."role"::text
               ELSE NULL END AS "role"
           FROM "Connection" c
           LEFT JOIN "ConnectionMember" m ON m."connectionId" = c."id" AND m."userId" = $2
           LEFT JOIN "WorkspaceMember" wm ON wm."workspaceId" = c."workspaceId" AND wm."userId" = $2
           WHERE c."id" = $1 LIMIT 1"#,
    )
    .bind(conn_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let role: Option<String> = row.try_get("role").ok().flatten();
    let role = role
        .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"))?;
    if role_rank(&role) < role_rank(min) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {min} role (have {role})"),
        ));
    }
    Ok(role)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// Dynamic bind values, so the WHERE clause can be assembled per-request while
/// staying fully parameterised.
enum Bind {
    Text(String),
    TextArray(Vec<String>),
    Ts(chrono::NaiveDateTime),
    Int(i64),
}

fn bind_all<'q>(
    sql: &'q str,
    binds: Vec<Bind>,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = match b {
            Bind::Text(v) => q.bind(v),
            Bind::TextArray(v) => q.bind(v),
            Bind::Ts(v) => q.bind(v),
            Bind::Int(v) => q.bind(v),
        };
    }
    q
}

/// JS `parseInt(s, 10)` — leading whitespace, optional sign, leading digits.
/// Returns None where JS would produce NaN (callers then use v1's default).
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
    let v = digits.parse::<i64>().ok()?;
    Some(if neg { -v } else { v })
}

/// `Date.prototype.toISOString()` — always UTC, always exactly 3 fractional
/// digits, always `Z`. The cursor round-trips through v1, so the format has to
/// match byte-for-byte.
fn iso_ms(dt: chrono::NaiveDateTime) -> String {
    dt.and_utc().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn row_created_at(r: &PgRow) -> chrono::NaiveDateTime {
    // "createdAt" is TIMESTAMP(3) (Prisma DateTime), i.e. naive UTC.
    r.try_get::<chrono::NaiveDateTime, _>("createdAt")
        .unwrap_or_default()
}

/// `new Date(str)` for the ISO strings we (and v1) emit in cursors.
fn parse_js_date(s: &str) -> Option<chrono::NaiveDateTime> {
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(d.naive_utc());
    }
    if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(d);
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
}

/// Cursor shape `"<iso createdAt>|<id>"`. v1 requires `indexOf('|') > 0` and a
/// parseable date, and silently ignores the cursor otherwise.
fn parse_cursor(cursor: &str) -> Option<(chrono::NaiveDateTime, String)> {
    let pipe = cursor.find('|')?;
    if pipe == 0 {
        return None;
    }
    let dt = parse_js_date(&cursor[..pipe])?;
    Some((dt, cursor[pipe + 1..].to_string()))
}

/// `r.user ? (r.user.displayName || r.user.email) : null`. "User"."email" is
/// NOT NULL, so a NULL here means the LEFT JOIN found no user.
fn user_label(r: &PgRow) -> Option<String> {
    let email: Option<String> = r.try_get("email").ok().flatten();
    let display: Option<String> = r.try_get("displayName").ok().flatten();
    email.map(|e| display.filter(|d| !d.is_empty()).unwrap_or(e))
}

/// v1 `maskMetadata`: recursively NULL every value whose key is a masked column.
/// Audit metadata carries before/after row snapshots, so a masked VIEWER must
/// not be able to read masked values back out of the history.
fn mask_metadata(v: Value, masked: &HashSet<String>) -> Value {
    if masked.is_empty() || v.is_null() {
        return v;
    }
    match v {
        Value::Array(a) => Value::Array(a.into_iter().map(|x| mask_metadata(x, masked)).collect()),
        Value::Object(o) => {
            // Rebuild rather than mutate in place so key order survives
            // (serde_json is built with preserve_order here).
            let mut out = serde_json::Map::with_capacity(o.len());
            for (k, val) in o {
                let nv = if masked.contains(&k) {
                    Value::Null
                } else {
                    mask_metadata(val, masked)
                };
                out.insert(k, nv);
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Masked column names for a reader on a connection (empty for owners).
async fn masked_columns_for(
    state: &AppState,
    user_id: &str,
    conn_id: &str,
) -> ApiResult<HashSet<String>> {
    let rows = sqlx::query(
        r#"SELECT "columnName" FROM "ColumnMask" WHERE "connectionId" = $1 AND "userId" = $2"#,
    )
    .bind(conn_id)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>("columnName").ok())
        .collect())
}

const AUDIT_COLS: &str = r#"a."id", a."userId", a."connectionId", a."action"::text AS "action",
       a."sqlText", a."affectedRows", a."ip", a."userAgent", a."metadata", a."createdAt",
       u."email", u."displayName""#;

// ---------------------------------------------------------------------------
// GET /api/connections/:id/audit  — @RequireRole('VIEWER')
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AuditListQuery {
    limit: Option<String>,
    cursor: Option<String>,
}

async fn audit_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<AuditListQuery>,
) -> ApiResult<Json<Value>> {
    audit_require_role(&state, &id, &user.id, "VIEWER").await?;

    // Controller default 100; service clamps to [1, 500].
    let limit = q
        .limit
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(parse_int_js)
        .unwrap_or(100);
    let take = limit.clamp(1, 500);
    let masked = masked_columns_for(&state, &user.id, &id).await?;

    let mut sql = format!(
        r#"SELECT {AUDIT_COLS}
           FROM "AuditLog" a
           LEFT JOIN "User" u ON u."id" = a."userId"
           WHERE a."connectionId" = $1"#
    );
    let mut binds: Vec<Bind> = vec![Bind::Text(id.clone())];
    let mut n = 1;

    // Keyset pagination anchored by ("connectionId", "createdAt" DESC, "id" DESC).
    if let Some((ts, cid)) = q.cursor.as_deref().filter(|s| !s.is_empty()).and_then(parse_cursor) {
        sql.push_str(&format!(
            r#" AND (a."createdAt" < ${} OR (a."createdAt" = ${} AND a."id" < ${}))"#,
            n + 1,
            n + 1,
            n + 2
        ));
        binds.push(Bind::Ts(ts));
        binds.push(Bind::Text(cid));
        n += 2;
    }
    sql.push_str(&format!(
        r#" ORDER BY a."createdAt" DESC, a."id" DESC LIMIT ${}"#,
        n + 1
    ));
    binds.push(Bind::Int(take + 1));

    let rows = bind_all(&sql, binds).fetch_all(&state.pool).await?;
    let has_more = rows.len() as i64 > take;
    let items = if has_more { &rows[..take as usize] } else { &rows[..] };

    let out: Vec<Value> = items
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "userId": r.try_get::<Option<String>, _>("userId").ok().flatten(),
                "user": user_label(r),
                "connectionId": r.try_get::<Option<String>, _>("connectionId").ok().flatten(),
                "action": r.try_get::<String, _>("action").unwrap_or_default(),
                "sqlText": r.try_get::<Option<String>, _>("sqlText").ok().flatten(),
                "affectedRows": r.try_get::<Option<i32>, _>("affectedRows").ok().flatten(),
                "ip": r.try_get::<Option<String>, _>("ip").ok().flatten(),
                "userAgent": r.try_get::<Option<String>, _>("userAgent").ok().flatten(),
                "metadata": mask_metadata(
                    r.try_get::<Option<Value>, _>("metadata").ok().flatten().unwrap_or(Value::Null),
                    &masked,
                ),
                "createdAt": iso_ms(row_created_at(r)),
            })
        })
        .collect();

    Ok(Json(paged(out, has_more, items)))
}

/// `{ items, nextCursor? }` — `nextCursor` is omitted entirely when absent,
/// matching `JSON.stringify` dropping `undefined`.
fn paged(items: Vec<Value>, has_more: bool, rows: &[PgRow]) -> Value {
    let mut body = json!({ "items": items });
    if has_more {
        if let Some(last) = rows.last() {
            let cursor = format!(
                "{}|{}",
                iso_ms(row_created_at(last)),
                last.try_get::<String, _>("id").unwrap_or_default()
            );
            body["nextCursor"] = json!(cursor);
        }
    }
    body
}

// ---------------------------------------------------------------------------
// GET /api/connections/:id/audit/query-history  — @RequireRole('VIEWER')
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryHistoryQuery {
    limit: Option<String>,
    cursor: Option<String>,
    user_id: Option<String>,
    since_ms: Option<String>,
    search: Option<String>,
    action: Option<String>,
}

async fn audit_query_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<QueryHistoryQuery>,
) -> ApiResult<Json<Value>> {
    audit_require_role(&state, &id, &user.id, "VIEWER").await?;

    // Controller default 50; service clamps to [1, 200].
    let limit = q
        .limit
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(parse_int_js)
        .unwrap_or(50);
    let take = limit.clamp(1, 200);
    let masked = masked_columns_for(&state, &user.id, &id).await?;

    let actions: Vec<String> = match q.action.as_deref().filter(|s| !s.is_empty()) {
        Some(a) => vec![a.to_string()],
        None => vec!["QUERY_RUN".to_string(), "SCHEMA_CHANGE".to_string()],
    };

    let mut sql = format!(
        r#"SELECT {AUDIT_COLS}
           FROM "AuditLog" a
           LEFT JOIN "User" u ON u."id" = a."userId"
           WHERE a."connectionId" = $1 AND a."action"::text = ANY($2)"#
    );
    let mut binds: Vec<Bind> = vec![Bind::Text(id.clone()), Bind::TextArray(actions)];
    let mut n = 2;

    if let Some(uid) = q.user_id.as_deref().filter(|s| !s.is_empty()) {
        n += 1;
        sql.push_str(&format!(r#" AND a."userId" = ${n}"#));
        binds.push(Bind::Text(uid.to_string()));
    }
    if let Some(since) = q
        .since_ms
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(parse_int_js)
        .filter(|v| *v > 0)
    {
        n += 1;
        sql.push_str(&format!(r#" AND a."createdAt" >= ${n}"#));
        binds.push(Bind::Ts(
            (chrono::Utc::now() - chrono::Duration::milliseconds(since)).naive_utc(),
        ));
    }
    if let Some(search) = q
        .search
        .as_deref()
        .filter(|s| !s.is_empty() && !s.trim().is_empty())
    {
        // Capped at 200 chars so a huge paste doesn't tank the query. Wildcards
        // are NOT escaped — Prisma's `contains` doesn't either, and this must
        // behave identically.
        let needle: String = search.chars().take(200).collect();
        n += 1;
        sql.push_str(&format!(r#" AND a."sqlText" ILIKE '%' || ${n} || '%'"#));
        binds.push(Bind::Text(needle));
    }
    if let Some((ts, cid)) = q.cursor.as_deref().filter(|s| !s.is_empty()).and_then(parse_cursor) {
        sql.push_str(&format!(
            r#" AND (a."createdAt" < ${} OR (a."createdAt" = ${} AND a."id" < ${}))"#,
            n + 1,
            n + 1,
            n + 2
        ));
        binds.push(Bind::Ts(ts));
        binds.push(Bind::Text(cid));
        n += 2;
    }
    sql.push_str(&format!(
        r#" ORDER BY a."createdAt" DESC, a."id" DESC LIMIT ${}"#,
        n + 1
    ));
    binds.push(Bind::Int(take + 1));

    let rows = bind_all(&sql, binds).fetch_all(&state.pool).await?;
    let has_more = rows.len() as i64 > take;
    let items = if has_more { &rows[..take as usize] } else { &rows[..] };

    // Narrower DTO than /audit — no connectionId / ip / userAgent.
    let out: Vec<Value> = items
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "userId": r.try_get::<Option<String>, _>("userId").ok().flatten(),
                "user": user_label(r),
                "action": r.try_get::<String, _>("action").unwrap_or_default(),
                "sqlText": r.try_get::<Option<String>, _>("sqlText").ok().flatten(),
                "affectedRows": r.try_get::<Option<i32>, _>("affectedRows").ok().flatten(),
                "metadata": mask_metadata(
                    r.try_get::<Option<Value>, _>("metadata").ok().flatten().unwrap_or(Value::Null),
                    &masked,
                ),
                "createdAt": iso_ms(row_created_at(r)),
            })
        })
        .collect();

    Ok(Json(paged(out, has_more, items)))
}

// ---------------------------------------------------------------------------
// GET /api/connections/:id/audit/export.csv  — @RequireRole('OWNER')
// ---------------------------------------------------------------------------

/// v1 `esc`: quote only when the value contains `"`, `,` or a newline.
fn csv_esc(s: &str) -> String {
    if s.contains('"') || s.contains(',') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

async fn audit_export_csv(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    // OWNER-only: the export includes everyone's SQL, unmasked.
    audit_require_role(&state, &id, &user.id, "OWNER").await?;

    let rows = sqlx::query(
        r#"SELECT a."action"::text AS "action", a."sqlText", a."affectedRows", a."ip",
                  a."createdAt", u."email", u."displayName"
           FROM "AuditLog" a
           LEFT JOIN "User" u ON u."id" = a."userId"
           WHERE a."connectionId" = $1
           ORDER BY a."createdAt" DESC
           LIMIT 50000"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let mut csv = String::from("createdAt,user,action,affectedRows,ip,sqlText");
    for r in &rows {
        // createdAt goes in raw — v1 doesn't run it through `esc` either.
        csv.push('\n');
        csv.push_str(&iso_ms(row_created_at(r)));
        csv.push(',');
        csv.push_str(&csv_esc(&user_label(r).unwrap_or_default()));
        csv.push(',');
        csv.push_str(&csv_esc(&r.try_get::<String, _>("action").unwrap_or_default()));
        csv.push(',');
        csv.push_str(&csv_esc(
            &r.try_get::<Option<i32>, _>("affectedRows")
                .ok()
                .flatten()
                .map(|v| v.to_string())
                .unwrap_or_default(),
        ));
        csv.push(',');
        csv.push_str(&csv_esc(
            &r.try_get::<Option<String>, _>("ip").ok().flatten().unwrap_or_default(),
        ));
        csv.push(',');
        csv.push_str(&csv_esc(
            &r.try_get::<Option<String>, _>("sqlText").ok().flatten().unwrap_or_default(),
        ));
    }

    let filename = format!(
        "audit-{}-{}.csv",
        id,
        chrono::Utc::now().format("%Y-%m-%d")
    );
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(Body::from(csv))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()))
}

// ---------------------------------------------------------------------------
// GET /api/connections/:id/audit/:entryId/revert-preview — @RequireRole('EDITOR')
//
// Pure metadata inspection — v1's `AuditRevertService.buildPreview` never
// touches the target database, so it ports cleanly. (The sibling POST /revert
// does, and is not ported.)
// ---------------------------------------------------------------------------

/// JS truthiness, for the `metadata.x && ...` guards in v1's `preview`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn truthy_key(v: &Value, key: &str) -> bool {
    v.get(key).map(truthy).unwrap_or(false)
}

async fn audit_revert_preview(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, entry_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    audit_require_role(&state, &id, &user.id, "EDITOR").await?;

    let row = sqlx::query(
        r#"SELECT "connectionId", "action"::text AS "action", "metadata"
           FROM "AuditLog" WHERE "id" = $1 LIMIT 1"#,
    )
    .bind(&entry_id)
    .fetch_optional(&state.pool)
    .await?
    // v1 loadEntry: not found *or* belonging to another connection → 404.
    .filter(|r| {
        r.try_get::<Option<String>, _>("connectionId").ok().flatten().as_deref() == Some(id.as_str())
    })
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Audit entry not found"))?;

    let action = row.try_get::<String, _>("action").unwrap_or_default();
    let metadata = row
        .try_get::<Option<Value>, _>("metadata")
        .ok()
        .flatten()
        .unwrap_or_else(|| json!({}));

    let schema = metadata.get("schema").and_then(|v| v.as_str()).unwrap_or("");
    let table = metadata.get("tableName").and_then(|v| v.as_str()).unwrap_or("");
    let table_ref = if !schema.is_empty() && !table.is_empty() {
        format!("{schema}.{table}")
    } else {
        "unknown table".to_string()
    };

    if truthy_key(&metadata, "bulk") {
        if let Some(before_rows) = metadata
            .get("beforeRows")
            .filter(|v| truthy(v))
            .and_then(|v| v.as_array())
        {
            let n = before_rows.len();
            if action == "ROW_DELETE" {
                return Ok(Json(json!({
                    "kind": "bulk-delete",
                    "description": format!("Restore {n} deleted row(s) in {table_ref}"),
                    "rowCount": n,
                })));
            }
            if action == "ROW_UPDATE" {
                return Ok(Json(json!({
                    "kind": "bulk-update",
                    "description": format!("Revert {n} updated row(s) in {table_ref}"),
                    "rowCount": n,
                })));
            }
        }
    }
    if action == "ROW_INSERT" && truthy_key(&metadata, "after") {
        return Ok(Json(json!({
            "kind": "delete",
            "description": format!("Delete the inserted row in {table_ref}"),
            "rowCount": 1,
        })));
    }
    if action == "ROW_UPDATE" && truthy_key(&metadata, "before") && truthy_key(&metadata, "pk") {
        return Ok(Json(json!({
            "kind": "update",
            "description": format!("Revert the update in {table_ref}"),
            "rowCount": 1,
        })));
    }
    if action == "ROW_DELETE" && truthy_key(&metadata, "before") {
        return Ok(Json(json!({
            "kind": "insert",
            "description": format!("Re-insert the deleted row in {table_ref}"),
            "rowCount": 1,
        })));
    }
    Err(ApiError::bad(
        "This audit entry is not revertable (missing snapshot data).",
    ))
}
