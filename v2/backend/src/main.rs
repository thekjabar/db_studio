//! Query Schema v2 — Rust/axum reimplementation of the v1 hot path.
//!
//! Shares the same Postgres as v1 (`DATABASE_URL`), verifies the same argon2id
//! password hashes, and returns a server-measured `tookMs` on the data endpoints
//! so the Rust stack can be benchmarked against the Node/Nest one.
//!
//! Everything uses the sqlx *runtime* query API (no `query!` macro), so the
//! binary compiles without a database connection at build time.

mod crypto;

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum::body::{to_bytes, Body};
use axum::extract::{FromRequestParts, Request};
use axum::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use serde_json::{json, Value};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, Connection, Executor, PgConnection, PgPool, Row, TypeInfo};
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    jwt_secret: String,
    /// Access-token lifetime in seconds.
    jwt_ttl: i64,
    /// Hard cap on rows returned by row/query endpoints.
    max_rows: i64,
    /// Present when ENCRYPTION_KEY is set — enables decrypting v1 connection
    /// credentials to reach target databases. None = app-DB-only mode.
    crypto: Option<crypto::Crypto>,
    /// HTTP client + origin for the strangler proxy to the v1 Node API.
    http: reqwest::Client,
    v1_origin: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("queryschema_v2=info,tower_http=info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let jwt_secret = std::env::var("V2_JWT_SECRET")
        .or_else(|_| std::env::var("JWT_ACCESS_SECRET"))
        .expect("V2_JWT_SECRET (or JWT_ACCESS_SECRET) is required");
    let jwt_ttl = std::env::var("V2_JWT_TTL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);
    let max_rows = std::env::var("V2_MAX_ROWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3010);
    let max_conns = std::env::var("V2_DB_POOL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    let pool = PgPoolOptions::new()
        .max_connections(max_conns)
        .connect(&database_url)
        .await?;

    let crypto = crypto::Crypto::from_env().ok();
    if crypto.is_some() {
        tracing::info!("ENCRYPTION_KEY loaded — target-database connections enabled");
    }
    let v1_origin = std::env::var("V1_ORIGIN").unwrap_or_else(|_| "http://dbdash-api:3000".into());
    let http = reqwest::Client::builder()
        .build()
        .expect("reqwest client");
    let state = AppState { pool, jwt_secret, jwt_ttl, max_rows, crypto, http, v1_origin };

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "service": "queryschema-v2" })) }))
        .route("/api/health/db", get(health_db))
        // --- Rust hot path: v1's EXACT paths, so the perf-critical calls run
        //     in Rust. Everything else falls through to the v1 proxy below. ---
        .route("/api/connections/:id/schemas", get(v1_schemas))
        .route("/api/connections/:id/tables", get(v1_tables))
        .route("/api/connections/:id/query", post(v1_query))
        // --- Strangler proxy: every other endpoint → v1 Node API ---
        .fallback(proxy)
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{port}");
    tracing::info!("queryschema-v2 listening on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

struct ApiError {
    status: StatusCode,
    message: String,
}
impl ApiError {
    fn new(status: StatusCode, msg: impl Into<String>) -> Self {
        Self { status, message: msg.into() }
    }
    fn bad(msg: impl Into<String>) -> Self { Self::new(StatusCode::BAD_REQUEST, msg) }
    fn unauthorized(msg: impl Into<String>) -> Self { Self::new(StatusCode::UNAUTHORIZED, msg) }
    fn internal(msg: impl Into<String>) -> Self { Self::new(StatusCode::INTERNAL_SERVER_ERROR, msg) }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        // Surface the DB message — this is a query tool, the SQL error IS the useful output.
        ApiError::new(StatusCode::BAD_REQUEST, e.to_string())
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: i64,
}

type HmacSha256 = Hmac<Sha256>;

fn jwt_sign(input: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac accepts any key length");
    mac.update(input.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn jwt_encode(claims: &Claims, secret: &str) -> anyhow::Result<String> {
    let header = B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = B64.encode(serde_json::to_vec(claims)?);
    let signing_input = format!("{header}.{payload}");
    let sig = jwt_sign(&signing_input, secret);
    Ok(format!("{signing_input}.{sig}"))
}

fn jwt_decode(token: &str, secret: &str) -> anyhow::Result<Claims> {
    let mut parts = token.splitn(3, '.');
    let h = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let p = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let s = parts.next().ok_or_else(|| anyhow::anyhow!("bad token"))?;
    let expected = jwt_sign(&format!("{h}.{p}"), secret);
    if !ct_eq(expected.as_bytes(), s.as_bytes()) {
        anyhow::bail!("bad signature");
    }
    let claims: Claims = serde_json::from_slice(&B64.decode(p)?)?;
    if claims.exp < chrono::Utc::now().timestamp() {
        anyhow::bail!("token expired");
    }
    Ok(claims)
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

/// Authenticated-user extractor: pulls the Bearer token and verifies the JWT.
struct AuthUser {
    id: String,
}

#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::unauthorized("Missing Authorization header"))?;
        let token = header
            .strip_prefix("Bearer ")
            .ok_or_else(|| ApiError::unauthorized("Malformed Authorization header"))?;
        let claims = jwt_decode(token, &state.jwt_secret)
            .map_err(|_| ApiError::unauthorized("Invalid or expired token"))?;
        Ok(AuthUser { id: claims.sub })
    }
}

#[derive(Deserialize)]
struct LoginBody {
    email: String,
    password: String,
}

async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> ApiResult<Json<Value>> {
    let email = body.email.trim().to_lowercase();
    let row = sqlx::query(
        r#"SELECT "id", "email", "passwordHash", "displayName", "isAdmin"
           FROM "User" WHERE lower("email") = $1 LIMIT 1"#,
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or_else(|| ApiError::unauthorized("Invalid credentials"))?;
    let id: String = row.try_get("id").map_err(|e| ApiError::internal(e.to_string()))?;
    let hash: Option<String> = row.try_get("passwordHash").ok().flatten();
    let hash = hash.ok_or_else(|| ApiError::unauthorized("Account has no password set"))?;

    verify_argon2(&body.password, &hash)
        .map_err(|_| ApiError::unauthorized("Invalid credentials"))?;

    let now = chrono::Utc::now().timestamp();
    let claims = Claims { sub: id.clone(), exp: now + state.jwt_ttl };
    let token = jwt_encode(&claims, &state.jwt_secret)
        .map_err(|e| ApiError::internal(e.to_string()))?;

    let display: Option<String> = row.try_get("displayName").ok().flatten();
    let is_admin: bool = row.try_get("isAdmin").unwrap_or(false);
    Ok(Json(json!({
        "accessToken": token,
        "user": { "id": id, "email": email, "displayName": display, "isAdmin": is_admin }
    })))
}

fn verify_argon2(password: &str, hash: &str) -> Result<(), ()> {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;
    let parsed = PasswordHash::new(hash).map_err(|_| ())?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| ())
}

async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let row = sqlx::query(
        r#"SELECT "id", "email", "displayName", "isAdmin", "density", "theme"
           FROM "User" WHERE "id" = $1 LIMIT 1"#,
    )
    .bind(&user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::unauthorized("User not found"))?;

    Ok(Json(json!({
        "id": row.try_get::<String, _>("id").unwrap_or_default(),
        "email": row.try_get::<String, _>("email").unwrap_or_default(),
        "displayName": row.try_get::<Option<String>, _>("displayName").ok().flatten(),
        "isAdmin": row.try_get::<bool, _>("isAdmin").unwrap_or(false),
    })))
}

// ---------------------------------------------------------------------------
// Health / DB
// ---------------------------------------------------------------------------

async fn health_db(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let start = Instant::now();
    let one: i32 = sqlx::query_scalar("SELECT 1").fetch_one(&state.pool).await?;
    Ok(Json(json!({ "ok": one == 1, "tookMs": ms(start) })))
}

// ---------------------------------------------------------------------------
// Connections (owned by the user)
// ---------------------------------------------------------------------------

async fn list_connections(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT "id", "name", "dialect"::text AS dialect, "readOnly", "createdAt"
           FROM "Connection" WHERE "ownerId" = $1 ORDER BY "createdAt" DESC"#,
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;

    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<String, _>("id").unwrap_or_default(),
                "name": r.try_get::<String, _>("name").unwrap_or_default(),
                "dialect": r.try_get::<String, _>("dialect").unwrap_or_default(),
                "readOnly": r.try_get::<bool, _>("readOnly").unwrap_or(false),
            })
        })
        .collect();
    Ok(Json(json!({ "connections": list })))
}

