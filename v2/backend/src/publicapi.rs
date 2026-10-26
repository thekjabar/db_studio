//! The key-authenticated API under `/api/v1/*` — what scripts, CI and the CLI
//! talk to.
//!
//! v1 source: `backend/src/api-keys/public-api.controller.ts` + `api-key.guard.ts`.
//!
//! This is the half of the API-keys feature that was never ported. Keys could
//! be minted in the UI, but nothing accepted one: `AuthUser` only decodes JWTs,
//! so every `dbs_live_…` token answered 401 "Invalid or expired token" and the
//! feature was decorative. The routes below are the only ones that take a key.
//!
//! Three rules, all from v1:
//!   * **Two-step token check.** sha256 for the O(1) unique-index lookup, then
//!     an argon2 verify of the same token. The digest alone would be enough
//!     today; the argon2 pass is the belt to its braces.
//!   * **Scoping.** A key created for specific connections may not touch any
//!     other, even one its owner can see in the UI.
//!   * **Masking still applies.** The query runs as the key's OWNER, through
//!     the same role check as the UI, so a key cannot read a column its user is
//!     masked from.
//!
//! Rate limiting is a per-key sliding window kept in this process (v1 used
//! Redis when present, an in-process map otherwise; this deployment is
//! single-pod, which is the case v1's fallback was written for).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::{
    extract::{FromRequestParts, Path, Query, State},
    http::request::Parts,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{ApiError, ApiResult, AppState};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/connections", get(list_connections))
        .route("/api/v1/connections/:id/schemas", get(list_schemas))
        .route("/api/v1/connections/:id/tables", get(list_tables))
        .route("/api/v1/connections/:id/query", post(run_query))
}

/// Requests per key per minute. v1's `API_KEY_RATE_LIMIT`, same default.
fn rate_limit() -> u32 {
    std::env::var("API_KEY_RATE_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120)
}

struct Window {
    count: u32,
    reset_at: i64,
}

fn windows() -> &'static Mutex<HashMap<String, Window>> {
    static W: OnceLock<Mutex<HashMap<String, Window>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A caller authenticated by an API key.
pub(crate) struct ApiKeyUser {
    pub user_id: String,
    /// Empty means the key is unscoped and may use any of its owner's connections.
    pub connection_ids: Vec<String>,
}

impl ApiKeyUser {
    /// v1 `assertConnectionAllowed`.
    fn assert_allowed(&self, connection_id: &str) -> ApiResult<()> {
        if self.connection_ids.is_empty()
            || self.connection_ids.iter().any(|c| c == connection_id)
        {
            return Ok(());
        }
        Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "API key is not scoped to this connection",
        ))
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for ApiKeyUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let raw = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| ApiError::unauthorized("Missing bearer token"))?;

        if !raw.starts_with(crate::API_KEY_PREFIX) {
            return Err(ApiError::unauthorized(
                "This endpoint takes an API key (dbs_live_…), not a session token",
            ));
        }

        let row = sqlx::query(
            r#"SELECT "id","userId","tokenHash","connectionIds","revokedAt","expiresAt"
                 FROM "ApiKey" WHERE "tokenSha" = $1 LIMIT 1"#,
        )
        .bind(crate::sha256_hex(raw))
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("Invalid API key"))?;

        // Fail loudly on a decode error rather than reading a revoked key as live.
        let revoked_at: Option<chrono::NaiveDateTime> = row
            .try_get("revokedAt")
            .map_err(|e| ApiError::internal(format!("api key revokedAt: {e}")))?;
        if revoked_at.is_some() {
            return Err(ApiError::unauthorized("API key revoked"));
        }
        let expires_at: Option<chrono::NaiveDateTime> = row
            .try_get("expiresAt")
            .map_err(|e| ApiError::internal(format!("api key expiresAt: {e}")))?;
        if expires_at.is_some_and(|e| e < chrono::Utc::now().naive_utc()) {
            return Err(ApiError::unauthorized("API key expired"));
        }

        let hash: String = row.try_get("tokenHash").unwrap_or_default();
        if crate::verify_argon2(raw, &hash).is_err() {
            return Err(ApiError::unauthorized("API key invalid"));
        }

        let key_id: String = row.try_get("id").unwrap_or_default();
        let user_id: String = row.try_get("userId").unwrap_or_default();
        let connection_ids: Vec<String> = row.try_get("connectionIds").unwrap_or_default();

        // Rate limit, per key, one-minute buckets.
        let limit = rate_limit();
        let now = chrono::Utc::now().timestamp_millis();
        let over = {
            let mut map = windows().lock().map_err(|_| ApiError::internal("rate limiter poisoned"))?;
            let w = map.entry(key_id.clone()).or_insert(Window { count: 0, reset_at: now + 60_000 });
            if w.reset_at <= now {
                w.count = 0;
                w.reset_at = now + 60_000;
            }
            w.count += 1;
            (w.count > limit).then(|| (w.reset_at - now).max(1000) / 1000)
        };
        if let Some(retry_in) = over {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                format!("Rate limit exceeded ({limit}/min). Retry in {retry_in}s."),
            ));
        }

        // Best-effort: never block the request on the bookkeeping write.
        let pool = state.pool.clone();
        tokio::spawn(async move {
            let _ = sqlx::query(r#"UPDATE "ApiKey" SET "lastUsedAt" = now() WHERE "id" = $1"#)
                .bind(key_id)
                .execute(&pool)
                .await;
        });

        Ok(ApiKeyUser { user_id, connection_ids })
    }
}

#[derive(Deserialize)]
struct SchemaQ {
    schema: Option<String>,
}

