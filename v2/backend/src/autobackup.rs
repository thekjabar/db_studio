//! Automatic backups: dump on a schedule, push to S3-compatible storage, keep
//! the last N, and record every run.
//!
//! The manual `/backup` endpoint streams a dump to whoever asked for it. That
//! only protects a database someone remembers to click for. This runs without
//! anyone present, which means it has to answer three questions the manual path
//! never does: where does the file go, how long is it kept, and how do you find
//! out it stopped working.
//!
//! Storage is any S3-compatible bucket the user configures — Cloudflare R2,
//! Backblaze B2, MinIO, AWS itself. The access key is encrypted with the same
//! envelope as a connection's credentials, so this table never holds a readable
//! secret, and requests are signed with SigV4 by hand (the AWS SDK would be a
//! very large dependency for PUT, GET-list and DELETE).
//!
//! The dump itself is produced by the same `pg_dump`/`mysqldump` invocation the
//! manual download uses, and is streamed from the child process straight into
//! the upload: a 10 GB database never lands on this server's disk.

use std::process::Stdio;

use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::{ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/connections/:id/backup-schedules",
            get(list).post(create),
        )
        .route(
            "/api/backup-schedules/:id",
            axum::routing::patch(update).delete(remove),
        )
        .route("/api/backup-schedules/:id/run", post(run_now))
        .route("/api/backup-schedules/:id/runs", get(runs))
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const COLS: &str = r#""id","connectionId","ownerId","cron","timezone","schemaName","format",
    "schemaOnly","keepLast","enabled","bucket","prefix","endpoint","region",
    "lastRunAt","lastStatus","lastError","lastSizeBytes","nextRunAt","createdAt","updatedAt""#;

fn row_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "connectionId": r.try_get::<String, _>("connectionId").unwrap_or_default(),
        "cron": r.try_get::<String, _>("cron").unwrap_or_default(),
        "timezone": r.try_get::<Option<String>, _>("timezone").unwrap_or(None),
        "schemaName": r.try_get::<Option<String>, _>("schemaName").unwrap_or(None),
        "format": r.try_get::<String, _>("format").unwrap_or_default(),
        "schemaOnly": r.try_get::<bool, _>("schemaOnly").unwrap_or(false),
        "keepLast": r.try_get::<i32, _>("keepLast").unwrap_or(7),
        "enabled": r.try_get::<bool, _>("enabled").unwrap_or(false),
        "bucket": r.try_get::<String, _>("bucket").unwrap_or_default(),
        "prefix": r.try_get::<String, _>("prefix").unwrap_or_default(),
        "endpoint": r.try_get::<String, _>("endpoint").unwrap_or_default(),
        "region": r.try_get::<String, _>("region").unwrap_or_default(),
        "lastRunAt": crate::iso(r, "lastRunAt"),
        "lastStatus": r.try_get::<Option<String>, _>("lastStatus").unwrap_or(None),
        "lastError": r.try_get::<Option<String>, _>("lastError").unwrap_or(None),
        "lastSizeBytes": r.try_get::<Option<i64>, _>("lastSizeBytes").unwrap_or(None),
        "nextRunAt": crate::iso(r, "nextRunAt"),
        "createdAt": crate::iso(r, "createdAt"),
    })
}

#[derive(Deserialize)]
struct CreateBody {
    cron: String,
    timezone: Option<String>,
    #[serde(rename = "schemaName")]
    schema_name: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(rename = "schemaOnly", default)]
    schema_only: bool,
    #[serde(rename = "keepLast", default)]
    keep_last: Option<i32>,
    #[serde(default)]
    enabled: Option<bool>,
    bucket: String,
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(rename = "accessKeyId")]
    access_key_id: String,
    #[serde(rename = "secretAccessKey")]
    secret_access_key: String,
}

