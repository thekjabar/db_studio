//! Port of v1's backup endpoints (`backend/src/backup/backup.controller.ts` +
//! `backup.service.ts`) to Rust.
//!
//!   GET /api/connections/:id/backup/estimate?schema=      (VIEWER)
//!   GET /api/connections/:id/backup?format=&schemaOnly=&schema=   (OWNER)
//!
//! The dump is **streamed**: `pg_dump`'s stdout is wrapped in a `ReaderStream`
//! and handed to axum as the response body, so a multi-GB dump never lands in
//! the 384 MB container. The `Child` handle rides along inside the reader with
//! `kill_on_drop(true)`, so a cancelled download kills `pg_dump` (v1 does the
//! same via `res.on('close')` â†’ SIGTERM; tokio's kill_on_drop is SIGKILL).
//!
//! Wire-compatibility with v1 is deliberate â€” same query params, same headers,
//! same filename, same error strings â€” so the existing frontend download +
//! progress-bar code works against either backend.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sqlx::{Connection, Row};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio_util::io::ReaderStream;

use crate::{connect_target, crypto, require_conn_owner, ApiError, ApiResult, AppState, AuthUser};

/// v1's exact route paths, so this router can be `.merge()`d into the main one.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connections/:id/backup/estimate", get(estimate))
        .route("/api/connections/:id/backup", get(download))
        .route(
            "/api/connections/:id/restore",
            post(restore).layer(axum::extract::DefaultBodyLimit::disable()),
        )
}

// ---------------------------------------------------------------------------
// pg_dump binary selection (mirrors installedPgDumpMajors + pickPgDumpBinary)
// ---------------------------------------------------------------------------

/// Installed pg_dump majors, read from the env var set by the Dockerfile.
/// Unset (e.g. an image with a single `postgresql-client`) â†’ empty, and we fall
/// back to whatever `pg_dump` is on PATH.
fn installed_pg_dump_majors() -> Vec<u32> {
    let raw = std::env::var("DBSTUDIO_PG_DUMP_MAJORS").unwrap_or_default();
    let mut majors: Vec<u32> = raw
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter_map(js_parse_int)
        .filter(|n| *n >= 10)
        .collect();
    majors.sort_unstable_by(|a, b| b.cmp(a)); // descending â€” "latest" is index 0
    majors
}

