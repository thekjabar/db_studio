//! Port of v1's **db-users**, **schema** (table DDL), **db-health** and
//! **sensitive-scan** endpoints to Rust.
//!
//! Sources of truth (v1, Nest):
//!   * `backend/src/db-users/db-users.{controller,service,dto}.ts`
//!   * `backend/src/schema/schema.controller.ts` + the DDL builders in
//!     `backend/src/drivers/postgres.driver.ts`
//!   * `backend/src/health-monitor/health-monitor.{controller,service}.ts`
//!   * `backend/src/connections/sensitive-scan.controller.ts`
//!   * `backend/src/drivers/quote.util.ts` (identifier / type / expression guards)
//!
//! Routes served here:
//!   GET    /api/connections/:id/db-users                       (OWNER)
//!   POST   /api/connections/:id/db-users                       (OWNER)
//!   GET    /api/connections/:id/db-users/:role/privileges       (OWNER)
//!   PATCH  /api/connections/:id/db-users/:role                  (OWNER)
//!   DELETE /api/connections/:id/db-users/:role                  (OWNER)
//!   POST   /api/connections/:id/db-users/grant                  (OWNER)
//!   POST   /api/connections/:id/db-users/revoke                 (OWNER)
//!   POST   /api/connections/:id/db-users/membership             (OWNER)
//!   POST   /api/connections/:id/db-users/membership/remove      (OWNER)
//!   POST   /api/connections/:id/schema/tables                   (EDITOR)
//!   PATCH  /api/connections/:id/schema/tables                   (EDITOR)
//!   DELETE /api/connections/:id/schema/tables                   (OWNER)
//!   GET    /api/connections/:id/db-health                       (VIEWER)
//!   POST   /api/connections/:id/sensitive-scan                  (OWNER)
//!
//! Safety model, carried over verbatim from v1:
//!   * Every identifier that is interpolated into SQL goes through
//!     [`quote_pg`] â†’ [`assert_ident_shape`] (v1's `IDENT_RE`), so a role,
//!     schema, table or column name can never break out of its quotes.
//!   * Privilege keywords are whitelisted per level; the set is **not** widened.
//!   * Passwords / VALID UNTIL are the only literals interpolated (the grammar
//!     rejects bind params there) and they are single-quote escaped, then
//!     redacted before the statement reaches the audit log.
//!   * The target session always gets the connection's `statementTimeoutMs`, and
//!     `SESSION CHARACTERISTICS AS TRANSACTION READ ONLY` whenever v1's driver
//!     for that role would be read-only (VIEWER-scoped probes always, and any
//!     role on a `readOnly` connection).
//!
//! Anything Rust cannot execute faithfully â€” a non-Postgres dialect, or no
//! `ENCRYPTION_KEY` to decrypt credentials with â€” is forwarded to the v1 Node
//! API instead of failing (agent-backed connections are already short-circuited
//! upstream by `agent_guard`).

use axum::body::to_bytes;
use axum::extract::{Path, Query, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sqlx::{PgConnection, Row};

use crate::{conn_role, connect_target, gen_id, req_meta, ApiError, ApiResult, AppState, AuthUser, ReqMeta};

/// v1's exact route paths, so this router can be `.merge()`d into the main one.
pub fn routes() -> Router<AppState> {
    Router::new()
        // --- db-users (all OWNER) ---
        .route("/api/connections/:id/db-users", get(list_users).post(create_user))
        .route("/api/connections/:id/db-users/grant", post(grant))
        .route("/api/connections/:id/db-users/revoke", post(revoke))
        .route("/api/connections/:id/db-users/membership", post(add_membership))
        .route("/api/connections/:id/db-users/membership/remove", post(remove_membership))
        .route("/api/connections/:id/db-users/:role", patch(alter_user).delete(drop_user))
        .route("/api/connections/:id/db-users/:role/privileges", get(privileges))
        // --- schema/tables ---
        .route(
            "/api/connections/:id/schema/tables",
            post(create_table).patch(alter_table).delete(drop_table),
        )
        // --- health + PII scan ---
        .route("/api/connections/:id/db-health", get(db_health))
        .route("/api/connections/:id/sensitive-scan", post(sensitive_scan))
}

// ---------------------------------------------------------------------------
// quote.util.ts â€” identifier / type / expression guards
// ---------------------------------------------------------------------------

/// v1: `const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/`
fn ident_shape_ok(s: &str) -> bool {
    let mut it = s.chars();
    let Some(first) = it.next() else { return false };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    if !it.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return false;
    }
    s.chars().count() <= 63
}

/// `JSON.stringify(value)` for a string â€” used verbatim in v1's error messages.
fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// v1 `assertIdentShape` â€” `Invalid identifier: "â€¦"` (400).
fn assert_ident_shape(s: &str) -> ApiResult<()> {
    if ident_shape_ok(s) {
        Ok(())
    } else {
        Err(ApiError::bad(format!("Invalid identifier: {}", js_string(s))))
    }
}

/// v1 `quotePg` â€” shape-check then double-quote.
fn quote_pg(ident: &str) -> ApiResult<String> {
    assert_ident_shape(ident)?;
    Ok(format!("\"{}\"", ident.replace('"', "\"\"")))
}

/// v1 `assertSqlType` â€” `/^[A-Za-z][A-Za-z0-9 _(),\[\]]{0,127}$/` on the trimmed
/// value; the error quotes the **untrimmed** input, as v1 does.
fn assert_sql_type(raw: &str) -> ApiResult<String> {
    let t = raw.trim();
    let ok = {
        let mut it = t.chars();
        match it.next() {
            Some(f) if f.is_ascii_alphabetic() => {
                it.all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')' | ',' | '[' | ']')
                }) && t.chars().count() <= 128
            }
            _ => false,
        }
    };
    if ok {
        Ok(t.to_string())
    } else {
        Err(ApiError::bad(format!("Invalid column type: {}", js_string(raw))))
    }
}

/// v1 `assertFkAction` â€” a closed set of ON DELETE / ON UPDATE keywords.
fn assert_fk_action(raw: Option<&String>) -> ApiResult<Option<String>> {
    let Some(raw) = raw else { return Ok(None) };
    let up = raw.to_uppercase();
    match up.as_str() {
        "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION" => Ok(Some(up)),
        _ => Err(ApiError::bad(format!("Invalid FK action: {}", js_string(raw)))),
    }
}

const EXPR_MAX_LEN: usize = 1024;

/// True if `s` contains a `;` outside a single-quoted literal (v1
/// `hasBareSemicolon`). Doubled quotes stay inside the string.
fn has_bare_semicolon(s: &str) -> bool {
    let b = s.as_bytes();
    let mut in_string = false;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' {
            if in_string && i + 1 < b.len() && b[i + 1] == b'\'' {
                i += 2;
                continue;
            }
            in_string = !in_string;
        } else if c == b';' && !in_string {
            return true;
        }
        i += 1;
    }
    false
}