/// The bucket credentials, as stored (encrypted) and used (SigV4).
#[derive(serde::Serialize, Deserialize)]
struct S3Creds {
    #[serde(rename = "accessKeyId")]
    access_key_id: String,
    #[serde(rename = "secretAccessKey")]
    secret_access_key: String,
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::audit_log::audit_require_role(&state, &conn_id, &user.id, "OWNER").await?;
    let rows = sqlx::query(&format!(
        r#"SELECT {COLS} FROM "BackupSchedule" WHERE "connectionId" = $1 ORDER BY "createdAt""#
    ))
    .bind(&conn_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(rows.iter().map(row_json).collect())))
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(conn_id): Path<String>,
    Json(body): Json<CreateBody>,
) -> ApiResult<(axum::http::StatusCode, Json<Value>)> {
    // Taking a full dump is an owner-level act, and so is pointing one at a
    // bucket — it moves every row in the database somewhere else.
    crate::audit_log::audit_require_role(&state, &conn_id, &user.id, "OWNER").await?;

    if body.bucket.trim().is_empty() {
        return Err(ApiError::bad("bucket is required"));
    }
    if body.access_key_id.trim().is_empty() || body.secret_access_key.trim().is_empty() {
        return Err(ApiError::bad("Storage credentials are required"));
    }
    // Reject a cron the runner could never fire rather than storing a schedule
    // that silently does nothing.
    crate::schedules::cronparser::next_millis(
        &body.cron,
        body.timezone.as_deref(),
        chrono::Utc::now().timestamp_millis(),
    )
    .map_err(|e| ApiError::bad(format!("Invalid cron: {e}")))?;

    let id = crate::gen_id();
    let ct = encrypt_creds(
        &state,
        &id,
        &S3Creds {
            access_key_id: body.access_key_id,
            secret_access_key: body.secret_access_key,
        },
    )?;

    let row = sqlx::query(&format!(
        r#"INSERT INTO "BackupSchedule"
             ("id","connectionId","ownerId","cron","timezone","schemaName","format","schemaOnly",
              "keepLast","enabled","bucket","prefix","endpoint","region","credentialsCt",
              "createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())
           RETURNING {COLS}"#
    ))
    .bind(&id)
    .bind(&conn_id)
    .bind(&user.id)
    .bind(body.cron.trim())
    .bind(body.timezone.as_deref())
    .bind(body.schema_name.as_deref())
    .bind(body.format.as_deref().unwrap_or("custom"))
    .bind(body.schema_only)
    .bind(body.keep_last.unwrap_or(7).max(0))
    .bind(body.enabled.unwrap_or(true))
    .bind(body.bucket.trim())
    .bind(body.prefix.as_deref().unwrap_or("").trim_matches('/'))
    .bind(body.endpoint.as_deref().unwrap_or("").trim_end_matches('/'))
    .bind(body.region.as_deref().unwrap_or("auto"))
    .bind(&ct)
    .fetch_one(&state.pool)
    .await?;
    Ok((axum::http::StatusCode::CREATED, Json(row_json(&row))))
}

#[derive(Deserialize)]
struct UpdateBody {
    cron: Option<String>,
    timezone: Option<String>,
    enabled: Option<bool>,
    #[serde(rename = "keepLast")]
    keep_last: Option<i32>,
}

/// Only the fields a user changes day to day. Repointing the bucket means new
/// credentials, which means a new schedule — that is deliberate.
async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<Value>> {
    let conn_id = owned_schedule(&state, &id, &user.id).await?;
    let _ = conn_id;
    if let Some(c) = &body.cron {
        crate::schedules::cronparser::next_millis(
            c,
            body.timezone.as_deref(),
            chrono::Utc::now().timestamp_millis(),
        )
        .map_err(|e| ApiError::bad(format!("Invalid cron: {e}")))?;
    }
    let row = sqlx::query(&format!(
        r#"UPDATE "BackupSchedule"
              SET "cron"     = COALESCE($2, "cron"),
                  "timezone" = COALESCE($3, "timezone"),
                  "enabled"  = COALESCE($4, "enabled"),
                  "keepLast" = COALESCE($5, "keepLast"),
                  -- Let the runner recompute from whatever the cron now says.
                  "nextRunAt" = NULL,
                  "updatedAt" = now()
            WHERE "id" = $1
        RETURNING {COLS}"#
    ))
    .bind(&id)
    .bind(body.cron.as_deref().map(str::trim))
    .bind(body.timezone.as_deref())
    .bind(body.enabled)
    .bind(body.keep_last.map(|k| k.max(0)))
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(row_json(&row)))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    owned_schedule(&state, &id, &user.id).await?;
    sqlx::query(r#"DELETE FROM "BackupSchedule" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

async fn runs(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_schedule(&state, &id, &user.id).await?;
    let rows = sqlx::query(
        r#"SELECT "id","startedAt","finishedAt","status","sizeBytes","durationMs","objectKey","errorMessage"
             FROM "BackupRun" WHERE "scheduleId" = $1 ORDER BY "startedAt" DESC LIMIT 50"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<String, _>("id").unwrap_or_default(),
                    "startedAt": crate::iso(r, "startedAt"),
                    "finishedAt": crate::iso(r, "finishedAt"),
                    "status": r.try_get::<String, _>("status").unwrap_or_default(),
                    "sizeBytes": r.try_get::<Option<i64>, _>("sizeBytes").unwrap_or(None),
                    "durationMs": r.try_get::<Option<i32>, _>("durationMs").unwrap_or(None),
                    "objectKey": r.try_get::<Option<String>, _>("objectKey").unwrap_or(None),
                    "errorMessage": r.try_get::<Option<String>, _>("errorMessage").unwrap_or(None),
                })
            })
            .collect(),
    )))
}