/// `parseInt(s, 10)` semantics: leading digits win, trailing junk ignored.
fn js_parse_int(s: &str) -> Option<u32> {
    let s = s.trim_start();
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

struct PgDumpBinary {
    cmd: String,
    note: Option<String>,
}

/// Pick the pg_dump binary whose major matches the remote server; otherwise the
/// lowest installed major that is still >= the server. Older-than-server is
/// refused (pg_dump hard-errors on that).
fn pick_pg_dump_binary(server_major: Option<u32>) -> ApiResult<PgDumpBinary> {
    let majors = installed_pg_dump_majors();
    let server_major = match (majors.first(), server_major) {
        (Some(_), Some(m)) => m,
        _ => return Ok(PgDumpBinary { cmd: "pg_dump".into(), note: None }), // system default
    };
    if majors.contains(&server_major) {
        return Ok(PgDumpBinary {
            cmd: format!("/usr/lib/postgresql/{server_major}/bin/pg_dump"),
            note: None,
        });
    }
    let mut higher: Vec<u32> = majors.iter().copied().filter(|m| *m >= server_major).collect();
    higher.sort_unstable();
    if let Some(h) = higher.first() {
        return Ok(PgDumpBinary {
            cmd: format!("/usr/lib/postgresql/{h}/bin/pg_dump"),
            note: Some(format!(
                "Using pg_dump {h} against server {server_major} (exact match not installed)."
            )),
        });
    }
    Err(ApiError::bad(format!(
        "Remote PostgreSQL is major version {server_major}; installed pg_dump clients only go up to {}. Upgrade the API image.",
        majors[0]
    )))
}

// ---------------------------------------------------------------------------
// Connection lookup + credentials
// ---------------------------------------------------------------------------

/// v1's `ConnectionCredentials` shape, lenient like the TS interface: every
/// field is optional so the v1 fallbacks (`user ?? 'postgres'`, `password ?? ''`)
/// can be reproduced instead of failing to deserialize.
#[derive(serde::Deserialize, Default)]
struct RawCreds {
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    port: Option<Value>,
    #[serde(default, alias = "username")]
    user: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    database: Option<String>,
    /// SSH tunnel config â€” v1 opens a local forward and points pg_dump at it.
    /// v2 has no tunnel service, so its presence is a hard error (see below).
    #[serde(default)]
    ssh: Option<Value>,
}

struct ConnRow {
    name: String,
    dialect: String,
    credentials_ct: String,
    /// A read-only connection may be dumped, but never restored into.
    read_only: bool,
}

/// Load name/dialect/ciphertext with the same owner-or-member visibility rule
/// `connect_target` uses, so both agree on who can see a connection.
async fn load_conn(state: &AppState, id: &str, user_id: &str) -> ApiResult<ConnRow> {
    let row = sqlx::query(
        r#"SELECT c."name", c."dialect"::text AS dialect, c."credentialsCt", c."readOnly"
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

    Ok(ConnRow {
        name: row.try_get("name").unwrap_or_default(),
        dialect: row.try_get("dialect").unwrap_or_default(),
        credentials_ct: row
            .try_get("credentialsCt")
            .map_err(|e| ApiError::internal(e.to_string()))?,
        read_only: row.try_get("readOnly").unwrap_or(false),
    })
}

/// Decrypt with the same envelope reader `connect_target` uses (`state.crypto`
/// + purpose `conn:{id}`), then parse into the lenient shape above.
fn decrypt_creds(state: &AppState, id: &str, ct: &str) -> ApiResult<RawCreds> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured â€” target connections disabled"))?;
    let json = crypto
        .decrypt(ct, &crypto::Crypto::conn_purpose(id))
        .map_err(|e| ApiError::bad(format!("credential decrypt failed: {e}")))?;
    serde_json::from_str(&json).map_err(|e| ApiError::internal(format!("bad credentials json: {e}")))
}

fn is_postgres(dialect: &str) -> bool {
    dialect.eq_ignore_ascii_case("POSTGRES")
}

/// What a dump tool needs on its command line, pulled out of the stored
/// credentials. Shared with `autobackup`, which runs the same tools on a
/// schedule and must not reimplement the decrypt-and-validate step.
pub(crate) struct DumpCreds {
    pub host: String,
    pub port: String,
    pub user: String,
    pub password: String,
    pub database: String,
}

pub(crate) fn creds_for_dump(
    state: &AppState,
    id: &str,
    ct: &str,
) -> Result<DumpCreds, String> {
    let c = decrypt_creds(state, id, ct).map_err(|e| e.message)?;
    if c.ssh.as_ref().map(|v| !v.is_null()).unwrap_or(false) {
        return Err("Backup over an SSH tunnel is not supported".into());
    }
    Ok(DumpCreds {
        host: c
            .host
            .clone()
            .filter(|h| !h.is_empty())
            .ok_or("Connection is missing a host")?,
        port: c
            .port
            .as_ref()
            .and_then(port_str)
            .ok_or("Connection is missing a port")?,
        user: c.user.clone().unwrap_or_else(|| "postgres".into()),
        password: c.password.clone().unwrap_or_default(),
        database: c
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .ok_or("Connection is missing a database name")?,
    })
}

// ---------------------------------------------------------------------------
// GET /backup/estimate  (VIEWER)
// ---------------------------------------------------------------------------

struct Estimate {
    bytes: Option<i64>,
    tables: i64,
    note: &'static str,
}

async fn estimate(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let schema = q.get("schema").filter(|s| !s.is_empty()).cloned();
    let e = estimate_size(&state, &id, &user.id, schema.as_deref()).await?;
    Ok(Json(json!({ "bytes": e.bytes, "tables": e.tables, "note": e.note })))
}

/// On-disk bytes per `pg_total_relation_size` summed over base tables â€” the
/// same query, escaping and note strings as v1's `estimateSize`.
async fn estimate_size(
    state: &AppState,
    id: &str,
    user_id: &str,
    schema: Option<&str>,
) -> ApiResult<Estimate> {
    let conn = load_conn(state, id, user_id).await?;
    if !is_postgres(&conn.dialect) {
        return Ok(Estimate { bytes: None, tables: 0, note: "Estimate only available for PostgreSQL" });
    }

    let where_clause = match schema {
        Some(s) => format!("AND n.nspname = '{}'", s.replace('\'', "''")),
        None => "AND n.nspname NOT IN ('pg_catalog','information_schema')".to_string(),
    };
    let sql = format!(
        r#"
        SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::text AS bytes,
               COUNT(*)::int AS tables
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' {where_clause}
      "#
    );

    let mut c = connect_target(state, id, user_id).await?;
    let row = sqlx::query(&sql).fetch_optional(&mut *c).await;
    let _ = c.close().await;
    let row = row?;

    let (bytes, tables) = match row {
        Some(r) => (
            r.try_get::<String, _>("bytes").ok().and_then(|b| b.trim().parse::<i64>().ok()),
            r.try_get::<i32, _>("tables").unwrap_or(0) as i64,
        ),
        None => (Some(0), 0),
    };
    Ok(Estimate { bytes, tables, note: "On-disk size; dump output typically 50â€“200% of this" })
}

/// Cheap probe for the remote server's major so we can pick a matching pg_dump.
/// `SHOW server_version_num` â†’ 170001 for PG 17.1 â†’ major 17.
async fn detect_postgres_major(state: &AppState, id: &str, user_id: &str) -> Option<u32> {
    let mut c = match connect_target(state, id, user_id).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("server_version_num probe failed: {}", e.message);
            return None;
        }
    };
    let res: Result<String, sqlx::Error> = sqlx::query_scalar("SHOW server_version_num")
        .fetch_one(&mut *c)
        .await;
    let _ = c.close().await;
    match res {
        Ok(v) => v.trim().parse::<u32>().ok().map(|n| n / 10_000),
        Err(e) => {
            tracing::warn!("server_version_num probe failed: {e}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// GET /backup  (OWNER) â€” streams pg_dump
// ---------------------------------------------------------------------------

/// v1's IDENT_RE: `-n` takes a pattern, so schema names are locked to simple idents.
fn ident_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > 64 {
        return false;
    }
    if !(b[0].is_ascii_alphabetic() || b[0] == b'_') {
        return false;
    }
    b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// `name.replace(/[^a-z0-9-_]+/gi, '_')` â€” runs of unsafe chars collapse to one `_`.
pub(crate) fn safe_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out
}

async fn download(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    // Full-database dump is an owner-level op (v1: @RequireRole('OWNER')).
    require_conn_owner(&state, &id, &user.id).await?;

    // --- controller-level query-param handling (verbatim from v1) ---
    let format_custom = q.get("format").map(|f| f == "custom").unwrap_or(false);
    let schema_only_raw = q.get("schemaOnly");
    if let Some(v) = schema_only_raw {
        if v != "true" && v != "false" && !v.is_empty() {
            return Err(ApiError::bad("schemaOnly must be true or false"));
        }
    }
    let schema_only = schema_only_raw.map(|v| v == "true").unwrap_or(false);
    let schema = q.get("schema").filter(|s| !s.is_empty()).cloned();

    let conn = load_conn(&state, &id, &user.id).await?;
    let mysql = conn.dialect.eq_ignore_ascii_case("MYSQL");
    if !is_postgres(&conn.dialect) && !mysql {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            format!(
                "Backup supports PostgreSQL and MySQL connections (got {}). \
                 SQL Server needs sqlcmd, which is not installed.",
                conn.dialect
            ),
        ));
    }
    if mysql && format_custom {
        // mysqldump has no equivalent of pg_dump's custom archive.
        return Err(ApiError::bad(
            "MySQL dumps are plain SQL — drop format=custom",
        ));
    }
    if let Some(s) = &schema {
        if !ident_ok(s) {
            return Err(ApiError::bad("Invalid schema name"));
        }
    }

    let creds = decrypt_creds(&state, &id, &conn.credentials_ct)?;
    let host = creds.host.clone().filter(|h| !h.is_empty());
    let port = creds.port.as_ref().and_then(port_str);
    let (host, port) = match (host, port) {
        (Some(h), Some(p)) => (h, p),
        _ => return Err(ApiError::bad("Connection is missing host/port")),
    };
    if creds.ssh.as_ref().map(|v| !v.is_null()).unwrap_or(false) {
        // v1 opens an SSH forward and points pg_dump at the local endpoint.
        // v2 has no tunnel service â€” fail loudly rather than dialling a host
        // that is only reachable through the bastion.
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            "Backup over an SSH tunnel is not supported by the v2 API yet",
        ));
    }

    // Detect the remote major so we can pick the matching pg_dump binary â€” a
    // few ms, and it catches the most common backup failure ("server version
    // newer than pg_dump").
    // MySQL takes a different binary and a different flag vocabulary, so it
    // forks here. Streaming, cancellation and the wait-for-first-byte rule are
    // the same on both paths.
    if mysql {
        return mysql_dump(
            MysqlDump {
                host,
                port,
                user: creds.user.clone().unwrap_or_else(|| "root".into()),
                password: creds.password.clone().unwrap_or_default(),
                database: creds
                    .database
                    .clone()
                    .filter(|d| !d.is_empty())
                    .ok_or_else(|| ApiError::bad("Connection is missing a database name"))?,
                schema_only,
                name: conn.name.clone(),
            },
            id,
        )
        .await;
    }

    let server_major = detect_postgres_major(&state, &id, &user.id).await;
    let binary = pick_pg_dump_binary(server_major)?;
    if let Some(note) = &binary.note {
        tracing::info!("{note}");
    }

    let mut args: Vec<String> = vec![
        "--host".into(),
        host,
        "--port".into(),
        port,
        "--username".into(),
        creds.user.clone().unwrap_or_else(|| "postgres".into()),
        "--dbname".into(),
        creds.database.clone().unwrap_or_else(|| "postgres".into()),
        "--no-password".into(), // rely on PGPASSWORD env; fail fast if missing
        "--verbose".into(),
    ];
    if schema_only {
        args.push("--schema-only".into());
    }
    if let Some(s) = &schema {
        args.push("--schema".into());
        args.push(s.clone());
    }
    args.push(if format_custom { "--format=custom".into() } else { "--format=plain".into() });

    let ext = if format_custom { "dump" } else { "sql" };
    let filename = format!(
        "{}-{}.{}",
        safe_name(&conn.name),
        chrono::Utc::now().format("%Y-%m-%d"),
        ext
    );

    // Pre-flight estimate so the client can draw a progress bar. Skipped for
    // --schema-only (on-disk size includes data â†’ wild overestimate).
    let est = if schema_only {
        Estimate { bytes: None, tables: 0, note: "" }
    } else {
        match estimate_size(&state, &id, &user.id, schema.as_deref()).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("estimate failed, continuing without: {}", e.message);
                Estimate { bytes: None, tables: 0, note: "" }
            }
        }
    };

    tracing::info!("pg_dump start conn={id} fmt={} schemaOnly={schema_only}", if format_custom { "custom" } else { "sql" });

    // Password via env â€” never argv (ps would show it). PGCONNECT_TIMEOUT caps
    // the hang when the remote is unreachable.
    let mut child = Command::new(&binary.cmd)
        .args(&args)
        .env("PGPASSWORD", creds.password.clone().unwrap_or_default())
        .env("PGCONNECT_TIMEOUT", "30")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            tracing::error!("pg_dump spawn error: {e}");
            ApiError::internal("Failed to start pg_dump (is it installed?)")
        })?;

    let mut stdout = child.stdout.take().ok_or_else(|| ApiError::internal("pg_dump stdout unavailable"))?;
    let stderr = child.stderr.take().ok_or_else(|| ApiError::internal("pg_dump stderr unavailable"))?;
    // stderr must be drained continuously or --verbose fills the pipe and pg_dump blocks.
    let stderr_tail = spawn_stderr_drain(stderr);

    // Wait for the first stdout bytes before committing to a 200. Node flushes
    // the headers on the first body write, so v1 can still answer with a JSON
    // 500 when pg_dump dies before producing output (bad password, unreachable
    // host); this reproduces that.
    let mut first = vec![0u8; 64 * 1024];
    let n = stdout.read(&mut first).await.map_err(|e| ApiError::internal(format!("pg_dump read failed: {e}")))?;
    if n == 0 {
        let status = child.wait().await.ok();
        let code = status.and_then(|s| s.code());
        if !status.map(|s| s.success()).unwrap_or(false) {
            let tail = stderr_tail_string(&stderr_tail);
            tracing::warn!("pg_dump exited {}: {tail}", code_str(code));
            return Err(ApiError::internal(format!("pg_dump failed: {}", last_line(&tail, code))));
        }
        tracing::info!("pg_dump ok conn={id}");
    }
    first.truncate(n);

    let reader = DumpReader {
        prefix: first,
        pos: 0,
        stdout,
        child: Some(child),
        stderr_tail,
        conn_id: id.clone(),
    };

    let mut res = Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::CONTENT_TYPE,
            if format_custom { "application/octet-stream" } else { "application/sql" },
        )
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header("X-Content-Type-Options", "nosniff");
    // Progress hints â€” the client subtracts bytes received from the estimate.
    if let Some(b) = est.bytes {
        res = res.header("X-Dbdash-Estimate-Bytes", b.to_string());
    }
    if est.tables > 0 {
        res = res.header("X-Dbdash-Tables-Total", est.tables.to_string());
    }
    // Must be exposed for the browser to read them off a cross-origin response.
    res = res.header(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        "Content-Disposition, X-Dbdash-Estimate-Bytes, X-Dbdash-Tables-Total",
    );

    res.body(Body::from_stream(ReaderStream::new(reader)))
        .map_err(|e| ApiError::internal(format!("failed to build response: {e}")))
}