// ---------------------------------------------------------------------------
// Introspection (the shared app Postgres — phase 1)
// ---------------------------------------------------------------------------

async fn list_schemas(State(state): State<AppState>, _user: AuthUser) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog','information_schema')
             AND schema_name NOT LIKE 'pg_%'
           ORDER BY schema_name"#,
    )
    .fetch_all(&state.pool)
    .await?;
    let schemas: Vec<String> = rows.iter().map(|r| r.get::<String, _>("schema_name")).collect();
    Ok(Json(json!({ "schemas": schemas })))
}

async fn list_tables(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(schema): Path<String>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 AND table_type = 'BASE TABLE'
           ORDER BY table_name"#,
    )
    .bind(&schema)
    .fetch_all(&state.pool)
    .await?;
    let tables: Vec<String> = rows.iter().map(|r| r.get::<String, _>("table_name")).collect();
    Ok(Json(json!({ "tables": tables })))
}

async fn list_columns(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((schema, table)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let rows = sqlx::query(
        r#"SELECT c.column_name, c.data_type, c.is_nullable,
                  COALESCE(pk.is_pk, false) AS is_pk
           FROM information_schema.columns c
           LEFT JOIN (
             SELECT kcu.column_name, true AS is_pk
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY'
               AND tc.table_schema = $1 AND tc.table_name = $2
           ) pk ON pk.column_name = c.column_name
           WHERE c.table_schema = $1 AND c.table_name = $2
           ORDER BY c.ordinal_position"#,
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(&state.pool)
    .await?;

    let columns: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "name": r.try_get::<String, _>("column_name").unwrap_or_default(),
                "type": r.try_get::<String, _>("data_type").unwrap_or_default(),
                "nullable": r.try_get::<String, _>("is_nullable").map(|s| s == "YES").unwrap_or(true),
                "isPrimaryKey": r.try_get::<bool, _>("is_pk").unwrap_or(false),
            })
        })
        .collect();
    Ok(Json(json!({ "columns": columns })))
}