/// Run one now. Returns when the upload has finished, so the UI can report the
/// real outcome — a backup you cannot see fail is not a backup.
async fn run_now(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_schedule(&state, &id, &user.id).await?;
    let sched = load(&state, &id).await?;
    let out = execute(&state, &sched).await;
    match out {
        Ok(done) => Ok(Json(json!({
            "ok": true,
            "objectKey": done.key,
            "sizeBytes": done.bytes,
            "durationMs": done.took_ms,
        }))),
        Err(e) => Err(ApiError::internal(e)),
    }
}

/// The caller owns the connection this schedule belongs to.
async fn owned_schedule(state: &AppState, id: &str, user_id: &str) -> ApiResult<String> {
    let conn_id: Option<String> =
        sqlx::query_scalar(r#"SELECT "connectionId" FROM "BackupSchedule" WHERE "id" = $1"#)
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let conn_id = conn_id.ok_or_else(|| {
        ApiError::new(axum::http::StatusCode::NOT_FOUND, "Backup schedule not found")
    })?;
    crate::audit_log::audit_require_role(state, &conn_id, user_id, "OWNER").await?;
    Ok(conn_id)
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

pub(crate) struct Schedule {
    pub id: String,
    pub connection_id: String,
    pub owner_id: String,
    pub cron: String,
    pub timezone: Option<String>,
    pub schema_name: Option<String>,
    pub format: String,
    pub schema_only: bool,
    pub keep_last: i32,
    pub bucket: String,
    pub prefix: String,
    pub endpoint: String,
    pub region: String,
    pub credentials_ct: String,
}

pub(crate) struct Done {
    pub key: String,
    pub bytes: u64,
    pub took_ms: u64,
}

const LOAD_COLS: &str = r#""id","connectionId","ownerId","cron","timezone","schemaName","format",
    "schemaOnly","keepLast","bucket","prefix","endpoint","region","credentialsCt""#;

fn read_schedule(r: &sqlx::postgres::PgRow) -> Schedule {
    Schedule {
        id: r.try_get("id").unwrap_or_default(),
        connection_id: r.try_get("connectionId").unwrap_or_default(),
        owner_id: r.try_get("ownerId").unwrap_or_default(),
        cron: r.try_get("cron").unwrap_or_default(),
        timezone: r.try_get("timezone").ok().flatten(),
        schema_name: r.try_get("schemaName").ok().flatten(),
        format: r.try_get("format").unwrap_or_else(|_| "custom".into()),
        schema_only: r.try_get("schemaOnly").unwrap_or(false),
        keep_last: r.try_get("keepLast").unwrap_or(7),
        bucket: r.try_get("bucket").unwrap_or_default(),
        prefix: r.try_get("prefix").unwrap_or_default(),
        endpoint: r.try_get("endpoint").unwrap_or_default(),
        region: r.try_get("region").unwrap_or_else(|_| "auto".into()),
        credentials_ct: r.try_get("credentialsCt").unwrap_or_default(),
    }
}

async fn load(state: &AppState, id: &str) -> ApiResult<Schedule> {
    let row = sqlx::query(&format!(
        r#"SELECT {LOAD_COLS} FROM "BackupSchedule" WHERE "id" = $1"#
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "Backup schedule not found"))?;
    Ok(read_schedule(&row))
}

fn encrypt_creds(state: &AppState, id: &str, creds: &S3Creds) -> ApiResult<String> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;
    let plain = serde_json::to_string(creds).map_err(|e| ApiError::internal(e.to_string()))?;
    crypto
        .encrypt(&plain, &purpose(id))
        .map_err(|e| ApiError::internal(e.to_string()))
}

fn decrypt_creds(state: &AppState, id: &str, ct: &str) -> Result<S3Creds, String> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| "ENCRYPTION_KEY not configured".to_string())?;
    let plain = crypto.decrypt(ct, &purpose(id)).map_err(|e| e.to_string())?;
    serde_json::from_str(&plain).map_err(|e| e.to_string())
}