// ---------------------------------------------------------------------------
// Restore — replay a dump into a connection
//
// The dangerous direction, so it is fenced:
//   * OWNER only, like taking the dump.
//   * `?confirm=true` must be explicit. A restore is not undoable and usually
//     drops what is there first; a stray request must not be enough.
//   * A read-only connection refuses outright.
//   * It is audited before it starts, so there is a record even if it fails
//     halfway.
//
// The upload is streamed straight into the child's stdin — a multi-GB dump
// never lands on this server's disk and never sits in its memory.
// ---------------------------------------------------------------------------

/// First bytes of a pg_dump custom archive. Plain SQL dumps start with `--`.
const PGDMP_MAGIC: &[u8] = b"PGDMP";

async fn restore(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: axum::http::HeaderMap,
    body: axum::body::Body,
) -> ApiResult<Json<Value>> {
    require_conn_owner(&state, &id, &user.id).await?;
    if q.get("confirm").map(String::as_str) != Some("true") {
        return Err(ApiError::bad(
            "Restoring overwrites data and cannot be undone — resend with confirm=true",
        ));
    }

    let conn = load_conn(&state, &id, &user.id).await?;
    if conn.read_only {
        return Err(ApiError::bad("Connection is read-only"));
    }
    let mysql = conn.dialect.eq_ignore_ascii_case("MYSQL");
    if !is_postgres(&conn.dialect) && !mysql {
        return Err(ApiError::new(
            StatusCode::NOT_IMPLEMENTED,
            format!("Restore supports PostgreSQL and MySQL connections (got {})", conn.dialect),
        ));
    }

    let creds = decrypt_creds(&state, &id, &conn.credentials_ct)?;
    let host = creds
        .host
        .clone()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| ApiError::bad("Connection is missing host/port"))?;
    let port = creds
        .port
        .as_ref()
        .and_then(port_str)
        .ok_or_else(|| ApiError::bad("Connection is missing host/port"))?;
    let database = creds
        .database
        .clone()
        .filter(|d| !d.is_empty())
        .ok_or_else(|| ApiError::bad("Connection is missing a database name"))?;

    crate::audit_row(
        &state,
        &user.id,
        &id,
        "CONNECTION_UPDATED",
        0,
        &crate::req_meta(&headers),
        json!({ "restore": true, "database": database }),
    )
    .await;

    // Peek at the first chunk: a custom-format archive needs pg_restore, plain
    // SQL needs psql, and the only way to tell is the magic at the front.
    let mut stream = body.into_data_stream();
    let first = match stream.next().await {
        Some(Ok(b)) => b,
        Some(Err(e)) => return Err(ApiError::bad(format!("Upload failed: {e}"))),
        None => return Err(ApiError::bad("Empty upload — attach a dump file")),
    };
    let custom = first.starts_with(PGDMP_MAGIC);

    let started = std::time::Instant::now();
    let mut child = if mysql {
        Command::new("mysql")
            .args([
                format!("--host={host}"),
                format!("--port={port}"),
                format!("--user={}", creds.user.clone().unwrap_or_else(|| "root".into())),
                "--default-character-set=utf8mb4".into(),
                database.clone(),
            ])
            .env("MYSQL_PWD", creds.password.clone().unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    } else if custom {
        Command::new("pg_restore")
            .args([
                "--host".into(),
                host.clone(),
                "--port".into(),
                port.clone(),
                "--username".into(),
                creds.user.clone().unwrap_or_else(|| "postgres".into()),
                "--dbname".into(),
                database.clone(),
                "--no-password".into(),
                // Replace what is there rather than failing on every existing
                // object, and do not try to reassign ownership to roles that
                // may not exist on this server.
                "--clean".into(),
                "--if-exists".into(),
                "--no-owner".into(),
                "--no-acl".into(),
            ])
            .env("PGPASSWORD", creds.password.clone().unwrap_or_default())
            .env("PGCONNECT_TIMEOUT", "30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    } else {
        Command::new("psql")
            .args([
                "--host".into(),
                host.clone(),
                "--port".into(),
                port.clone(),
                "--username".into(),
                creds.user.clone().unwrap_or_else(|| "postgres".into()),
                "--dbname".into(),
                database.clone(),
                "--no-password".into(),
                // Stop at the first error instead of plastering a half-applied
                // dump over the database and reporting success.
                "--set".into(),
                "ON_ERROR_STOP=1".into(),
                "--quiet".into(),
            ])
            .env("PGPASSWORD", creds.password.clone().unwrap_or_default())
            .env("PGCONNECT_TIMEOUT", "30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }
    .map_err(|e| {
        tracing::error!("restore spawn error: {e}");
        ApiError::internal("Failed to start the restore tool (is it installed?)")
    })?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ApiError::internal("restore stdin unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ApiError::internal("restore stderr unavailable"))?;
    let stderr_tail = spawn_stderr_drain(stderr);

    let mut bytes: u64 = 0;
    bytes += first.len() as u64;
    if let Err(e) = stdin.write_all(&first).await {
        return Err(ApiError::internal(format!("restore write failed: {e}")));
    }
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ApiError::bad(format!("Upload failed: {e}")))?;
        bytes += chunk.len() as u64;
        if let Err(e) = stdin.write_all(&chunk).await {
            // A broken pipe means the tool exited early; report its own words.
            tracing::warn!("restore stdin closed after {bytes} bytes: {e}");
            break;
        }
    }
    drop(stdin); // EOF — the tool finishes and exits

    let status = child
        .wait()
        .await
        .map_err(|e| ApiError::internal(format!("restore wait failed: {e}")))?;
    let tail = stderr_tail_string(&stderr_tail);
    let took = started.elapsed().as_millis() as u64;

    if !status.success() {
        tracing::warn!("restore conn={id} exited {}: {tail}", code_str(status.code()));
        return Err(ApiError::internal(format!(
            "Restore failed: {}",
            last_line(&tail, status.code())
        )));
    }
    tracing::info!("restore ok conn={id} bytes={bytes} ms={took}");
    Ok(Json(json!({
        "ok": true,
        "bytes": bytes,
        "durationMs": took,
        "format": if mysql { "mysql" } else if custom { "pg_restore" } else { "psql" },
        // pg_restore reports recoverable problems here and still exits 0.
        "warnings": tail.lines().rev().take(20).collect::<Vec<_>>().join("\n"),
    })))
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

struct MysqlDump {
    host: String,
    port: String,
    user: String,
    password: String,
    database: String,
    schema_only: bool,
    name: String,
}

/// `mysqldump` equivalent of the Postgres path above.
///
/// The password goes in through `MYSQL_PWD` rather than `--password=`, for the
/// same reason `PGPASSWORD` does: argv is world-readable in `ps`.
/// `--single-transaction` takes a consistent snapshot of InnoDB tables without
/// locking the database, which is what makes dumping a live server safe.
async fn mysql_dump(cfg: MysqlDump, id: String) -> ApiResult<Response> {
    let mut args: Vec<String> = vec![
        format!("--host={}", cfg.host),
        format!("--port={}", cfg.port),
        format!("--user={}", cfg.user),
        "--single-transaction".into(),
        "--quick".into(),
        "--routines".into(),
        "--triggers".into(),
        "--events".into(),
        "--default-character-set=utf8mb4".into(),
        // Without this the dump is a DEFINER-bound restore that only the
        // original user can replay.
        "--set-gtid-purged=OFF".into(),
    ];
    if cfg.schema_only {
        args.push("--no-data".into());
    }
    args.push(cfg.database.clone());

    let filename = format!(
        "{}-{}.sql",
        safe_name(&cfg.name),
        chrono::Utc::now().format("%Y-%m-%d")
    );

    tracing::info!("mysqldump start conn={id} schemaOnly={}", cfg.schema_only);
    let mut child = Command::new("mysqldump")
        .args(&args)
        .env("MYSQL_PWD", &cfg.password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            tracing::error!("mysqldump spawn error: {e}");
            ApiError::internal("Failed to start mysqldump (is it installed?)")
        })?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| ApiError::internal("mysqldump stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ApiError::internal("mysqldump stderr unavailable"))?;
    let stderr_tail = spawn_stderr_drain(stderr);

    // Same contract as pg_dump: no bytes means it died before producing a
    // dump, and the client gets a JSON error instead of a truncated file.
    let mut first = vec![0u8; 64 * 1024];
    let n = stdout
        .read(&mut first)
        .await
        .map_err(|e| ApiError::internal(format!("mysqldump read failed: {e}")))?;
    if n == 0 {
        let status = child.wait().await.ok();
        let code = status.and_then(|s| s.code());
        if !status.map(|s| s.success()).unwrap_or(false) {
            let tail = stderr_tail_string(&stderr_tail);
            tracing::warn!("mysqldump exited {}: {tail}", code_str(code));
            return Err(ApiError::internal(format!(
                "mysqldump failed: {}",
                last_line(&tail, code)
            )));
        }
    }
    first.truncate(n);

    let reader = DumpReader {
        prefix: first,
        pos: 0,
        stdout,
        child: Some(child),
        stderr_tail,
        conn_id: id,
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, "application/sql")
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header(
            axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Disposition",
        )
        .body(Body::from_stream(ReaderStream::new(reader)))
        .map_err(|e| ApiError::internal(format!("failed to build response: {e}")))
}

/// `port` may arrive as a JSON number or string; both stringify to argv.
fn port_str(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Streaming plumbing
// ---------------------------------------------------------------------------

/// Keep the tail of stderr â€” enough for the fatal line, bounded so a chatty
/// --verbose dump can't grow it without limit.
const STDERR_CAP: usize = 8 * 1024;

fn spawn_stderr_drain(mut stderr: ChildStderr) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let sink = buf.clone();
    tokio::spawn(async move {
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut g) = sink.lock() {
                        g.extend_from_slice(&chunk[..n]);
                        if g.len() > STDERR_CAP {
                            let excess = g.len() - STDERR_CAP;
                            g.drain(..excess);
                        }
                    }
                }
            }
        }
    });
    buf
}