// ---------------------------------------------------------------------------
// Table rows (paginated) — the browse hot path
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RowsParams {
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn table_rows(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((schema, table)): Path<(String, String)>,
    Query(params): Query<RowsParams>,
) -> ApiResult<Json<Value>> {
    // Validate the identifiers against the catalog so we can safely inline them
    // (parameters can't be used for identifiers). Rejects anything not a real table.
    ensure_table_exists(&state.pool, &schema, &table).await?;

    let limit = params.limit.unwrap_or(100).clamp(1, state.max_rows);
    let offset = params.offset.unwrap_or(0).max(0);
    let qschema = quote_ident(&schema);
    let qtable = quote_ident(&table);

    let start = Instant::now();
    let rows_json: Value = sqlx::query_scalar(&format!(
        r#"SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
           FROM (SELECT * FROM {qschema}.{qtable} LIMIT {limit} OFFSET {offset}) t"#,
    ))
    .fetch_one(&state.pool)
    .await?;
    let took = ms(start);

    let total: Option<i64> = sqlx::query_scalar(&format!(
        r#"SELECT count(*) FROM {qschema}.{qtable}"#,
    ))
    .fetch_one(&state.pool)
    .await
    .ok();

    let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
    Ok(Json(json!({
        "rows": rows_json,
        "rowCount": row_count,
        "total": total,
        "limit": limit,
        "offset": offset,
        "tookMs": took,
    })))
}

async fn ensure_table_exists(pool: &PgPool, schema: &str, table: &str) -> ApiResult<()> {
    let exists: Option<bool> = sqlx::query_scalar(
        r#"SELECT true FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2 LIMIT 1"#,
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(pool)
    .await?;
    if exists.unwrap_or(false) {
        Ok(())
    } else {
        Err(ApiError::bad(format!("Unknown table {schema}.{table}")))
    }
}

/// Safely double-quote a Postgres identifier (doubling embedded quotes).
fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

// ---------------------------------------------------------------------------
// SQL runner — the query hot path
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RunBody {
    sql: String,
}

async fn run_query(
    State(state): State<AppState>,
    _user: AuthUser,
    Json(body): Json<RunBody>,
) -> ApiResult<Json<Value>> {
    let sql = body.sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let lowered = sql.to_lowercase();
    let is_select = lowered.starts_with("select") || lowered.starts_with("with") || lowered.starts_with("table");

    let start = Instant::now();
    if is_select {
        // Wrap so any column type serializes to JSON, capped by an outer LIMIT.
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {}) t",
            state.max_rows
        );
        let rows_json: Value = sqlx::query_scalar(&wrapped).fetch_one(&state.pool).await?;
        let took = ms(start);
        let columns = derive_columns(&rows_json);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        Ok(Json(json!({
            "columns": columns,
            "rows": rows_json,
            "rowCount": row_count,
            "tookMs": took,
        })))
    } else {
        // DML/DDL — execute and report affected rows.
        let res = sqlx::query(sql).execute(&state.pool).await?;
        Ok(Json(json!({
            "columns": [],
            "rows": [],
            "rowsAffected": res.rows_affected(),
            "tookMs": ms(start),
        })))
    }
}