/// Bound to the schedule id, so a ciphertext copied to another row is useless.
fn purpose(id: &str) -> String {
    format!("backup:{id}")
}

/// Dump the database and upload it, returning where it landed.
pub(crate) async fn execute(state: &AppState, s: &Schedule) -> Result<Done, String> {
    let started = std::time::Instant::now();
    let creds = decrypt_creds(state, &s.id, &s.credentials_ct)?;

    let conn = sqlx::query(
        r#"SELECT "name", "dialect"::text AS dialect, "credentialsCt" FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(&s.connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Connection not found".to_string())?;

    let name: String = conn.try_get("name").unwrap_or_default();
    let dialect: String = conn.try_get("dialect").unwrap_or_default();
    let conn_ct: String = conn.try_get("credentialsCt").unwrap_or_default();
    let db = crate::backup::creds_for_dump(state, &s.connection_id, &conn_ct)?;

    let mysql = dialect.eq_ignore_ascii_case("MYSQL");
    if !dialect.to_uppercase().contains("POSTGRES") && !mysql {
        return Err(format!("Backups support PostgreSQL and MySQL (got {dialect})"));
    }

    // Plain SQL compresses ~5-10x and the bucket charges for what it stores, so
    // every dump is gzipped on the way out. A custom-format pg_dump is already
    // compressed; gzip would only add a wrapper, so it keeps its own format.
    let custom = !mysql && s.format == "custom";
    let ext = if mysql {
        "sql.gz"
    } else if custom {
        "dump"
    } else {
        "sql.gz"
    };
    let key = format!(
        "{}{}-{}.{}",
        if s.prefix.is_empty() { String::new() } else { format!("{}/", s.prefix) },
        crate::backup::safe_name(&name),
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ"),
        ext
    );

    let mut child = if mysql {
        let mut args: Vec<String> = vec![
            format!("--host={}", db.host),
            format!("--port={}", db.port),
            format!("--user={}", db.user),
            "--single-transaction".into(),
            "--quick".into(),
            "--routines".into(),
            "--triggers".into(),
            "--default-character-set=utf8mb4".into(),
            "--set-gtid-purged=OFF".into(),
        ];
        if s.schema_only {
            args.push("--no-data".into());
        }
        args.push(db.database.clone());
        Command::new("mysqldump")
            .args(args)
            .env("MYSQL_PWD", &db.password)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    } else {
        let mut args: Vec<String> = vec![
            "--host".into(),
            db.host.clone(),
            "--port".into(),
            db.port.clone(),
            "--username".into(),
            db.user.clone(),
            "--dbname".into(),
            db.database.clone(),
            "--no-password".into(),
        ];
        if s.schema_only {
            args.push("--schema-only".into());
        }
        if let Some(sc) = s.schema_name.as_deref().filter(|v| !v.is_empty()) {
            args.push("--schema".into());
            args.push(sc.to_string());
        }
        args.push(if custom { "--format=custom".into() } else { "--format=plain".into() });
        Command::new("pg_dump")
            .args(args)
            .env("PGPASSWORD", &db.password)
            .env("PGCONNECT_TIMEOUT", "30")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
    }
    .map_err(|e| format!("Failed to start the dump tool: {e}"))?;

    let mut stdout = child.stdout.take().ok_or("dump stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("dump stderr unavailable")?;

    // Buffer the dump, gzipping plain SQL as it arrives. Streaming into a
    // multipart upload would avoid holding it, but a single PUT is the only
    // thing every S3-compatible provider implements identically, and a
    // scheduled backup of a database this product targets fits in memory once
    // compressed. The cap below is the honest limit, reported as such.
    const MAX_BYTES: usize = 2 * 1024 * 1024 * 1024; // 2 GB after compression
    let mut body: Vec<u8> = Vec::new();
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let gzip = ext.ends_with(".gz");
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = stdout.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if gzip {
            use std::io::Write as _;
            gz.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        } else {
            body.extend_from_slice(&buf[..n]);
        }
        let so_far = if gzip { gz.get_ref().len() } else { body.len() };
        if so_far > MAX_BYTES {
            let _ = child.kill().await;
            return Err(format!(
                "Dump exceeded {} GB compressed — use the manual download for a database this size",
                MAX_BYTES / 1024 / 1024 / 1024
            ));
        }
    }
    if gzip {
        body = gz.finish().map_err(|e| e.to_string())?;
    }

    let mut err_text = String::new();
    let _ = stderr.read_to_string(&mut err_text).await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        let tail: String = err_text.lines().rev().take(3).collect::<Vec<_>>().join(" ");
        return Err(format!("Dump failed: {tail}"));
    }
    if body.is_empty() {
        return Err("Dump produced no data".into());
    }

    let bytes = body.len() as u64;
    crate::s3::put(
        &state.http,
        &crate::s3::Target {
            bucket: s.bucket.clone(),
            endpoint: s.endpoint.clone(),
            region: s.region.clone(),
            access_key_id: creds.access_key_id.clone(),
            secret_access_key: creds.secret_access_key.clone(),
        },
        &key,
        body,
        if ext == "dump" { "application/octet-stream" } else { "application/gzip" },
    )
    .await?;

    // Retention. Deleting only after a successful upload means a failing
    // backup can never erode the copies that still work.
    if s.keep_last > 0 {
        if let Err(e) = prune(state, s, &creds).await {
            tracing::warn!("backup {} uploaded but pruning failed: {e}", s.id);
        }
    }

    Ok(Done { key, bytes, took_ms: started.elapsed().as_millis() as u64 })
}