fn stderr_tail_string(buf: &Arc<Mutex<Vec<u8>>>) -> String {
    let bytes = buf.lock().map(|g| g.clone()).unwrap_or_default();
    let s = String::from_utf8_lossy(&bytes).to_string();
    // v1 slices the last 2000 chars of the collected stderr.
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 2000 {
        s
    } else {
        chars[chars.len() - 2000..].iter().collect()
    }
}

fn code_str(code: Option<i32>) -> String {
    code.map(|c| c.to_string()).unwrap_or_else(|| "null".into())
}

/// v1: `tail.split('\n').pop() || 'exit code ' + code`. Note the quirk â€” stderr
/// usually ends with a newline, so the last segment is empty and the message
/// falls back to the exit code. Reproduced as-is.
fn last_line(tail: &str, code: Option<i32>) -> String {
    let last = tail.split('\n').last().unwrap_or("");
    if last.is_empty() {
        format!("exit code {}", code_str(code))
    } else {
        last.to_string()
    }
}

/// `pg_dump`'s stdout plus the first chunk we peeked, carrying the `Child` so
/// that dropping the response body (client disconnect) kills the dump.
struct DumpReader {
    prefix: Vec<u8>,
    pos: usize,
    stdout: ChildStdout,
    child: Option<Child>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    conn_id: String,
}