/// v1 `assertFreeExpr` â€” length cap + "no second statement".
fn assert_free_expr(kind: &str, raw: &str) -> ApiResult<String> {
    if raw.chars().count() > EXPR_MAX_LEN {
        return Err(ApiError::bad(format!("{kind} too long (max {EXPR_MAX_LEN})")));
    }
    if has_bare_semicolon(raw) {
        return Err(ApiError::bad(format!("{kind} may not contain multiple statements")));
    }
    Ok(raw.to_string())
}

fn assert_default_expr(raw: &str) -> ApiResult<String> {
    assert_free_expr("DEFAULT expression", raw)
}
fn assert_check_expr(raw: &str) -> ApiResult<String> {
    assert_free_expr("CHECK expression", raw)
}

/// Single-quoted SQL literal (v1 `literal` / `quoteLiteral`).
fn quote_literal(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

// ---------------------------------------------------------------------------
// RBAC + connection plumbing
// ---------------------------------------------------------------------------

fn rank(role: &str) -> u8 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        _ => 1,
    }
}

/// v1 `RbacService.require` â€” 404 when the connection is gone, 403 with the
/// exact same wording when access is missing or the role is too low.
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    let role = conn_role(&state.pool, conn_id, user_id).await?;
    let Some(role) = role else {
        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT 1 FROM "Connection" WHERE "id" = $1"#)
            .bind(conn_id)
            .fetch_optional(&state.pool)
            .await?;
        return Err(if exists.is_none() {
            ApiError::new(StatusCode::NOT_FOUND, "Connection not found")
        } else {
            ApiError::new(StatusCode::FORBIDDEN, "No access to this connection")
        });
    };
    if rank(&role) < rank(min) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {min} role (have {role})"),
        ));
    }
    Ok(role)
}

struct ConnMeta {
    dialect: String,
    read_only: bool,
    timeout_ms: i32,
}

async fn conn_meta(state: &AppState, id: &str) -> ApiResult<ConnMeta> {
    let row = sqlx::query(
        r#"SELECT "dialect"::text AS dialect, "readOnly", "statementTimeoutMs"
             FROM "Connection" WHERE "id" = $1 LIMIT 1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    // `readOnly` decides whether the session refuses writes â€” never default it
    // silently to the permissive value.
    let read_only: bool = row
        .try_get("readOnly")
        .map_err(|e| ApiError::internal(format!("Connection.readOnly unreadable: {e}")))?;
    Ok(ConnMeta {
        dialect: row.try_get::<String, _>("dialect").unwrap_or_default(),
        read_only,
        timeout_ms: row.try_get::<i32, _>("statementTimeoutMs").unwrap_or(30_000),
    })
}

/// True when this connection is something v2 can drive natively.
fn servable(state: &AppState, meta: &ConnMeta) -> bool {
    meta.dialect.to_lowercase().contains("postgres") && state.crypto.is_some()
}

/// Open the target database and apply v1's per-checkout session settings.
async fn open_target(
    state: &AppState,
    id: &str,
    user_id: &str,
    read_only: bool,
    timeout_ms: i32,
) -> ApiResult<crate::TargetConn> {
    let mut c = connect_target(state, id, user_id).await?;
    sqlx::query(&format!("SET statement_timeout = {timeout_ms}"))
        .execute(&mut *c)
        .await?;
    if read_only {
        sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut *c)
            .await?;
    }
    Ok(c)
}

const MAX_BODY: usize = 2 * 1024 * 1024;

/// Read + parse a JSON body once we've decided not to forward the request.
async fn body_json<T: serde::de::DeserializeOwned>(req: Request) -> ApiResult<T> {
    let bytes = to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"))?;
    serde_json::from_slice(&bytes).map_err(|e| ApiError::bad(format!("Invalid request body: {e}")))
}

const MAX_SQL: usize = 10_000;