// ---------------------------------------------------------------------------
// Executor-generic core queries — run against the app pool OR a live target
// connection, so introspection/rows/SQL is written once and reused for both.
// ---------------------------------------------------------------------------

type Pg = sqlx::Postgres;

const COLUMNS_SQL: &str = r#"SELECT c.column_name, c.data_type, c.is_nullable,
        COALESCE(pk.is_pk, false) AS is_pk
   FROM information_schema.columns c
   LEFT JOIN (
     SELECT kcu.column_name, true AS is_pk
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2
   ) pk ON pk.column_name = c.column_name
   WHERE c.table_schema = $1 AND c.table_name = $2
   ORDER BY c.ordinal_position"#;

async fn core_schemas<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT schema_name FROM information_schema.schemata \
         WHERE schema_name NOT IN ('pg_catalog','information_schema') \
           AND schema_name NOT LIKE 'pg_%' ORDER BY schema_name",
    )
    .fetch_all(exec)
    .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("schema_name")).collect())
}

async fn core_tables<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
    .bind(schema)
    .fetch_all(exec)
    .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("table_name")).collect())
}

async fn core_columns<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str, table: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(COLUMNS_SQL).bind(schema).bind(table).fetch_all(exec).await?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "name": r.try_get::<String, _>("column_name").unwrap_or_default(),
                "type": r.try_get::<String, _>("data_type").unwrap_or_default(),
                "nullable": r.try_get::<String, _>("is_nullable").map(|s| s == "YES").unwrap_or(true),
                "isPrimaryKey": r.try_get::<bool, _>("is_pk").unwrap_or(false),
            })
        })
        .collect())
}

async fn core_table_exists<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, schema: &str, table: &str) -> Result<bool, sqlx::Error> {
    let exists: Option<bool> = sqlx::query_scalar(
        "SELECT true FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(exec)
    .await?;
    Ok(exists.unwrap_or(false))
}

async fn core_rows_json<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, qschema: &str, qtable: &str, limit: i64, offset: i64) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) \
         FROM (SELECT * FROM {qschema}.{qtable} LIMIT {limit} OFFSET {offset}) t",
    ))
    .fetch_one(exec)
    .await
}

async fn core_count<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, qschema: &str, qtable: &str) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {qschema}.{qtable}")).fetch_one(exec).await
}

async fn core_select_json<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str, max: i64) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar(&format!(
        "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {max}) t",
    ))
    .fetch_one(exec)
    .await
}

async fn core_exec<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(sql).execute(exec).await?.rows_affected())
}

fn is_select(sql: &str) -> bool {
    let l = sql.to_lowercase();
    l.starts_with("select") || l.starts_with("with") || l.starts_with("table")
}

fn rows_response(rows_json: Value, total: Option<i64>, limit: i64, offset: i64, took: f64) -> Value {
    let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
    json!({ "rows": rows_json, "rowCount": row_count, "total": total, "limit": limit, "offset": offset, "tookMs": took })
}

/// Run arbitrary SQL over any executor (app pool or target connection), timed.
async fn run_on<'e, E: sqlx::Executor<'e, Database = Pg>>(exec: E, sql: &str, max: i64) -> ApiResult<Value> {
    let sql = sql.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let start = Instant::now();
    if is_select(sql) {
        let rows_json = core_select_json(exec, sql, max).await?;
        let took = ms(start);
        let columns = derive_columns(&rows_json);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        Ok(json!({ "columns": columns, "rows": rows_json, "rowCount": row_count, "tookMs": took }))
    } else {
        let affected = core_exec(exec, sql).await?;
        Ok(json!({ "columns": [], "rows": [], "rowsAffected": affected, "tookMs": ms(start) }))
    }
}