impl AsyncRead for DumpReader {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();

        if this.pos < this.prefix.len() {
            let n = std::cmp::min(buf.remaining(), this.prefix.len() - this.pos);
            buf.put_slice(&this.prefix[this.pos..this.pos + n]);
            this.pos += n;
            if this.pos >= this.prefix.len() {
                this.prefix = Vec::new(); // release the 64 KB peek buffer
                this.pos = 0;
            }
            return Poll::Ready(Ok(()));
        }

        let before = buf.filled().len();
        match Pin::new(&mut this.stdout).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                if buf.filled().len() == before {
                    // EOF: hand the child to a reaper so a non-zero exit gets
                    // logged with the stderr tail (v1's `child.on('close')`).
                    if let Some(child) = this.child.take() {
                        tokio::spawn(reap(child, this.stderr_tail.clone(), this.conn_id.clone()));
                    }
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

async fn reap(mut child: Child, stderr_tail: Arc<Mutex<Vec<u8>>>, conn_id: String) {
    match child.wait().await {
        Ok(status) if status.success() => tracing::info!("pg_dump ok conn={conn_id}"),
        Ok(status) => {
            let tail = stderr_tail_string(&stderr_tail);
            tracing::warn!("pg_dump exited {}: {tail}", code_str(status.code()));
        }
        Err(e) => tracing::warn!("pg_dump wait failed: {e}"),
    }
}