/// `GET /api/v1/connections` — the key's connections, scoped.
async fn list_connections(State(state): State<AppState>, key: ApiKeyUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT c."id", c."name", c."dialect"::text AS dialect, c."readOnly", c."viaAgent"
             FROM "Connection" c
             LEFT JOIN "ConnectionMember" m ON m."connectionId" = c."id" AND m."userId" = $1
            WHERE c."ownerId" = $1 OR m."userId" IS NOT NULL
            ORDER BY c."name""#,
    )
    .bind(&key.user_id)
    .fetch_all(&state.pool)
    .await?;

    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "dialect": r.try_get::<String, _>("dialect").unwrap_or_default(),
                "readOnly": r.try_get::<bool, _>("readOnly").unwrap_or(false),
                "viaAgent": r.try_get::<bool, _>("viaAgent").unwrap_or(false),
            })
        })
        .filter(|c| {
            key.connection_ids.is_empty()
                || key
                    .connection_ids
                    .iter()
                    .any(|id| Some(id.as_str()) == c["id"].as_str())
        })
        .collect();
    Ok(Json(Value::Array(out)))
}

/// `GET /api/v1/connections/:id/schemas`
async fn list_schemas(
    State(state): State<AppState>,
    key: ApiKeyUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    key.assert_allowed(&id)?;
    crate::audit_log::audit_require_role(&state, &id, &key.user_id, "VIEWER").await?;
    let mut c = crate::connect_target(&state, &id, &key.user_id).await?;
    let names = crate::core_schemas(&mut *c).await?;
    Ok(Json(json!(names)))
}

/// `GET /api/v1/connections/:id/tables?schema=public`
async fn list_tables(
    State(state): State<AppState>,
    key: ApiKeyUser,
    Path(id): Path<String>,
    Query(q): Query<SchemaQ>,
) -> ApiResult<Json<Value>> {
    key.assert_allowed(&id)?;
    crate::audit_log::audit_require_role(&state, &id, &key.user_id, "VIEWER").await?;
    let schema = q.schema.unwrap_or_else(|| "public".into());
    let mut c = crate::connect_target(&state, &id, &key.user_id).await?;
    let names = crate::core_tables(&mut *c, &schema).await?;
    Ok(Json(json!(names
        .into_iter()
        .map(|n| json!({ "name": n, "schema": schema }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct QueryBody {
    sql: String,
    #[serde(default)]
    params: Option<HashMap<String, Value>>,
    #[serde(rename = "maxRows", default)]
    max_rows: Option<i64>,
    #[serde(rename = "confirmDestructive", default)]
    confirm_destructive: bool,
}

/// `POST /api/v1/connections/:id/query`
///
/// Same guards as the UI: VIEWER may only SELECT, a destructive statement
/// needs `confirmDestructive`, and a read-only connection refuses writes.
async fn run_query(
    State(state): State<AppState>,
    key: ApiKeyUser,
    Path(id): Path<String>,
    Json(body): Json<QueryBody>,
) -> ApiResult<Json<Value>> {
    key.assert_allowed(&id)?;
    let role = crate::audit_log::audit_require_role(&state, &id, &key.user_id, "VIEWER").await?;

    let conn = sqlx::query(r#"SELECT "dialect"::text AS dialect, "readOnly" FROM "Connection" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let dialect: String = conn.try_get("dialect").unwrap_or_default();
    let read_only: bool = conn.try_get("readOnly").unwrap_or(false);

    let sql = body.sql.trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let cls = crate::queue::classify(&sql, &dialect);
    let is_select = cls.is_select();
    if !is_select && role == "VIEWER" {
        return Err(ApiError::bad("Viewer role may only run SELECT statements"));
    }
    if read_only && !is_select {
        return Err(ApiError::bad("Connection is read-only"));
    }
    if cls.needs_review() && !body.confirm_destructive {
        return Err(ApiError::bad(
            "Destructive statement requires confirmDestructive: true",
        ));
    }

    // Named parameters are bound, exactly as in the editor.
    let params = body.params.unwrap_or_default();
    let prepared = crate::sqlparams::prepare(&sql, &params)
        .map_err(|m| ApiError::bad(format!("Missing a value for parameter :{m}")))?;

    let mut c = crate::connect_target(&state, &id, &key.user_id).await?;
    let started = std::time::Instant::now();
    let cap = body.max_rows.unwrap_or(1000).clamp(0, 100_000);

    if is_select {
        let probe = if cap > 0 { cap.saturating_add(1) } else { 100_001 };
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({}) _q LIMIT {probe}) t",
            prepared.sql
        );
        let mut q = sqlx::query_scalar::<_, Value>(&wrapped);
        for b in &prepared.binds {
            q = q.bind(b.value.clone());
        }
        let mut rows: Value = q.fetch_one(&mut *c).await?;
        let fetched = rows.as_array().map(|a| a.len()).unwrap_or(0) as i64;
        let truncated = cap > 0 && fetched > cap;
        if truncated {
            if let Some(a) = rows.as_array_mut() {
                a.truncate(cap as usize);
            }
        }
        let count = rows.as_array().map(|a| a.len()).unwrap_or(0);
        let fields: Vec<Value> = crate::derive_columns(&rows)
            .into_iter()
            .map(|n| json!({ "name": n }))
            .collect();
        Ok(Json(json!({
            "rows": rows,
            "rowCount": count,
            "fields": fields,
            "truncated": truncated,
            "durationMs": started.elapsed().as_millis() as u64,
        })))
    } else {
        let mut q = sqlx::query(&prepared.sql);
        for b in &prepared.binds {
            q = q.bind(b.value.clone());
        }
        let affected = q.execute(&mut *c).await?.rows_affected();
        Ok(Json(json!({
            "rows": [],
            "rowCount": affected,
            "fields": [],
            "truncated": false,
            "durationMs": started.elapsed().as_millis() as u64,
        })))
    }
}