// ---------------------------------------------------------------------------
// Target-database handlers — decrypt v1 credentials, connect, run against it.
// ---------------------------------------------------------------------------

async fn connect_target(state: &AppState, id: &str, user_id: &str) -> ApiResult<PgConnection> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured — target connections disabled"))?;
    let row = sqlx::query(
        r#"SELECT c."credentialsCt", c."dialect"::text AS dialect
           FROM "Connection" c
           WHERE c."id" = $1 AND (
             c."ownerId" = $2
             OR EXISTS (SELECT 1 FROM "ConnectionMember" m
                        WHERE m."connectionId" = c."id" AND m."userId" = $2)
           ) LIMIT 1"#,
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::bad("Connection not found"))?;

    let dialect: String = row.try_get("dialect").unwrap_or_default();
    if !dialect.to_lowercase().contains("postgres") {
        return Err(ApiError::bad(format!("v2 supports Postgres targets only so far (got {dialect})")));
    }
    let ct: String = row.try_get("credentialsCt").map_err(|e| ApiError::internal(e.to_string()))?;
    let json = crypto
        .decrypt(&ct, &crypto::Crypto::conn_purpose(id))
        .map_err(|e| ApiError::bad(format!("credential decrypt failed: {e}")))?;
    let creds: crypto::ConnectionCredentials =
        serde_json::from_str(&json).map_err(|e| ApiError::internal(format!("bad credentials json: {e}")))?;

    // No TLS backend compiled yet → Disable only. TLS target support is a
    // planned follow-up (adds sqlx `tls-rustls`).
    let opts = PgConnectOptions::new()
        .host(&creds.host)
        .port(creds.port)
        .username(&creds.user)
        .password(&creds.password)
        .database(&creds.database)
        .ssl_mode(PgSslMode::Disable);
    PgConnection::connect_with(&opts)
        .await
        .map_err(|e| ApiError::bad(format!("connect to target failed: {e}")))
}

async fn conn_schemas(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "schemas": core_schemas(&mut c).await? })))
}

async fn conn_tables(State(state): State<AppState>, user: AuthUser, Path((id, schema)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "tables": core_tables(&mut c, &schema).await? })))
}

async fn conn_columns(State(state): State<AppState>, user: AuthUser, Path((id, schema, table)): Path<(String, String, String)>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!({ "columns": core_columns(&mut c, &schema, &table).await? })))
}

async fn conn_table_rows(State(state): State<AppState>, user: AuthUser, Path((id, schema, table)): Path<(String, String, String)>, Query(params): Query<RowsParams>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    if !core_table_exists(&mut c, &schema, &table).await? {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    let limit = params.limit.unwrap_or(100).clamp(1, state.max_rows);
    let offset = params.offset.unwrap_or(0).max(0);
    let (qs, qt) = (quote_ident(&schema), quote_ident(&table));
    let start = Instant::now();
    let rows_json = core_rows_json(&mut c, &qs, &qt, limit, offset).await?;
    let took = ms(start);
    let total = core_count(&mut c, &qs, &qt).await.ok();
    Ok(Json(rows_response(rows_json, total, limit, offset, took)))
}

async fn conn_query(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<RunBody>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    run_on(&mut c, &body.sql, state.max_rows).await.map(Json)
}

// ---------------------------------------------------------------------------
// v1-shaped hot path — these match the frontend's exact endpoints/shapes, so
// the perf-critical calls run in Rust instead of proxying to Node.
// ---------------------------------------------------------------------------

async fn v1_schemas(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    Ok(Json(json!(core_schemas(&mut c).await?)))
}

async fn v1_tables(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        "SELECT table_schema, table_name, table_type FROM information_schema.tables \
         WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%' \
         ORDER BY table_schema, table_name",
    )
    .fetch_all(&mut c)
    .await?;
    let tables: Vec<Value> = rows
        .iter()
        .map(|r| {
            let tt: String = r.get("table_type");
            json!({
                "name": r.get::<String, _>("table_name"),
                "schema": r.get::<String, _>("table_schema"),
                "type": if tt == "VIEW" { "view" } else { "table" },
            })
        })
        .collect();
    Ok(Json(json!(tables)))
}