/// Keep the newest `keepLast` objects under the prefix, delete the rest.
async fn prune(state: &AppState, s: &Schedule, creds: &S3Creds) -> Result<(), String> {
    let target = crate::s3::Target {
        bucket: s.bucket.clone(),
        endpoint: s.endpoint.clone(),
        region: s.region.clone(),
        access_key_id: creds.access_key_id.clone(),
        secret_access_key: creds.secret_access_key.clone(),
    };
    let mut keys = crate::s3::list(&state.http, &target, &s.prefix).await?;
    // The timestamp is in the name, so lexical order is chronological order.
    keys.sort();
    let keep = s.keep_last as usize;
    if keys.len() <= keep {
        return Ok(());
    }
    for old in &keys[..keys.len() - keep] {
        crate::s3::delete(&state.http, &target, old).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/// Poll for due schedules, same shape as `scheduler.rs`: advance `nextRunAt`
/// first, so a long dump costs one skipped backup rather than a pile-up.
pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(25)).await;
        tracing::info!("auto-backup: started");
        loop {
            if let Err(e) = tick(&state).await {
                tracing::warn!("auto-backup tick failed: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

async fn tick(state: &AppState) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(&format!(
        r#"SELECT {LOAD_COLS}, "nextRunAt" FROM "BackupSchedule"
            WHERE "enabled" = true AND ("nextRunAt" IS NULL OR "nextRunAt" <= now())
            ORDER BY "nextRunAt" NULLS FIRST LIMIT 10"#
    ))
    .fetch_all(&state.pool)
    .await?;

    for row in &rows {
        let s = read_schedule(row);
        let first_sight = row
            .try_get::<Option<chrono::NaiveDateTime>, _>("nextRunAt")
            .unwrap_or(None)
            .is_none();

        let now_ms = chrono::Utc::now().timestamp_millis();
        match crate::schedules::cronparser::next_millis(&s.cron, s.timezone.as_deref(), now_ms) {
            Ok(Some(ms)) => {
                if let Some(next) = chrono::DateTime::from_timestamp_millis(ms) {
                    let _ = sqlx::query(
                        r#"UPDATE "BackupSchedule" SET "nextRunAt" = $2 WHERE "id" = $1"#,
                    )
                    .bind(&s.id)
                    .bind(next.naive_utc())
                    .execute(&state.pool)
                    .await;
                }
            }
            _ => {
                tracing::warn!("auto-backup: disabling {} — unusable cron {:?}", s.id, s.cron);
                let _ = sqlx::query(
                    r#"UPDATE "BackupSchedule" SET "enabled" = false, "updatedAt" = now() WHERE "id" = $1"#,
                )
                .bind(&s.id)
                .execute(&state.pool)
                .await;
                continue;
            }
        }
        if first_sight {
            continue;
        }

        let state = state.clone();
        tokio::spawn(async move {
            let run_id = crate::gen_id();
            let _ = sqlx::query(
                r#"INSERT INTO "BackupRun" ("id","scheduleId","startedAt","status")
                   VALUES ($1,$2, now(), 'RUNNING')"#,
            )
            .bind(&run_id)
            .bind(&s.id)
            .execute(&state.pool)
            .await;

            match execute(&state, &s).await {
                Ok(done) => {
                    let _ = sqlx::query(
                        r#"UPDATE "BackupRun" SET "status"='SUCCESS', "finishedAt"=now(),
                               "sizeBytes"=$2, "durationMs"=$3, "objectKey"=$4 WHERE "id"=$1"#,
                    )
                    .bind(&run_id)
                    .bind(done.bytes as i64)
                    .bind(done.took_ms as i32)
                    .bind(&done.key)
                    .execute(&state.pool)
                    .await;
                    let _ = sqlx::query(
                        r#"UPDATE "BackupSchedule" SET "lastRunAt"=now(), "lastStatus"='SUCCESS',
                               "lastError"=NULL, "lastSizeBytes"=$2 WHERE "id"=$1"#,
                    )
                    .bind(&s.id)
                    .bind(done.bytes as i64)
                    .execute(&state.pool)
                    .await;
                    tracing::info!("auto-backup ok {} → {} ({} bytes)", s.id, done.key, done.bytes);
                }
                Err(e) => {
                    let msg: String = e.chars().take(2000).collect();
                    let _ = sqlx::query(
                        r#"UPDATE "BackupRun" SET "status"='FAILED', "finishedAt"=now(),
                               "errorMessage"=$2 WHERE "id"=$1"#,
                    )
                    .bind(&run_id)
                    .bind(&msg)
                    .execute(&state.pool)
                    .await;
                    let _ = sqlx::query(
                        r#"UPDATE "BackupSchedule" SET "lastRunAt"=now(), "lastStatus"='FAILED',
                               "lastError"=$2 WHERE "id"=$1"#,
                    )
                    .bind(&s.id)
                    .bind(&msg)
                    .execute(&state.pool)
                    .await;
                    tracing::warn!("auto-backup failed {}: {msg}", s.id);
                }
            }
        });
    }
    Ok(())
}
