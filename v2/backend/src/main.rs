//! Query Schema v2 — Rust/axum reimplementation of the v1 hot path.
//!
//! Shares the same Postgres as v1 (`DATABASE_URL`), verifies the same argon2id
//! password hashes, and returns a server-measured `tookMs` on the data endpoints
//! so the Rust stack can be benchmarked against the Node/Nest one.
//!
//! Everything uses the sqlx *runtime* query API (no `query!` macro), so the
//! binary compiles without a database connection at build time.

use std::time::Instant;

use axum::{
    extract::{Path, Query, State},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use axum::extract::FromRequestParts;
use axum::async_trait;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{PgPool, Row};
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

    let state = AppState { pool, jwt_secret, jwt_ttl, max_rows };

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true, "service": "queryschema-v2" })) }))
        .route("/api/health/db", get(health_db))
        .route("/api/auth/login", post(login))
        .route("/api/auth/me", get(me))
        .route("/api/connections", get(list_connections))
        .route("/api/introspect/schemas", get(list_schemas))
        .route("/api/introspect/:schema/tables", get(list_tables))
        .route("/api/introspect/:schema/:table/columns", get(list_columns))
        .route("/api/table/:schema/:table/rows", get(table_rows))
        .route("/api/query/run", post(run_query))
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
        let data = decode::<Claims>(
            token,
            &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
            &Validation::default(),
        )
        .map_err(|_| ApiError::unauthorized("Invalid or expired token"))?;
        Ok(AuthUser { id: data.claims.sub })
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
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
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