#[derive(Deserialize)]
struct V1QueryBody {
    sql: String,
    #[serde(rename = "maxRows")]
    max_rows: Option<i64>,
}

async fn v1_query(State(state): State<AppState>, user: AuthUser, Path(id): Path<String>, Json(body): Json<V1QueryBody>) -> ApiResult<Json<Value>> {
    let mut c = connect_target(&state, &id, &user.id).await?;
    let sql = body.sql.trim().trim_end_matches(';').trim().to_string();
    if sql.is_empty() {
        return Err(ApiError::bad("Empty SQL"));
    }
    let max = body.max_rows.unwrap_or(state.max_rows).clamp(1, 100_000);
    let command = sql.split_whitespace().next().unwrap_or("").to_uppercase();
    let start = Instant::now();

    if is_select(&sql) {
        // Column names + types via describe (works even for zero-row results).
        let fields: Vec<Value> = match (&mut c).describe(sql.as_str()).await {
            Ok(d) => d
                .columns()
                .iter()
                .map(|col| json!({ "name": col.name(), "dataType": col.type_info().name() }))
                .collect(),
            Err(_) => vec![],
        };
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {max}) t",
        );
        let rows_json: Value = sqlx::query_scalar(&wrapped).fetch_one(&mut c).await?;
        let dur = ms(start);
        let row_count = rows_json.as_array().map(|a| a.len()).unwrap_or(0);
        let fields = if fields.is_empty() {
            derive_columns(&rows_json).into_iter().map(|n| json!({ "name": n })).collect()
        } else {
            fields
        };
        Ok(Json(json!({
            "rows": rows_json,
            "rowCount": row_count,
            "fields": fields,
            "command": command,
            "durationMs": dur,
            "truncated": row_count as i64 >= max,
            "appliedLimit": max,
        })))
    } else {
        let affected = sqlx::query(&sql).execute(&mut c).await?.rows_affected();
        Ok(Json(json!({
            "rows": [],
            "rowCount": affected,
            "fields": [],
            "command": command,
            "durationMs": ms(start),
        })))
    }
}

// ---------------------------------------------------------------------------
// Strangler proxy — forward any unported endpoint to the v1 Node API.
// ---------------------------------------------------------------------------

async fn proxy(State(state): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, 26_214_400).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::PAYLOAD_TOO_LARGE, "body too large").into_response(),
    };
    let path = parts.uri.path();
    let query = parts.uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let url = format!("{}{}{}", state.v1_origin, path, query);
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    let mut rb = state.http.request(method, &url).body(bytes.to_vec());
    for (k, v) in parts.headers.iter() {
        if k == axum::http::header::HOST {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_bytes());
    }
    let resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("v1 proxy error: {e}")).into_response(),
    };

    let status = resp.status();
    let headers = resp.headers().clone();
    let body_bytes = resp.bytes().await.unwrap_or_default();
    let mut builder = Response::builder().status(status.as_u16());
    for (k, v) in headers.iter() {
        let name = k.as_str();
        if name.eq_ignore_ascii_case("set-cookie") {
            // v1 scopes the refresh cookie to /api; the browser is at /v2/api.
            let cookie = String::from_utf8_lossy(v.as_bytes()).replace("Path=/api", "Path=/v2/api");
            builder = builder.header("set-cookie", cookie);
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-length")
            || name.eq_ignore_ascii_case("connection")
        {
            // hop-by-hop / recomputed by axum
        } else {
            builder = builder.header(name, v.as_bytes());
        }
    }
    builder
        .body(Body::from(body_bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Column names from the first row's keys (order preserved by serde_json's
/// preserve-order isn't enabled, so we read from the JSON object as-is).
fn derive_columns(rows_json: &Value) -> Vec<String> {
    rows_json
        .as_array()
        .and_then(|a| a.first())
        .and_then(|r| r.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn ms(start: Instant) -> f64 {
    (start.elapsed().as_micros() as f64) / 1000.0
}

// Silence unused-import warning for PgRow (kept for readability of row handlers).
#[allow(dead_code)]
fn _type_anchor(_r: &PgRow) {}