/// Best-effort audit row (v1 `AuditService.log` â€” never fails the request).
#[allow(clippy::too_many_arguments)]
async fn audit(
    state: &AppState,
    user_id: &str,
    connection_id: &str,
    action: &str,
    sql_text: Option<&str>,
    affected_rows: Option<i32>,
    meta: &ReqMeta,
    metadata: Option<Value>,
) {
    let sql = sql_text.map(|s| {
        if s.chars().count() > MAX_SQL {
            let head: String = s.chars().take(MAX_SQL).collect();
            format!("{head}... [truncated]")
        } else {
            s.to_string()
        }
    });
    let _ = sqlx::query(
        r#"INSERT INTO "AuditLog"
             ("id","userId","connectionId","action","sqlText","affectedRows","ip","userAgent","metadata","createdAt")
           VALUES ($1,$2,$3,$4::"AuditAction",$5,$6,$7,$8,$9,now())"#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(connection_id)
    .bind(action)
    .bind(sql.as_deref())
    .bind(affected_rows)
    .bind(meta.ip.as_deref())
    .bind(meta.user_agent.as_deref())
    .bind(metadata)
    .execute(&state.pool)
    .await;
}

// ---------------------------------------------------------------------------
// Row â†’ JSON helpers
//
// v1's node-postgres driver hands the controller plain JS objects; wrapping each
// statement in `jsonb_agg(to_jsonb(t))` reproduces that exactly (same column
// names, same JSON types) without needing a decoder per Postgres type â€” which
// matters because several of these probes return `numeric` (sum/lsn_diff), a
// type this build of sqlx cannot decode natively.
// ---------------------------------------------------------------------------

fn wrap_json(sql: &str, order_by: Option<&str>) -> String {
    let ord = order_by.map(|o| format!(" ORDER BY {o}")).unwrap_or_default();
    format!("SELECT COALESCE(jsonb_agg(to_jsonb(t){ord}), '[]'::jsonb) FROM ({sql}) t")
}

async fn query_json(c: &mut PgConnection, sql: &str, order_by: Option<&str>) -> Result<Vec<Value>, sqlx::Error> {
    let v: Value = sqlx::query_scalar(&wrap_json(sql, order_by)).fetch_one(&mut *c).await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

async fn query_json_1(
    c: &mut PgConnection,
    sql: &str,
    order_by: Option<&str>,
    p1: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let v: Value = sqlx::query_scalar(&wrap_json(sql, order_by))
        .bind(p1)
        .fetch_one(&mut *c)
        .await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}

/// `Number(row[key] ?? 0)` for a jsonb value.
fn jnum(row: &Value, key: &str) -> f64 {
    match row.get(key) {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse::<f64>().unwrap_or(f64::NAN),
        _ => 0.0,
    }
}

fn jstr(row: &Value, key: &str) -> Value {
    match row.get(key) {
        Some(Value::String(s)) => Value::String(s.clone()),
        _ => Value::Null,
    }
}

/// `Number(x.toFixed(2))`
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Emit a whole number as a JSON integer (JS `Number` has no int/float split, so
/// v1 writes `5`, not `5.0`).
fn jint(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

// ---------------------------------------------------------------------------
// db-users â€” role management on the target Postgres server (OWNER only).
// ---------------------------------------------------------------------------

const ROLES_SQL: &str = r#"
        SELECT
          r.rolname                                   AS name,
          r.rolsuper                                  AS superuser,
          r.rolcanlogin                               AS can_login,
          r.rolcreatedb                               AS create_db,
          r.rolcreaterole                             AS create_role,
          r.rolinherit                                AS inherit,
          r.rolreplication                            AS replication,
          r.rolbypassrls                              AS bypass_rls,
          r.rolconnlimit                              AS connection_limit,
          r.rolvaliduntil                             AS valid_until,
          COALESCE(
            (SELECT jsonb_agg(g.rolname ORDER BY g.rolname)
               FROM pg_auth_members m
               JOIN pg_roles g ON g.oid = m.roleid
              WHERE m.member = r.oid),
            '[]'::jsonb
          )                                           AS member_of
        FROM pg_roles r
        WHERE r.rolname NOT LIKE 'pg\_%'
      "#;

async fn list_users(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    let rows = query_json(&mut c, ROLES_SQL, Some("t.can_login DESC, t.name")).await?;
    Ok(Json(Value::Array(rows)).into_response())
}

async fn privileges(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, role_name)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    assert_ident_shape(&role_name)?;
    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;

    let db_priv = query_json_1(
        &mut c,
        r#"SELECT d.datname AS database, p.privilege_type
           FROM pg_database d
           CROSS JOIN LATERAL (
             SELECT unnest(ARRAY['CONNECT','CREATE','TEMPORARY']) AS privilege_type
           ) p
          WHERE d.datname = current_database()
            AND has_database_privilege($1, d.datname, p.privilege_type)"#,
        None,
        &role_name,
    )
    .await?;

    let schema_priv = query_json_1(
        &mut c,
        r#"SELECT n.nspname AS schema, p.privilege_type
           FROM pg_namespace n
           CROSS JOIN LATERAL (
             SELECT unnest(ARRAY['USAGE','CREATE']) AS privilege_type
           ) p
          WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
            AND has_schema_privilege($1, n.nspname, p.privilege_type)"#,
        Some("t.schema"),
        &role_name,
    )
    .await?;

    let table_priv = query_json_1(
        &mut c,
        r#"SELECT table_schema AS schema, table_name AS table, privilege_type, is_grantable
           FROM information_schema.role_table_grants
          WHERE grantee = $1
            AND table_schema NOT LIKE 'pg\_%' AND table_schema <> 'information_schema'"#,
        Some(r#"t.schema, t."table", t.privilege_type"#),
        &role_name,
    )
    .await?;

    Ok(Json(json!({
        "database": db_priv,
        "schema": schema_priv,
        "table": table_priv,
    }))
    .into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDbUserDto {
    name: String,
    password: Option<String>,
    login: Option<bool>,
    superuser: Option<bool>,
    create_db: Option<bool>,
    create_role: Option<bool>,
    inherit: Option<bool>,
    bypass_rls: Option<bool>,
    connection_limit: Option<i64>,
    valid_until: Option<String>,
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

fn check_range(field: &str, v: i64, min: i64, max: i64) -> ApiResult<()> {
    if v < min {
        return Err(ApiError::bad(format!("{field} must not be less than {min}")));
    }
    if v > max {
        return Err(ApiError::bad(format!("{field} must not be greater than {max}")));
    }
    Ok(())
}

async fn create_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: CreateDbUserDto = body_json(req).await?;

    check_len("name", &dto.name, 1, 63)?;
    if let Some(p) = &dto.password {
        check_len("password", p, 1, 256)?;
    }
    if let Some(v) = &dto.valid_until {
        check_len("validUntil", v, 1, 40)?;
    }
    if let Some(n) = dto.connection_limit {
        check_range("connectionLimit", n, 1, 100_000)?;
    }

    let name = quote_pg(&dto.name)?;
    let mut opts: Vec<String> = Vec::new();
    opts.push(if dto.login == Some(false) { "NOLOGIN".into() } else { "LOGIN".into() });
    if dto.superuser == Some(true) {
        opts.push("SUPERUSER".into());
    }
    if dto.create_db == Some(true) {
        opts.push("CREATEDB".into());
    }
    if dto.create_role == Some(true) {
        opts.push("CREATEROLE".into());
    }
    if dto.bypass_rls == Some(true) {
        opts.push("BYPASSRLS".into());
    }
    if dto.inherit == Some(false) {
        opts.push("NOINHERIT".into());
    }
    if let Some(n) = dto.connection_limit {
        opts.push(format!("CONNECTION LIMIT {n}"));
    }
    if let Some(p) = dto.password.as_deref().filter(|p| !p.is_empty()) {
        opts.push(format!("PASSWORD {}", quote_literal(p)));
    }
    if let Some(v) = dto.valid_until.as_deref().filter(|v| !v.is_empty()) {
        opts.push(format!("VALID UNTIL {}", quote_literal(v)));
    }
    let sql = format!("CREATE ROLE {name} {}", opts.join(" "));

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    sqlx::query(&sql).execute(&mut *c).await?;

    audit(
        &state,
        &user.id,
        &id,
        "SCHEMA_CHANGE",
        Some(&redact_password(&sql)),
        None,
        &rmeta,
        Some(json!({ "feature": "db-users", "op": "create", "role": dto.name })),
    )
    .await;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlterDbUserDto {
    password: Option<String>,
    login: Option<bool>,
    superuser: Option<bool>,
    create_db: Option<bool>,
    create_role: Option<bool>,
    bypass_rls: Option<bool>,
    connection_limit: Option<i64>,
    /// `''` clears the expiry (`VALID UNTIL 'infinity'`); absent leaves it alone.
    valid_until: Option<String>,
}

async fn alter_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, role_name)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: AlterDbUserDto = body_json(req).await?;

    if let Some(p) = &dto.password {
        check_len("password", p, 1, 256)?;
    }
    if let Some(v) = &dto.valid_until {
        check_len("validUntil", v, 0, 40)?;
    }
    if let Some(n) = dto.connection_limit {
        check_range("connectionLimit", n, -1, 100_000)?;
    }

    let name = quote_pg(&role_name)?;
    let mut opts: Vec<String> = Vec::new();
    match dto.login {
        Some(true) => opts.push("LOGIN".into()),
        Some(false) => opts.push("NOLOGIN".into()),
        None => {}
    }
    match dto.superuser {
        Some(true) => opts.push("SUPERUSER".into()),
        Some(false) => opts.push("NOSUPERUSER".into()),
        None => {}
    }
    match dto.create_db {
        Some(true) => opts.push("CREATEDB".into()),
        Some(false) => opts.push("NOCREATEDB".into()),
        None => {}
    }
    match dto.create_role {
        Some(true) => opts.push("CREATEROLE".into()),
        Some(false) => opts.push("NOCREATEROLE".into()),
        None => {}
    }
    match dto.bypass_rls {
        Some(true) => opts.push("BYPASSRLS".into()),
        Some(false) => opts.push("NOBYPASSRLS".into()),
        None => {}
    }
    if let Some(n) = dto.connection_limit {
        opts.push(format!("CONNECTION LIMIT {n}"));
    }
    if let Some(p) = dto.password.as_deref().filter(|p| !p.is_empty()) {
        opts.push(format!("PASSWORD {}", quote_literal(p)));
    }
    if let Some(v) = dto.valid_until.as_deref() {
        opts.push(if v.is_empty() {
            "VALID UNTIL 'infinity'".to_string()
        } else {
            format!("VALID UNTIL {}", quote_literal(v))
        });
    }
    if opts.is_empty() {
        return Err(ApiError::bad("No changes specified"));
    }
    let sql = format!("ALTER ROLE {name} {}", opts.join(" "));

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    sqlx::query(&sql).execute(&mut *c).await?;

    audit(
        &state,
        &user.id,
        &id,
        "SCHEMA_CHANGE",
        Some(&redact_password(&sql)),
        None,
        &rmeta,
        Some(json!({ "feature": "db-users", "op": "alter", "role": role_name })),
    )
    .await;
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn drop_user(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, role_name)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let name = quote_pg(&role_name)?;
    let sql = format!("DROP ROLE IF EXISTS {name}");

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    sqlx::query(&sql).execute(&mut *c).await?;

    audit(
        &state,
        &user.id,
        &id,
        "SCHEMA_CHANGE",
        Some(&sql),
        None,
        &rmeta,
        Some(json!({ "feature": "db-users", "op": "drop", "role": role_name })),
    )
    .await;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantDto {
    role: String,
    level: String,
    privileges: Vec<String>,
    schema: Option<String>,
    table: Option<String>,
    with_grant_option: Option<bool>,
}

/// v1 `PRIVS_BY_LEVEL` â€” the allowed privilege keywords per level. Do not widen.
fn privs_for_level(level: &str) -> Option<&'static [&'static str]> {
    match level {
        "database" => Some(&["ALL", "CONNECT", "CREATE", "TEMPORARY"]),
        "schema" => Some(&["ALL", "USAGE", "CREATE"]),
        "table" => Some(&[
            "ALL", "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER",
        ]),
        _ => None,
    }
}

/// v1 `normalizePrivileges` â€” validate + canonicalize; `ALL` subsumes the rest.
fn normalize_privileges(level: &str, requested: &[String]) -> ApiResult<Vec<String>> {
    let allowed = privs_for_level(level)
        .ok_or_else(|| ApiError::bad(format!("Invalid privilege level: {level}")))?;
    if requested.is_empty() {
        return Err(ApiError::bad("At least one privilege is required"));
    }
    let mut out: Vec<String> = Vec::new();
    for p in requested {
        let up = p.trim().to_uppercase();
        if !allowed.contains(&up.as_str()) {
            return Err(ApiError::bad(format!(
                "Privilege \"{p}\" is not valid at the {level} level"
            )));
        }
        let canon = if up == "ALL" { "ALL PRIVILEGES".to_string() } else { up };
        if !out.contains(&canon) {
            out.push(canon);
        }
    }
    if out.iter().any(|p| p == "ALL PRIVILEGES") {
        return Ok(vec!["ALL PRIVILEGES".to_string()]);
    }
    Ok(out)
}

async fn grant(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    grant_or_revoke("grant", state, user, id, req).await
}

async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    grant_or_revoke("revoke", state, user, id, req).await
}

async fn grant_or_revoke(
    kind: &str,
    state: AppState,
    user: AuthUser,
    id: String,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: GrantDto = body_json(req).await?;
    check_len("role", &dto.role, 1, 63)?;
    if let Some(s) = &dto.schema {
        check_len("schema", s, 1, 63)?;
    }
    if let Some(t) = &dto.table {
        check_len("table", t, 1, 63)?;
    }

    let role = quote_pg(&dto.role)?;
    let privs = normalize_privileges(&dto.level, &dto.privileges)?;

    // Resolve the target before dialling out, so a missing schema/table is
    // reported as v1's validation error rather than a connection failure.
    let partial_target = match dto.level.as_str() {
        "database" => None, // needs current_database() â€” filled in below
        "schema" => {
            let s = dto
                .schema
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ApiError::bad("schema is required for schema-level privileges"))?;
            Some(format!("SCHEMA {}", quote_pg(s)?))
        }
        _ => {
            let (s, t) = match (
                dto.schema.as_deref().filter(|s| !s.is_empty()),
                dto.table.as_deref().filter(|s| !s.is_empty()),
            ) {
                (Some(s), Some(t)) => (s, t),
                _ => {
                    return Err(ApiError::bad(
                        "schema and table are required for table-level privileges",
                    ))
                }
            };
            Some(format!("TABLE {}.{}", quote_pg(s)?, quote_pg(t)?))
        }
    };

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;

    let target = match partial_target {
        Some(t) => t,
        None => {
            // GRANT needs a literal database name; scope it to the connected DB.
            let db: Option<String> = sqlx::query_scalar("SELECT current_database() AS db")
                .fetch_optional(&mut *c)
                .await?;
            let db = db.ok_or_else(|| ApiError::bad("Could not resolve current database"))?;
            format!("DATABASE {}", quote_pg(&db)?)
        }
    };

    let sql = if kind == "grant" {
        let with_grant = if dto.with_grant_option == Some(true) { " WITH GRANT OPTION" } else { "" };
        format!("GRANT {} ON {target} TO {role}{with_grant}", privs.join(", "))
    } else {
        format!("REVOKE {} ON {target} FROM {role}", privs.join(", "))
    };

    sqlx::query(&sql).execute(&mut *c).await?;

    audit(
        &state,
        &user.id,
        &id,
        "SCHEMA_CHANGE",
        Some(&sql),
        None,
        &rmeta,
        Some(json!({ "feature": "db-users", "op": kind, "level": dto.level, "role": dto.role })),
    )
    .await;
    Ok(Json(json!({ "ok": true })).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembershipDto {
    parent_role: String,
    member_role: String,
}

async fn add_membership(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    membership("grant", state, user, id, req).await
}

async fn remove_membership(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    membership("revoke", state, user, id, req).await
}

async fn membership(
    kind: &str,
    state: AppState,
    user: AuthUser,
    id: String,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: MembershipDto = body_json(req).await?;
    check_len("parentRole", &dto.parent_role, 1, 63)?;
    check_len("memberRole", &dto.member_role, 1, 63)?;

    let parent = quote_pg(&dto.parent_role)?;
    let member = quote_pg(&dto.member_role)?;
    let sql = if kind == "grant" {
        format!("GRANT {parent} TO {member}")
    } else {
        format!("REVOKE {parent} FROM {member}")
    };

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    sqlx::query(&sql).execute(&mut *c).await?;

    audit(
        &state,
        &user.id,
        &id,
        "SCHEMA_CHANGE",
        Some(&sql),
        None,
        &rmeta,
        Some(json!({
            "feature": "db-users",
            "op": format!("membership-{kind}"),
            "parent": dto.parent_role,
            "member": dto.member_role,
        })),
    )
    .await;
    Ok(Json(json!({ "ok": true })).into_response())
}

/// v1 `redactPassword` â€” `/PASSWORD\s+'(?:[^']|'')*'/i` â†’ `PASSWORD '***'`
/// (first match only), so plaintext passwords never reach the audit log.
fn redact_password(sql: &str) -> String {
    let b = sql.as_bytes();
    let mut from = 0usize;
    while let Some(start) = find_ci(b, b"password", from) {
        let mut i = start + 8;
        let ws_start = i;
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i == ws_start || i >= b.len() || b[i] != b'\'' {
            from = start + 1;
            continue;
        }
        i += 1; // opening quote
        loop {
            if i >= b.len() {
                return sql.to_string(); // unterminated literal â€” no match
            }
            if b[i] == b'\'' {
                if i + 1 < b.len() && b[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            i += 1;
        }
        return format!("{}PASSWORD '***'{}", &sql[..start], &sql[i..]);
    }
    sql.to_string()
}

fn find_sub(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn find_ci(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

// ---------------------------------------------------------------------------
// schema/tables â€” CREATE / ALTER / DROP TABLE with a preview-then-confirm gate.
// ---------------------------------------------------------------------------

/// `Option<Option<T>>` that distinguishes an absent key from an explicit `null`
/// â€” v1 branches on `!== undefined` for `default` and `comment`.
fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ColumnSpecDto {
    name: String,
    #[serde(rename = "type")]
    type_: String,
    nullable: Option<bool>,
    default: Option<String>,
    default_is_expression: Option<bool>,
    primary_key: Option<bool>,
    unique: Option<bool>,
    check: Option<String>,
    comment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeignKeySpecDto {
    columns: Vec<String>,
    ref_schema: Option<String>,
    ref_table: String,
    ref_columns: Vec<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTableDto {
    schema: String,
    name: String,
    columns: Vec<ColumnSpecDto>,
    foreign_keys: Option<Vec<ForeignKeySpecDto>>,
    confirm: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameColumnDto {
    from: String,
    to: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlterColumnDto {
    name: String,
    #[serde(rename = "type")]
    type_: Option<String>,
    nullable: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    default: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    comment: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlterTableDto {
    schema: String,
    name: String,
    add_columns: Option<Vec<ColumnSpecDto>>,
    drop_columns: Option<Vec<String>>,
    drop_constraints: Option<Vec<String>>,
    rename_columns: Option<Vec<RenameColumnDto>>,
    alter_columns: Option<Vec<AlterColumnDto>>,
    add_foreign_keys: Option<Vec<ForeignKeySpecDto>>,
    rename_to: Option<String>,
    confirm: Option<bool>,
}

/// v1 `renderDefault` â€” `defaultIsExpression` wraps the (validated) expression.
fn render_default(c: &ColumnSpecDto) -> ApiResult<Option<String>> {
    let Some(d) = c.default.as_deref().filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    let safe = assert_default_expr(d)?;
    Ok(Some(if c.default_is_expression == Some(true) {
        format!("({safe})")
    } else {
        safe
    }))
}

/// v1 `colDefinition`.
fn col_definition(c: &ColumnSpecDto) -> ApiResult<String> {
    let mut parts = vec![quote_pg(&c.name)?, assert_sql_type(&c.type_)?];
    if c.primary_key == Some(true) {
        parts.push("PRIMARY KEY".into());
    }
    if c.unique == Some(true) {
        parts.push("UNIQUE".into());
    }
    if c.nullable == Some(false) {
        parts.push("NOT NULL".into());
    }
    if let Some(dv) = render_default(c)? {
        parts.push(format!("DEFAULT {dv}"));
    }
    if let Some(chk) = c.check.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("CHECK ({})", assert_check_expr(chk)?));
    }
    Ok(parts.join(" "))
}

/// v1 `fkClause` â€” `refSchema` defaults to the table's own schema.
fn fk_clause(spec_schema: &str, fk: &ForeignKeySpecDto) -> ApiResult<String> {
    let mut refs = Vec::with_capacity(fk.ref_columns.len());
    for c in &fk.ref_columns {
        refs.push(quote_pg(c)?);
    }
    let mut cols = Vec::with_capacity(fk.columns.len());
    for c in &fk.columns {
        cols.push(quote_pg(c)?);
    }
    let ref_schema = fk.ref_schema.as_deref().unwrap_or(spec_schema);
    let ref_tbl = format!("{}.{}", quote_pg(ref_schema)?, quote_pg(&fk.ref_table)?);
    let mut s = format!(
        "FOREIGN KEY ({}) REFERENCES {ref_tbl} ({})",
        cols.join(", "),
        refs.join(", ")
    );
    if let Some(a) = assert_fk_action(fk.on_delete.as_ref())? {
        s.push_str(&format!(" ON DELETE {a}"));
    }
    if let Some(a) = assert_fk_action(fk.on_update.as_ref())? {
        s.push_str(&format!(" ON UPDATE {a}"));
    }
    Ok(s)
}

/// v1 `validateSchemaTable` â€” refuse DDL against a table that isn't there.
async fn validate_schema_table(c: &mut PgConnection, schema: &str, table: &str) -> ApiResult<()> {
    let found: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(&mut *c)
    .await?;
    if found.is_none() {
        return Err(ApiError::bad(format!("Unknown table {schema}.{table}")));
    }
    Ok(())
}

async fn run_stmts(c: &mut PgConnection, stmts: &[String]) -> ApiResult<()> {
    for s in stmts {
        sqlx::query(s).execute(&mut *c).await?;
    }
    Ok(())
}

async fn create_table(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "EDITOR").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: CreateTableDto = body_json(req).await?;
    check_len("schema", &dto.schema, 1, 63)?;
    check_len("name", &dto.name, 1, 63)?;

    let mut col_defs = Vec::with_capacity(dto.columns.len());
    for c in &dto.columns {
        check_len("name", &c.name, 1, 63)?;
        check_len("type", &c.type_, 1, 128)?;
        col_defs.push(col_definition(c)?);
    }
    let mut fks = Vec::new();
    for fk in dto.foreign_keys.as_deref().unwrap_or(&[]) {
        fks.push(fk_clause(&dto.schema, fk)?);
    }
    let qualified = format!("{}.{}", quote_pg(&dto.schema)?, quote_pg(&dto.name)?);
    let mut all: Vec<String> = col_defs;
    all.extend(fks);
    let main = format!("CREATE TABLE {qualified} (\n  {}\n)", all.join(",\n  "));

    let mut stmts = vec![main];
    for c in &dto.columns {
        if let Some(cm) = c.comment.as_deref().filter(|s| !s.is_empty()) {
            stmts.push(format!(
                "COMMENT ON COLUMN {qualified}.{} IS {}",
                quote_pg(&c.name)?,
                quote_literal(cm)
            ));
        }
    }
    let sql = format!("{};", stmts.join(";\n"));

    if dto.confirm != Some(true) {
        return Ok(Json(json!({ "preview": sql, "executed": false })).into_response());
    }
    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    run_stmts(&mut c, &stmts).await?;
    audit(&state, &user.id, &id, "SCHEMA_CHANGE", Some(&sql), None, &rmeta, None).await;
    Ok(Json(json!({ "preview": sql, "executed": true })).into_response())
}

async fn alter_table(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "EDITOR").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let dto: AlterTableDto = body_json(req).await?;

    // v1 opens the driver (and validates the table) before building anything â€”
    // both the preview and the execute path go through validateSchemaTable.
    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    validate_schema_table(&mut c, &dto.schema, &dto.name).await?;

    let qualified = format!("{}.{}", quote_pg(&dto.schema)?, quote_pg(&dto.name)?);
    let base = format!("ALTER TABLE {qualified}");
    let mut parts: Vec<String> = Vec::new();

    for col in dto.add_columns.as_deref().unwrap_or(&[]) {
        parts.push(format!("ADD COLUMN {}", col_definition(col)?));
    }
    for name in dto.drop_columns.as_deref().unwrap_or(&[]) {
        parts.push(format!("DROP COLUMN {}", quote_pg(name)?));
    }
    for name in dto.drop_constraints.as_deref().unwrap_or(&[]) {
        parts.push(format!("DROP CONSTRAINT {}", quote_pg(name)?));
    }
    for r in dto.rename_columns.as_deref().unwrap_or(&[]) {
        parts.push(format!(
            "RENAME COLUMN {} TO {}",
            quote_pg(&r.from)?,
            quote_pg(&r.to)?
        ));
    }
    for a in dto.alter_columns.as_deref().unwrap_or(&[]) {
        if let Some(t) = a.type_.as_deref().filter(|t| !t.is_empty()) {
            parts.push(format!(
                "ALTER COLUMN {} TYPE {}",
                quote_pg(&a.name)?,
                assert_sql_type(t)?
            ));
        }
        match a.nullable {
            Some(true) => parts.push(format!("ALTER COLUMN {} DROP NOT NULL", quote_pg(&a.name)?)),
            Some(false) => parts.push(format!("ALTER COLUMN {} SET NOT NULL", quote_pg(&a.name)?)),
            None => {}
        }
        if let Some(d) = &a.default {
            parts.push(match d {
                None => format!("ALTER COLUMN {} DROP DEFAULT", quote_pg(&a.name)?),
                Some(v) => format!(
                    "ALTER COLUMN {} SET DEFAULT {}",
                    quote_pg(&a.name)?,
                    assert_default_expr(v)?
                ),
            });
        }
    }
    for fk in dto.add_foreign_keys.as_deref().unwrap_or(&[]) {
        parts.push(format!("ADD {}", fk_clause(&dto.schema, fk)?));
    }

    let mut stmts: Vec<String> = Vec::new();
    if !parts.is_empty() {
        stmts.push(format!("{base} {}", parts.join(", ")));
    }
    if let Some(rt) = dto.rename_to.as_deref().filter(|s| !s.is_empty()) {
        stmts.push(format!("{base} RENAME TO {}", quote_pg(rt)?));
    }
    for col in dto.add_columns.as_deref().unwrap_or(&[]) {
        if let Some(cm) = col.comment.as_deref().filter(|s| !s.is_empty()) {
            stmts.push(format!(
                "COMMENT ON COLUMN {qualified}.{} IS {}",
                quote_pg(&col.name)?,
                quote_literal(cm)
            ));
        }
    }
    for a in dto.alter_columns.as_deref().unwrap_or(&[]) {
        if let Some(cm) = &a.comment {
            let lit = match cm.as_deref() {
                None | Some("") => "NULL".to_string(),
                Some(v) => quote_literal(v),
            };
            stmts.push(format!(
                "COMMENT ON COLUMN {qualified}.{} IS {lit}",
                quote_pg(&a.name)?
            ));
        }
    }

    let sql = if stmts.is_empty() { String::new() } else { format!("{};", stmts.join(";\n")) };

    if dto.confirm != Some(true) {
        return Ok(Json(json!({ "preview": sql, "executed": false })).into_response());
    }
    run_stmts(&mut c, &stmts).await?;
    audit(&state, &user.id, &id, "SCHEMA_CHANGE", Some(&sql), None, &rmeta, None).await;
    // v1's controller returns `executed: true` unconditionally on the confirmed
    // path, even when the spec produced no statements.
    Ok(Json(json!({ "preview": sql, "executed": true })).into_response())
}

#[derive(Deserialize)]
struct DropTableQ {
    schema: Option<String>,
    name: Option<String>,
    confirm: Option<String>,
}

async fn drop_table(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<DropTableQ>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    let rmeta = req_meta(req.headers());
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    // Express hands `undefined` straight through to the driver, which reports it
    // as an unknown table â€” reproduce that rather than inventing a new error.
    let schema = q.schema.unwrap_or_else(|| "undefined".into());
    let name = q.name.unwrap_or_else(|| "undefined".into());

    let mut c = open_target(&state, &id, &user.id, meta.read_only, meta.timeout_ms).await?;
    validate_schema_table(&mut c, &schema, &name).await?;
    let sql = format!("DROP TABLE {}.{}", quote_pg(&schema)?, quote_pg(&name)?);

    if q.confirm.as_deref() != Some("true") {
        return Ok(Json(json!({ "preview": sql, "executed": false })).into_response());
    }
    sqlx::query(&sql).execute(&mut *c).await?;
    audit(&state, &user.id, &id, "SCHEMA_CHANGE", Some(&sql), None, &rmeta, None).await;
    Ok(Json(json!({ "preview": sql, "executed": true })).into_response())
}

// ---------------------------------------------------------------------------
// db-health â€” read-only operational probes against the target database.
// ---------------------------------------------------------------------------

/// The pg message only (node-pg's `err.message`), so the `errors[]` strings read
/// the same as v1's.
fn pg_message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_string(),
        other => other.to_string(),
    }
}

/// `sql.slice(0, 60).replace(/\s+/g, ' ')`
fn squash_head(sql: &str) -> String {
    let head: String = sql.chars().take(60).collect();
    let mut out = String::with_capacity(head.len());
    let mut in_ws = false;
    for ch in head.chars() {
        if ch.is_whitespace() {
            if !in_ws {
                out.push(' ');
                in_ws = true;
            }
        } else {
            out.push(ch);
            in_ws = false;
        }
    }
    out
}

/// v1 `runSafe` â€” a failing probe records an error string instead of aborting.
async fn run_safe(c: &mut PgConnection, sql: &str, errors: &mut Vec<String>) -> Vec<Value> {
    match query_json(&mut *c, sql, None).await {
        Ok(rows) => rows,
        Err(e) => {
            let msg: String = pg_message(&e).chars().take(200).collect();
            errors.push(format!("{}: {msg}", squash_head(sql)));
            Vec::new()
        }
    }
}

async fn run_safe_ordered(
    c: &mut PgConnection,
    sql: &str,
    order_by: &str,
    errors: &mut Vec<String>,
) -> Vec<Value> {
    match query_json(&mut *c, sql, Some(order_by)).await {
        Ok(rows) => rows,
        Err(e) => {
            let msg: String = pg_message(&e).chars().take(200).collect();
            errors.push(format!("{}: {msg}", squash_head(sql)));
            Vec::new()
        }
    }
}

fn severity(pct: f64) -> &'static str {
    if pct > 85.0 {
        "crit"
    } else if pct > 65.0 {
        "warn"
    } else {
        "ok"
    }
}

/// v1 `formatBytes`.
fn format_bytes(b: f64) -> String {
    const K: f64 = 1024.0;
    if b < K {
        // Integer byte counts render without a decimal point, as in JS.
        return format!("{} B", b as i64);
    }
    if b < K * K {
        return format!("{:.1} KB", b / K);
    }
    if b < K * K * K {
        return format!("{:.1} MB", b / (K * K));
    }
    if b < K * K * K * K {
        return format!("{:.2} GB", b / (K * K * K));
    }
    format!("{:.2} TB", b / (K * K * K * K))
}

fn truncate_query(v: &Value, max: usize) -> Value {
    match v {
        Value::String(s) if !s.is_empty() => {
            if s.chars().count() > max {
                let head: String = s.chars().take(max).collect();
                Value::String(format!("{head}â€¦"))
            } else {
                Value::String(s.clone())
            }
        }
        // v1's `truncate` returns null for null/empty.
        _ => Value::Null,
    }
}

async fn db_health(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "VIEWER").await?;
    let meta = conn_meta(&state, &id).await?;
    if !servable(&state, &meta) {
        // MySQL / SQLite / MSSQL probes live in the Node driver layer.
        return Ok(crate::proxy(State(state), req).await);
    }
    // v1 runs health as VIEWER â†’ always a read-only session.
    let mut c = open_target(&state, &id, &user.id, true, meta.timeout_ms).await?;

    let mut errors: Vec<String> = Vec::new();
    let mut metrics: Vec<Value> = Vec::new();

    // Active connections + max_connections.
    let conn = run_safe(
        &mut c,
        "SELECT\n       (SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle') AS active,\n       (SELECT count(*) FROM pg_stat_activity) AS total,\n       current_setting('max_connections')::int AS max_conn",
        &mut errors,
    )
    .await;
    if let Some(r) = conn.first() {
        let active = jnum(r, "active");
        let total = jnum(r, "total");
        let max = jnum(r, "max_conn");
        let pct = if max > 0.0 { (total / max) * 100.0 } else { 0.0 };
        metrics.push(json!({
            "key": "connections_active",
            "label": "Active connections",
            "value": jint(active),
            "hint": format!("{} total, {} max", fmt_num(total), fmt_num(max)),
            "severity": severity(pct),
        }));
        metrics.push(json!({
            "key": "connections_capacity",
            "label": "Connection capacity",
            "value": pct.round() as i64,
            "unit": "%",
            "severity": severity(pct),
        }));
    }

    // Cache hit ratio.
    let cache = run_safe(
        &mut c,
        "SELECT\n       sum(blks_hit) AS hit,\n       sum(blks_read) AS read\n     FROM pg_stat_database\n     WHERE datname = current_database()",
        &mut errors,
    )
    .await;
    if let Some(r) = cache.first() {
        let hit = jnum(r, "hit");
        let read = jnum(r, "read");
        let total = hit + read;
        if total > 0.0 {
            let ratio = (hit / total) * 100.0;
            metrics.push(json!({
                "key": "cache_hit",
                "label": "Cache hit ratio",
                "value": round2(ratio),
                "unit": "%",
                "severity": if ratio < 95.0 { "warn" } else { "ok" },
                "hint": "Above 99% is healthy for OLTP; OLAP workloads run lower.",
            }));
        }
    }

    // Replication lag.
    let rep = run_safe(
        &mut c,
        "SELECT\n       application_name,\n       COALESCE(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn), 0) AS bytes\n     FROM pg_stat_replication",
        &mut errors,
    )
    .await;
    if !rep.is_empty() {
        let max_bytes = rep.iter().map(|r| jnum(r, "bytes")).fold(f64::NEG_INFINITY, f64::max);
        metrics.push(json!({
            "key": "replication_lag",
            "label": "Replication lag (max)",
            "value": (max_bytes / 1024.0).round() as i64,
            "unit": "KB",
            "severity": if max_bytes > 64.0 * 1024.0 * 1024.0 { "warn" } else { "ok" },
            "hint": format!("{} replica(s) connected", rep.len()),
        }));
    }

    // Blocked sessions right now.
    let locks = run_safe(
        &mut c,
        "SELECT count(*)::int AS n FROM pg_locks WHERE granted = false",
        &mut errors,
    )
    .await;
    if let Some(r) = locks.first() {
        let n = jnum(r, "n");
        metrics.push(json!({
            "key": "locks_waiting",
            "label": "Waiting locks",
            "value": jint(n),
            "severity": if n > 10.0 { "crit" } else if n > 0.0 { "warn" } else { "ok" },
        }));
    }

    // Database size.
    let size = run_safe(
        &mut c,
        "SELECT pg_database_size(current_database()) AS bytes",
        &mut errors,
    )
    .await;
    if let Some(r) = size.first() {
        metrics.push(json!({
            "key": "database_size",
            "label": "Database size",
            "value": format_bytes(jnum(r, "bytes")),
        }));
    }

    // Lifetime rollback ratio.
    let tx = run_safe(
        &mut c,
        "SELECT xact_commit AS committed, xact_rollback AS rolled_back\n     FROM pg_stat_database\n     WHERE datname = current_database()",
        &mut errors,
    )
    .await;
    if let Some(r) = tx.first() {
        let committed = jnum(r, "committed");
        let rolled_back = jnum(r, "rolled_back");
        let total = committed + rolled_back;
        if total > 0.0 {
            let ratio = (rolled_back / total) * 100.0;
            metrics.push(json!({
                "key": "rollback_ratio",
                "label": "Rollback ratio (lifetime)",
                "value": round2(ratio),
                "unit": "%",
                "severity": if ratio > 5.0 { "warn" } else { "ok" },
            }));
        }
    }

    // Long-running statements. jsonb_agg needs an explicit ORDER BY to keep the
    // inner `ORDER BY query_start ASC` â€” longest-running first.
    let rows = run_safe_ordered(
        &mut c,
        "SELECT pid, usename, datname,\n            EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms,\n            state, query, wait_event\n     FROM pg_stat_activity\n     WHERE state <> 'idle'\n       AND query NOT ILIKE '%pg_stat_activity%'\n       AND query_start IS NOT NULL\n       AND now() - query_start > interval '10 seconds'\n     ORDER BY query_start ASC\n     LIMIT 20",
        "t.duration_ms DESC",
        &mut errors,
    )
    .await;
    let long_running: Vec<Value> = rows
        .iter()
        .map(|r| {
            let duration = r.get("duration_ms").and_then(|v| v.as_f64());
            json!({
                "pid": r.get("pid").cloned().unwrap_or(Value::Null),
                "user": jstr(r, "usename"),
                "database": jstr(r, "datname"),
                "durationMs": duration.map(|d| d.round() as i64),
                "state": jstr(r, "state"),
                "query": truncate_query(r.get("query").unwrap_or(&Value::Null), 2000),
                "waitEvent": jstr(r, "wait_event"),
            })
        })
        .collect();

    Ok(Json(json!({
        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "dialect": meta.dialect,
        "metrics": metrics,
        "errors": errors,
        "longRunning": long_running,
    }))
    .into_response())
}

/// Render a count the way `${n}` does in JS (no trailing `.0`).
fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

// ---------------------------------------------------------------------------
// sensitive-scan â€” name/type heuristics over the introspected schema (OWNER).
// ---------------------------------------------------------------------------

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `a.?b` â€” `b` immediately after `a`, or with exactly one character between.
fn dot_opt(h: &str, a: &str, b: &str) -> bool {
    let hb = h.as_bytes();
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let mut i = 0usize;
    while let Some(p) = find_sub(hb, ab, i) {
        let after = p + ab.len();
        if hb[after..].starts_with(bb) {
            return true;
        }
        if after < hb.len() && hb[after] != b'\n' && hb[after + 1..].starts_with(bb) {
            return true;
        }
        i = p + 1;
    }
    false
}

/// `w\b` â€” `w` followed by end-of-string or a non-word character.
fn word_end(h: &str, w: &str) -> bool {
    let hb = h.as_bytes();
    let wb = w.as_bytes();
    let mut i = 0usize;
    while let Some(p) = find_sub(hb, wb, i) {
        let e = p + wb.len();
        if e >= hb.len() || !is_word_byte(hb[e]) {
            return true;
        }
        i = p + 1;
    }
    false
}

/// `\bip(_|$)`
fn ip_word(h: &str) -> bool {
    let hb = h.as_bytes();
    let mut i = 0usize;
    while let Some(p) = find_sub(hb, b"ip", i) {
        let before_ok = p == 0 || !is_word_byte(hb[p - 1]);
        let e = p + 2;
        let after_ok = e >= hb.len() || hb[e] == b'_';
        if before_ok && after_ok {
            return true;
        }
        i = p + 1;
    }
    false
}

/// v1 `NAME_RULES`, in order â€” the first rule that matches wins.
fn sensitive_kind(column: &str) -> Option<&'static str> {
    let n = column.to_lowercase();
    if n.contains("passwd") || n.contains("password") || n.contains("passhash") || n.contains("pwd") {
        return Some("password");
    }
    if n.contains("secret")
        || n.contains("token")
        || dot_opt(&n, "api", "key")
        || dot_opt(&n, "private", "key")
        || n.contains("credential")
    {
        return Some("secret/token");
    }
    if n.contains("mail") {
        return Some("email");
    }
    if n.contains("phone") || n.contains("mobile") || n.contains("msisdn") || n.contains("tel") {
        return Some("phone");
    }
    if n.contains("ssn")
        || dot_opt(&n, "social", "sec")
        || dot_opt(&n, "national", "id")
        || n.contains("passport")
        || dot_opt(&n, "tax", "id")
        || n.contains("iban")
    {
        return Some("national id");
    }
    if dot_opt(&n, "card", "number")
        || dot_opt(&n, "card", "no")
        || dot_opt(&n, "card", "num")
        || dot_opt(&n, "cc", "num")
        || word_end(&n, "pan")
        || n.contains("cvv")
        || n.contains("cvc")
    {
        return Some("payment card");
    }
    if n.contains("address") || n.contains("street") || n.contains("postcode") || dot_opt(&n, "zip", "code") {
        return Some("address");
    }
    if n.contains("birth") || word_end(&n, "dob") {
        return Some("date of birth");
    }
    if ip_word(&n) || dot_opt(&n, "ip", "addr") {
        return Some("ip address");
    }
    if n.contains("salary")
        || n.contains("income")
        || n.contains("balance")
        || dot_opt(&n, "account", "no")
        || dot_opt(&n, "account", "number")
    {
        return Some("salary/financial");
    }
    None
}

async fn sensitive_scan(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let meta = conn_meta(&state, &id).await?;
    if !servable(&state, &meta) {
        return Ok(crate::proxy(State(state), req).await);
    }
    // v1 scans as VIEWER â€” introspection only, never row data.
    let mut c = open_target(&state, &id, &user.id, true, meta.timeout_ms).await?;

    // The column half of v1's introspectForER (the FK half is unused here).
    let rows = sqlx::query(
        "SELECT n.nspname::text AS schema, cls.relname::text AS tbl, a.attname::text AS name, \
                format_type(a.atttypid, a.atttypmod) AS data_type \
           FROM pg_class cls \
           JOIN pg_namespace n ON n.oid = cls.relnamespace \
           JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped \
          WHERE cls.relkind IN ('r','v','m','p') \
            AND n.nspname NOT IN ('pg_catalog','information_schema') \
          ORDER BY n.nspname, cls.relname, a.attnum",
    )
    .fetch_all(&mut *c)
    .await?;

    let mut findings: Vec<Value> = Vec::new();
    let mut seen_tables: Vec<String> = Vec::new();
    for r in &rows {
        let schema: String = r.try_get("schema").unwrap_or_default();
        let table: String = r.try_get("tbl").unwrap_or_default();
        let column: String = r.try_get("name").unwrap_or_default();
        let data_type: String = r.try_get("data_type").unwrap_or_default();

        let key = format!("{schema}.{table}");
        if seen_tables.last() != Some(&key) && !seen_tables.contains(&key) {
            seen_tables.push(key);
        }
        if let Some(kind) = sensitive_kind(&column) {
            let dt = data_type.to_lowercase();
            let texty = dt.contains("char") || dt.contains("text") || dt.contains("json");
            findings.push(json!({
                "schema": schema,
                "table": table,
                "column": column,
                "dataType": data_type,
                "kind": kind,
                "reason": format!("Column name matches \"{kind}\" pattern"),
                "confidence": if texty { "high" } else { "medium" },
            }));
        }
    }

    Ok(Json(json!({ "findings": findings, "tablesScanned": seen_tables.len() })).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_do_not_conflict() {
        // `Router::route` panics on an ambiguous path â€” assert the static
        // (`grant`, `membership`) vs dynamic (`:role`) siblings coexist.
        let _ = routes();
    }

    #[test]
    fn ident_shape_matches_v1_regex() {
        assert!(ident_shape_ok("_ok9"));
        assert!(!ident_shape_ok("9bad"));
        assert!(!ident_shape_ok("bad-name"));
        assert!(!ident_shape_ok("bad\"; DROP TABLE x --"));
        assert!(!ident_shape_ok(""));
        assert!(ident_shape_ok(&"a".repeat(63)));
        assert!(!ident_shape_ok(&"a".repeat(64)));
    }

    #[test]
    fn privileges_are_not_widened() {
        assert!(normalize_privileges("table", &["DROP".into()]).is_err());
        assert!(normalize_privileges("schema", &["SELECT".into()]).is_err());
        // `.unwrap()` needs Debug on the error type, which ApiError doesn't
        // implement â€” match instead so the crate's test target still builds.
        match normalize_privileges("table", &["select".into(), "ALL".into()]) {
            Ok(v) => assert_eq!(v, vec!["ALL PRIVILEGES".to_string()]),
            Err(_) => panic!("expected ALL to collapse to ALL PRIVILEGES"),
        }
    }

    #[test]
    fn password_is_redacted_for_audit() {
        assert_eq!(
            redact_password("CREATE ROLE \"x\" LOGIN PASSWORD 'p''w' VALID UNTIL '2030-01-01'"),
            "CREATE ROLE \"x\" LOGIN PASSWORD '***' VALID UNTIL '2030-01-01'"
        );
    }

    #[test]
    fn bare_semicolon_blocks_stacked_statements() {
        assert!(has_bare_semicolon("1; DROP TABLE users"));
        assert!(!has_bare_semicolon("'a;b'"));
    }
}
