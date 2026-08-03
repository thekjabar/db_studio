//! Migration export + schema snapshots — Rust port of v1's NestJS
//! `src/migration-export/` module (controller + `migration-export.service.ts` +
//! `snapshot.service.ts`), wire-compatible with it: same paths, methods, status
//! codes, error messages and JSON field names.
//!
//! `SchemaSnapshot` lives in the app database and has no `@map`, so every
//! identifier below is the quoted PascalCase / camelCase name Prisma created
//! (`"SchemaSnapshot"."connectionId"`, …). Its `createdAt` is a Prisma
//! `DateTime` → `timestamp(3) WITHOUT time zone`, so it decodes as
//! `chrono::NaiveDateTime` (a `DateTime<Utc>` would fail to decode and silently
//! null the field).
//!
//! The renderers (Prisma / Drizzle / raw SQL / diff) are byte-for-byte ports of
//! the v1 TypeScript, down to the em dashes in the generated header comments —
//! people diff these files against the ones v1 produced.
//!
//! ── Postgres only, everything else falls through to v1 ─────────────────────
//! Every route that has to introspect the customer database first checks the
//! connection's dialect: MySQL / MSSQL / SQLite connections are handed to the
//! v1 proxy, because v2 has no drivers for them and the renderers are
//! dialect-sensitive (quoting, `MODIFY COLUMN` vs `ALTER COLUMN`, the Drizzle
//! package split). Agent-backed connections are already short-circuited by
//! `agent_guard`. Snapshot list/delete touch only the app DB, so they are served
//! natively for every dialect.
//!
//! ── csv-import lives in `importer.rs` ──────────────────────────────────────
//! It used to be left to the strangler proxy: v1's `CsvImportService` keeps
//! parsed uploads in a *process-local* `Map<sessionId, Session>` (no table —
//! there is no CSV import model in `prisma/models/`) and the session is created
//! by a multipart `POST …/csv-import/upload`, which axum could not accept
//! without its `multipart` feature. That feature is enabled now, so the whole
//! module — upload, dry-run and commit together, which is the only way the
//! session map stays in one process — is ported in `src/importer.rs`. No
//! csv-import route is registered below.
//!
//! v1 sources of truth:
//!   backend/src/migration-export/migration-export.controller.ts
//!   backend/src/migration-export/migration-export.service.ts
//!   backend/src/migration-export/snapshot.service.ts
//!   backend/src/drivers/postgres.driver.ts  (`introspectForER`)

use std::collections::HashMap;

use axum::body::to_bytes;
use axum::{
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, PgPool, Row};

use crate::{conn_role, connect_target, gen_id, ApiError, ApiResult, AppState, AuthUser};

/// Every migration-export route at its full v1 path (the Nest app sets a global
/// `api` prefix, so `@Controller('connections/:id/migration-export')` serves
/// `/api/connections/:id/migration-export`).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connections/:id/migration-export", get(export))
        .route(
            "/api/connections/:id/migration-export/snapshots",
            get(snapshots_list).post(snapshot_create),
        )
        .route(
            "/api/connections/:id/migration-export/snapshots/:snapshotId",
            delete(snapshot_delete),
        )
        .route(
            "/api/connections/:id/migration-export/snapshots/:snapshotId/diff",
            get(snapshot_diff),
        )
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn text(r: &PgRow, col: &str) -> String {
    r.try_get::<String, _>(col).unwrap_or_default()
}

fn opt_text(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(col).ok().flatten()
}

/// Render a Prisma `DateTime` the way the Node API does (`Date.toISOString()`:
/// UTC, exactly milliseconds, trailing `Z`). Prisma stores these WITHOUT a time
/// zone, so they decode as `NaiveDateTime`; `DateTime<Utc>` is tried second only
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
///
/// NOTE `DELETE /snapshots/:snapshotId` carries no `@RequireRole`, and v1's
/// `RbacGuard` defaults to `'VIEWER'` — so deleting a snapshot really does only
/// need read access in v1. Reproduced as-is; widening or narrowing it here would
/// make v1 and v2 disagree on who may delete.
async fn require_role(pool: &PgPool, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match conn_role(pool, conn_id, user_id).await? {
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
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
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

/// `Some(dialect)` when Rust can serve this connection natively, `None` when the
/// request must go to v1. Mirrors `agent_guard`'s policy for the cases it does
/// not cover: non-Postgres dialects (no driver here, and every renderer branches
/// on dialect) and a missing `ENCRYPTION_KEY` (credentials can't be decrypted).
/// Call only after `require_role`, which has already proven the row exists.
async fn rust_dialect(state: &AppState, id: &str) -> ApiResult<Option<String>> {
    if state.crypto.is_none() {
        return Ok(None);
    }
    let row = sqlx::query(
        r#"SELECT "dialect"::text AS dialect, "viaAgent" FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };
    // `viaAgent` is a security-relevant routing flag — decode it strictly rather
    // than swallowing a decode error into `false` and dialing the stored host.
    let via_agent: bool = row
        .try_get("viaAgent")
        .map_err(|e| ApiError::internal(format!("viaAgent decode failed: {e}")))?;
    let dialect = text(&row, "dialect");
    if via_agent || !dialect.to_lowercase().contains("postgres") {
        return Ok(None);
    }
    Ok(Some(dialect))
}

// ---------------------------------------------------------------------------
// ErDiagram — the exact JSON shape v1 stores in `SchemaSnapshot.payload`
// ---------------------------------------------------------------------------

/// `ColumnMeta` as produced by `PostgresDriver.introspectForER` — note it omits
/// `comment` (only `getTableColumns` sets it), and `JSON.stringify` drops
/// undefined keys, so a v1 payload has exactly these ten fields in this order.
/// `serde(default)` keeps older / hand-edited payloads readable.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct ColumnMeta {
    name: String,
    data_type: String,
    nullable: bool,
    default_value: Option<String>,
    is_primary_key: bool,
    is_unique: bool,
    is_identity: bool,
    char_max_length: Option<i32>,
    numeric_precision: Option<i32>,
    numeric_scale: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct TableMeta {
    schema: String,
    name: String,
    columns: Vec<ColumnMeta>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct ForeignKeyMeta {
    name: String,
    schema: String,
    table: String,
    columns: Vec<String>,
    ref_schema: String,
    ref_table: String,
    ref_columns: Vec<String>,
    on_delete: Option<String>,
    on_update: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct ErDiagram {
    tables: Vec<TableMeta>,
    foreign_keys: Vec<ForeignKeyMeta>,
}

/// `PostgresDriver.introspectForER` — the same two pg_catalog queries, in the
/// same order, producing the same `ErDiagram`.
///
/// `attname` / `nspname` / `relname` are the `name` type; they are cast to
/// `text` so sqlx decodes them as `String` without relying on NAME↔TEXT
/// compatibility, and `array_agg(att.attname::text …)` so the aggregated column
/// lists arrive as a real `text[]` (v1 has to un-stringify these by hand — see
/// its `toStrArray` — because node-postgres hands back the `{a,b}` literal).
async fn introspect_for_er(c: &mut PgConnection, schema: Option<&str>) -> ApiResult<ErDiagram> {
    let cols = sqlx::query(
        r#"SELECT
              n.nspname::text AS schema,
              cls.relname::text AS "table",
              a.attname::text AS name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
              CASE
                WHEN a.atttypid IN (1042, 1043) AND a.atttypmod >= 0 THEN a.atttypmod - 4
              END AS char_max,
              information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS num_prec,
              information_schema._pg_numeric_scale(a.atttypid, a.atttypmod) AS num_scale,
              a.attidentity <> ''     AS is_identity,
              COALESCE(pk.is_pk, false)   AS is_pk,
              COALESCE(uq.is_unique, false) AS is_unique
             FROM pg_class cls
             JOIN pg_namespace n ON n.oid = cls.relnamespace
             JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        LEFT JOIN LATERAL (
               SELECT true AS is_pk
                 FROM pg_index i
                WHERE i.indrelid = cls.oid
                  AND i.indisprimary
                  AND a.attnum = ANY(i.indkey)
                LIMIT 1
             ) pk ON true
        LEFT JOIN LATERAL (
               SELECT true AS is_unique
                 FROM pg_index i
                WHERE i.indrelid = cls.oid
                  AND i.indisunique
                  AND NOT i.indisprimary
                  AND a.attnum = ANY(i.indkey)
                  AND array_length(i.indkey::int[], 1) = 1
                LIMIT 1
             ) uq ON true
            WHERE cls.relkind IN ('r','v','m','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND ($1::text IS NULL OR n.nspname = $1)
            ORDER BY n.nspname, cls.relname, a.attnum"#,
    )
    .bind(schema)
    .fetch_all(&mut *c)
    .await?;

    // Grouped in encounter order, so tables come out sorted by schema then name
    // exactly as v1's insertion-ordered Map does.
    let mut tables: Vec<TableMeta> = Vec::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for r in &cols {
        let schema_name = text(r, "schema");
        let table_name = text(r, "table");
        let key = format!("{schema_name}.{table_name}");
        let idx = match by_key.get(&key) {
            Some(&i) => i,
            None => {
                tables.push(TableMeta {
                    schema: schema_name,
                    name: table_name,
                    columns: Vec::new(),
                });
                by_key.insert(key, tables.len() - 1);
                tables.len() - 1
            }
        };
        tables[idx].columns.push(ColumnMeta {
            name: text(r, "name"),
            data_type: text(r, "data_type"),
            nullable: r.try_get("nullable").unwrap_or(false),
            default_value: opt_text(r, "default_value"),
            is_primary_key: r.try_get("is_pk").unwrap_or(false),
            is_unique: r.try_get("is_unique").unwrap_or(false),
            is_identity: r.try_get("is_identity").unwrap_or(false),
            char_max_length: r.try_get::<Option<i32>, _>("char_max").ok().flatten(),
            numeric_precision: r.try_get::<Option<i32>, _>("num_prec").ok().flatten(),
            numeric_scale: r.try_get::<Option<i32>, _>("num_scale").ok().flatten(),
        });
    }

    let fk_rows = sqlx::query(
        r#"SELECT
              con.conname::text AS name,
              n.nspname::text   AS schema,
              cls.relname::text AS "table",
              (
                SELECT array_agg(att.attname::text ORDER BY ord.pos)
                  FROM unnest(con.conkey) WITH ORDINALITY AS ord(col, pos)
                  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.col
              ) AS columns,
              rn.nspname::text  AS ref_schema,
              rcls.relname::text AS ref_table,
              (
                SELECT array_agg(att.attname::text ORDER BY ord.pos)
                  FROM unnest(con.confkey) WITH ORDINALITY AS ord(col, pos)
                  JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.col
              ) AS ref_columns,
              CASE con.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' END AS on_delete,
              CASE con.confupdtype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE'   WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' END AS on_update
             FROM pg_constraint con
             JOIN pg_class cls     ON cls.oid  = con.conrelid
             JOIN pg_namespace n   ON n.oid    = cls.relnamespace
             JOIN pg_class rcls    ON rcls.oid = con.confrelid
             JOIN pg_namespace rn  ON rn.oid   = rcls.relnamespace
            WHERE con.contype = 'f'
              AND n.nspname NOT IN ('pg_catalog','information_schema')
              AND ($1::text IS NULL OR n.nspname = $1)"#,
    )
    .bind(schema)
    .fetch_all(&mut *c)
    .await?;

    let foreign_keys = fk_rows
        .iter()
        .map(|r| ForeignKeyMeta {
            name: text(r, "name"),
            schema: text(r, "schema"),
            table: text(r, "table"),
            columns: r
                .try_get::<Option<Vec<String>>, _>("columns")
                .ok()
                .flatten()
                .unwrap_or_default(),
            ref_schema: text(r, "ref_schema"),
            ref_table: text(r, "ref_table"),
            ref_columns: r
                .try_get::<Option<Vec<String>>, _>("ref_columns")
                .ok()
                .flatten()
                .unwrap_or_default(),
            on_delete: opt_text(r, "on_delete"),
            on_update: opt_text(r, "on_update"),
        })
        .collect();

    Ok(ErDiagram { tables, foreign_keys })
}

// ---------------------------------------------------------------------------
// Hand-rolled stand-ins for the JS regexes (no `regex` crate in this build)
// ---------------------------------------------------------------------------

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Substring search with optional JS `\b` assertions. Every needle here starts
/// and ends with a word character, so a leading `\b` means "the previous char is
/// not a word char (or we're at the start)", and a trailing `\b` the mirror.
fn find_bounded(hay: &str, needle: &str, lead: bool, trail: bool) -> bool {
    let h: Vec<char> = hay.chars().collect();
    let n: Vec<char> = needle.chars().collect();
    if n.is_empty() || n.len() > h.len() {
        return false;
    }
    for i in 0..=(h.len() - n.len()) {
        if h[i..i + n.len()] != n[..] {
            continue;
        }
        if lead && i > 0 && is_word(h[i - 1]) {
            continue;
        }
        let j = i + n.len();
        if trail && j < h.len() && is_word(h[j]) {
            continue;
        }
        return true;
    }
    false
}

/// `/\bword\b/`
fn has_word(hay: &str, needle: &str) -> bool {
    find_bounded(hay, needle, true, true)
}

/// `/\bword/` — leading boundary only (v1 uses this for `bool`, `json`, `bytea`).
fn has_word_start(hay: &str, needle: &str) -> bool {
    find_bounded(hay, needle, true, false)
}

/// `/word\b/` — trailing boundary only (v1's `binary\b` alternative).
fn has_word_end(hay: &str, needle: &str) -> bool {
    find_bounded(hay, needle, false, true)
}

/// `/\b(a|b|c)\b/`
fn has_any_word(hay: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| has_word(hay, n))
}

fn eq_ci(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.eq_ignore_ascii_case(b)
}

fn starts_ci(hay: &str, prefix: &str) -> bool {
    hay.len() >= prefix.len() && hay[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `/^-?\d+(\.\d+)?$/`
fn is_numeric_literal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0usize;
    if i < b.len() && b[i] == b'-' {
        i += 1;
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return false;
    }
    if i < b.len() {
        if b[i] != b'.' {
            return false;
        }
        i += 1;
        let frac = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac {
            return false;
        }
    }
    i == b.len()
}

/// `/^'.*'::/i` — a quoted literal followed by a Postgres `::type` cast. JS `.`
/// never crosses a newline, so a newline before the closing quote kills the
/// match for every candidate position.
fn is_quoted_cast(def: &str) -> bool {
    let c: Vec<char> = def.chars().collect();
    if c.first() != Some(&'\'') {
        return false;
    }
    for i in 1..c.len() {
        if c[i] == '\n' {
            return false;
        }
        if c[i] == '\'' && i + 2 < c.len() && c[i + 1] == ':' && c[i + 2] == ':' {
            return true;
        }
    }
    false
}

/// `/^'.*'$/`
fn is_quoted_literal(def: &str) -> bool {
    let c: Vec<char> = def.chars().collect();
    c.len() >= 2
        && c[0] == '\''
        && c[c.len() - 1] == '\''
        && !c[1..c.len() - 1].iter().any(|&ch| ch == '\n')
}

/// `def.match(/^'((?:[^']|'')*)'/)` → capture group 1, reproducing the greedy
/// star *and* its backtracking (an unterminated `'a''` still matches `a`).
fn sql_string_literal(def: &str) -> Option<String> {
    let c: Vec<char> = def.chars().collect();
    if c.first() != Some(&'\'') {
        return None;
    }
    let mut i = 1usize;
    let mut stops = vec![1usize];
    while i < c.len() {
        if c[i] != '\'' {
            i += 1;
        } else if i + 1 < c.len() && c[i + 1] == '\'' {
            i += 2;
        } else {
            break;
        }
        stops.push(i);
    }
    for &p in stops.iter().rev() {
        if p < c.len() && c[p] == '\'' {
            return Some(c[1..p].iter().collect());
        }
    }
    None
}

/// JS `s.split(/[_\s-]+/).filter(Boolean)`.
fn split_words(s: &str) -> Vec<String> {
    s.split(|c: char| c == '_' || c == '-' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .collect()
}

fn lower_first(p: &str) -> String {
    let mut it = p.chars();
    match it.next() {
        Some(c) => c.to_lowercase().collect::<String>() + it.as_str(),
        None => String::new(),
    }
}

/// v1 `pascalCase` — note each part's tail is lowercased, so `userID` → `Userid`.
fn pascal_case(s: &str) -> String {
    split_words(s)
        .iter()
        .map(|p| {
            let mut it = p.chars();
            match it.next() {
                Some(c) => c.to_uppercase().collect::<String>() + &it.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect()
}

/// v1 `camelCase` — the FIRST part keeps its tail as-is; later parts are
/// lowercased after the initial cap.
fn camel_case(s: &str) -> String {
    split_words(s)
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if i == 0 {
                lower_first(p)
            } else {
                let mut it = p.chars();
                match it.next() {
                    Some(c) => c.to_uppercase().collect::<String>() + &it.as_str().to_lowercase(),
                    None => String::new(),
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// GET /api/connections/:id/migration-export
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ExportQ {
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    schema: Option<String>,
}

/// `MigrationExportController.export` — VIEWER. An unrecognised `target` is
/// normalized to `prisma` (v1: `target === 'drizzle' || target === 'sql' ?
/// target : 'prisma'`), so there is no "unknown target" 400 on this path.
async fn export(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<ExportQ>,
    req: Request,
) -> Result<Response, ApiError> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let dialect = match rust_dialect(&state, &id).await? {
        Some(d) => d,
        None => return Ok(crate::proxy(State(state), req).await),
    };
    let target = match q.target.as_deref() {
        Some("drizzle") => "drizzle",
        Some("sql") => "sql",
        _ => "prisma",
    };
    // v1: `schema || undefined` — "" means "all schemas".
    let schema = q.schema.filter(|s| !s.is_empty());

    let mut c = connect_target(&state, &id, &user.id).await?;
    let er = introspect_for_er(&mut c, schema.as_deref()).await?;

    let (filename, content) = match target {
        "drizzle" => ("schema.ts", render_drizzle(&er)),
        "sql" => ("schema.sql", render_sql(&er, &dialect)),
        _ => ("schema.prisma", render_prisma(&er, &dialect)),
    };
    Ok(Json(json!({
        "target": target,
        "filename": filename,
        "content": content,
    }))
    .into_response())
}

// ---------------------------------------------------------------------------
// Prisma renderer
// ---------------------------------------------------------------------------

fn prisma_scalar(col: &ColumnMeta) -> &'static str {
    let t = col.data_type.to_lowercase();
    if has_any_word(&t, &["bigint", "int8"]) {
        return "BigInt";
    }
    if has_any_word(
        &t,
        &["smallint", "int2", "int4", "integer", "int", "mediumint", "tinyint", "serial"],
    ) {
        return "Int";
    }
    if has_any_word(&t, &["numeric", "decimal"]) {
        return "Decimal";
    }
    if has_any_word(&t, &["real", "double", "float"]) {
        return "Float";
    }
    if has_word_start(&t, "bool") {
        return "Boolean";
    }
    if has_any_word(&t, &["timestamp", "datetime", "timestamptz"]) {
        return "DateTime";
    }
    if has_word(&t, "date") {
        return "DateTime";
    }
    if has_word(&t, "time") {
        return "DateTime";
    }
    if has_word_start(&t, "json") {
        return "Json";
    }
    if has_word(&t, "uuid") {
        return "String";
    }
    // `/\bbytea|blob|binary\b/` — the alternation binds looser than the
    // assertions, so only the first branch has a leading \b and only the last a
    // trailing one.
    if has_word_start(&t, "bytea") || t.contains("blob") || has_word_end(&t, "binary") {
        return "Bytes";
    }
    if has_any_word(&t, &["text", "varchar", "char", "citext"]) {
        return "String";
    }
    "String"
}

fn prisma_provider(dialect: &str) -> &'static str {
    match dialect {
        "MYSQL" => "mysql",
        "SQLITE" => "sqlite",
        "MSSQL" => "sqlserver",
        _ => "postgresql",
    }
}

fn fks_by_table(fks: &[ForeignKeyMeta]) -> HashMap<String, Vec<&ForeignKeyMeta>> {
    let mut map: HashMap<String, Vec<&ForeignKeyMeta>> = HashMap::new();
    for fk in fks {
        map.entry(format!("{}.{}", fk.schema, fk.table)).or_default().push(fk);
    }
    map
}

fn find_col<'a>(cols: &'a [ColumnMeta], name: &str) -> Option<&'a ColumnMeta> {
    cols.iter().find(|c| c.name == name)
}

fn render_prisma(er: &ErDiagram, dialect: &str) -> String {
    let fk_map = fks_by_table(&er.foreign_keys);
    let mut lines: Vec<String> = Vec::new();
    lines.push("// Generated by Query Schema — tune by hand as needed.".into());
    lines.push("// This is a snapshot of the current DB schema, not a diff.".into());
    lines.push(String::new());
    lines.push("generator client {".into());
    lines.push("  provider = \"prisma-client-js\"".into());
    lines.push("}".into());
    lines.push(String::new());
    lines.push("datasource db {".into());
    lines.push(format!("  provider = \"{}\"", prisma_provider(dialect)));
    lines.push("  url      = env(\"DATABASE_URL\")".into());
    lines.push("}".into());
    lines.push(String::new());

    // (refSchema.refTable) → the tables pointing at it, in FK order.
    let mut inbound: HashMap<String, Vec<&ForeignKeyMeta>> = HashMap::new();
    for fk in &er.foreign_keys {
        inbound
            .entry(format!("{}.{}", fk.ref_schema, fk.ref_table))
            .or_default()
            .push(fk);
    }

    for t in &er.tables {
        let model_name = pascal_case(&t.name);
        lines.push(format!("model {model_name} {{"));
        let pk_cols: Vec<&ColumnMeta> = t.columns.iter().filter(|c| c.is_primary_key).collect();
        let empty: Vec<&ForeignKeyMeta> = Vec::new();
        let table_fks = fk_map.get(&format!("{}.{}", t.schema, t.name)).unwrap_or(&empty);

        for c in &t.columns {
            let mut parts: Vec<String> = Vec::new();
            parts.push(format!("  {}", c.name));
            let scalar = prisma_scalar(c);
            let optional = if c.nullable { "?" } else { "" };
            parts.push(format!("{scalar}{optional}"));
            let mut modifiers: Vec<String> = Vec::new();
            if c.is_primary_key && pk_cols.len() == 1 {
                modifiers.push("@id".into());
            }
            if c.is_unique && !c.is_primary_key {
                modifiers.push("@unique".into());
            }
            if c.is_identity || has_word(&c.data_type.to_lowercase(), "serial") {
                modifiers.push("@default(autoincrement())".into());
            }
            // v1: `if (c.defaultValue && !c.isIdentity)` — a JS truthiness test,
            // so an empty-string default is skipped too.
            if let Some(raw) = c.default_value.as_deref().filter(|d| !d.is_empty()) {
                if !c.is_identity {
                    let def = raw.trim();
                    if eq_ci(def, "NULL") {
                        // skip
                    } else if starts_ci(def, "CURRENT_TIMESTAMP") || starts_ci(def, "now()") {
                        modifiers.push("@default(now())".into());
                    } else if eq_ci(def, "TRUE") || eq_ci(def, "FALSE") {
                        modifiers.push(format!("@default({})", def.to_lowercase()));
                    } else if is_numeric_literal(def) {
                        modifiers.push(format!("@default({def})"));
                    } else if is_quoted_cast(def) || is_quoted_literal(def) {
                        if let Some(inner) = sql_string_literal(def) {
                            modifiers.push(format!("@default(\"{}\")", inner.replace('"', "\\\"")));
                        }
                    }
                }
            }
            if !modifiers.is_empty() {
                parts.push(modifiers.join(" "));
            }
            lines.push(parts.join(" "));
        }

        if pk_cols.len() > 1 {
            let names: Vec<String> = pk_cols.iter().map(|c| c.name.clone()).collect();
            lines.push(format!("  @@id([{}])", names.join(", ")));
        }

        for fk in table_fks {
            let ref_model = pascal_case(&fk.ref_table);
            let field_name = camel_case(&fk.ref_table);
            // Naive — if the relation field name collides with a scalar, skip.
            if t.columns.iter().any(|c| c.name == field_name) {
                continue;
            }
            let opt = if fk
                .columns
                .iter()
                .any(|col| find_col(&t.columns, col).map(|c| c.nullable).unwrap_or(false))
            {
                "?"
            } else {
                ""
            };
            lines.push(format!(
                "  {field_name} {ref_model}{opt} @relation(fields: [{}], references: [{}])",
                fk.columns.join(", "),
                fk.ref_columns.join(", "),
            ));
        }

        if let Some(incoming) = inbound.get(&format!("{}.{}", t.schema, t.name)) {
            for inc in incoming {
                let field_name = format!("{}s", camel_case(&inc.table));
                if t.columns.iter().any(|c| c.name == field_name) {
                    continue;
                }
                lines.push(format!("  {field_name} {}[]", pascal_case(&inc.table)));
            }
        }

        if t.name != model_name {
            lines.push(format!("  @@map(\"{}\")", t.name));
        }

        lines.push("}".into());
        lines.push(String::new());
    }

    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Drizzle renderer (Postgres — the only dialect this module serves natively)
// ---------------------------------------------------------------------------

const DRIZZLE_PG_TYPES: &str =
    "text, integer, boolean, timestamp, decimal, doublePrecision, bigint, uuid, json, jsonb";

fn drizzle_type(col: &ColumnMeta) -> String {
    let t = col.data_type.to_lowercase();
    let c = format!("\"{}\"", col.name);
    if has_word(&t, "uuid") {
        return format!("uuid({c})");
    }
    if has_any_word(&t, &["bigint", "int8"]) {
        return format!("bigint({c}, {{ mode: 'number' }})");
    }
    if has_any_word(&t, &["smallint", "int2", "int4", "integer", "int", "serial"]) {
        return format!("integer({c})");
    }
    if has_word(&t, "jsonb") {
        return format!("jsonb({c})");
    }
    if has_word(&t, "json") {
        return format!("json({c})");
    }
    if has_any_word(&t, &["numeric", "decimal"]) {
        return format!("decimal({c})");
    }
    if has_any_word(&t, &["real", "double", "float"]) {
        return format!("doublePrecision({c})");
    }
    if has_word_start(&t, "bool") {
        return format!("boolean({c})");
    }
    if has_word(&t, "timestamptz") {
        return format!("timestamp({c}, {{ withTimezone: true }})");
    }
    if has_word(&t, "timestamp") {
        return format!("timestamp({c})");
    }
    if has_any_word(&t, &["text", "varchar", "char", "citext"]) {
        return format!("text({c})");
    }
    format!("text({c})")
}

fn render_drizzle(er: &ErDiagram) -> String {
    let fk_map = fks_by_table(&er.foreign_keys);
    let mut lines: Vec<String> = Vec::new();
    lines.push("// Generated by Query Schema — snapshot of current DB schema.".into());
    lines.push(format!(
        "import {{ pgTable, {DRIZZLE_PG_TYPES} }} from 'drizzle-orm/pg-core';"
    ));
    lines.push(String::new());

    for t in &er.tables {
        let model_name = camel_case(&t.name);
        lines.push(format!("export const {model_name} = pgTable('{}', {{", t.name));
        for c in &t.columns {
            let mut line = format!("  {}: {}", camel_case(&c.name), drizzle_type(c));
            let mut mods: Vec<&str> = Vec::new();
            if c.is_primary_key {
                mods.push(".primaryKey()");
            }
            if !c.nullable && !c.is_primary_key {
                mods.push(".notNull()");
            }
            if c.is_unique && !c.is_primary_key {
                mods.push(".unique()");
            }
            line.push_str(&mods.join(""));
            line.push(',');
            lines.push(line);
        }
        let empty: Vec<&ForeignKeyMeta> = Vec::new();
        for fk in fk_map.get(&format!("{}.{}", t.schema, t.name)).unwrap_or(&empty) {
            let ref_model = camel_case(&fk.ref_table);
            lines.push(format!(
                "  // FK: {} -> {}({}) — wire with relations() for {ref_model}",
                fk.columns.join(", "),
                fk.ref_table,
                fk.ref_columns.join(", "),
            ));
        }
        lines.push("});".into());
        lines.push(String::new());
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Raw SQL renderer
// ---------------------------------------------------------------------------

/// v1 `quoteIdent` for Postgres/SQLite — double the double quotes. This is what
/// keeps a schema/table/column name from breaking out of the generated DDL; note
/// it also runs over the *snapshot's* stored names on the diff path.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(name))
}

fn render_sql(er: &ErDiagram, dialect: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push("-- Schema snapshot generated by Query Schema.".into());
    lines.push(format!("-- Dialect: {dialect}"));
    lines.push(String::new());

    for t in &er.tables {
        lines.push(format!("CREATE TABLE {} (", qualified(&t.schema, &t.name)));
        let mut col_lines: Vec<String> = t
            .columns
            .iter()
            .map(|c| {
                // v1 keeps the driver's own type string — it already reflects the
                // source DB's native grammar.
                let mut parts = vec![format!("  {} {}", quote_ident(&c.name), c.data_type.trim())];
                if !c.nullable {
                    parts.push("NOT NULL".into());
                }
                if let Some(d) = c.default_value.as_deref() {
                    parts.push(format!("DEFAULT {d}"));
                }
                parts.join(" ")
            })
            .collect();
        let pks: Vec<String> = t
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| quote_ident(&c.name))
            .collect();
        if !pks.is_empty() {
            col_lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
        }
        lines.push(col_lines.join(",\n"));
        lines.push(");".into());
        lines.push(String::new());
    }

    for fk in &er.foreign_keys {
        lines.push(format!(
            "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}){}{};",
            qualified(&fk.schema, &fk.table),
            quote_ident(&fk.name),
            fk.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", "),
            qualified(&fk.ref_schema, &fk.ref_table),
            fk.ref_columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", "),
            fk.on_delete.as_deref().map(|d| format!(" ON DELETE {d}")).unwrap_or_default(),
            fk.on_update.as_deref().map(|d| format!(" ON UPDATE {d}")).unwrap_or_default(),
        ));
    }

    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Snapshots — app-DB CRUD over "SchemaSnapshot"
// ---------------------------------------------------------------------------

/// `SnapshotService.list` — newest first, 50 max, with the creating user.
/// The `"id"` tiebreaker is this repo's convention for stable ordering when the
/// sort column can collide (two snapshots taken in the same millisecond).
async fn snapshots_list(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(
        r#"SELECT s."id", s."name", s."dbSchema", s."createdAt",
                  u."email" AS "cbEmail", u."displayName" AS "cbDisplayName"
             FROM "SchemaSnapshot" s
             LEFT JOIN "User" u ON u."id" = s."createdById"
            WHERE s."connectionId" = $1
            ORDER BY s."createdAt" DESC, s."id" ASC
            LIMIT 50"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|r| {
                // Prisma renders the relation as null when `createdById` is null
                // (or the user was deleted — the FK is `onDelete: SetNull`).
                let created_by = match opt_text(r, "cbEmail") {
                    Some(email) => json!({
                        "email": email,
                        "displayName": opt_text(r, "cbDisplayName"),
                    }),
                    None => Value::Null,
                };
                json!({
                    "id": text(r, "id"),
                    "name": text(r, "name"),
                    "dbSchema": opt_text(r, "dbSchema"),
                    "createdAt": ts(r, "createdAt"),
                    "createdBy": created_by,
                })
            })
            .collect(),
    )))
}

#[derive(Deserialize)]
struct CreateSnapshotDto {
    #[serde(default)]
    name: Option<Value>,
    #[serde(default)]
    schema: Option<Value>,
}

/// `POST /snapshots` — 201, EDITOR. Captures the live ER state and stores it as
/// JSON so the diff endpoint can replay it later.
async fn snapshot_create(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    require_role(&state.pool, &id, &user.id, "EDITOR").await?;
    if rust_dialect(&state, &id).await?.is_none() {
        return Ok(crate::proxy(State(state), req).await);
    }
    let bytes = to_bytes(req.into_body(), 1_048_576)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "request entity too large"))?;
    let raw: Value = serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::bad(format!("Unexpected token in JSON: {e}")))?;
    // v1's global ValidationPipe runs with `forbidNonWhitelisted: true`, so an
    // unexpected property is a 400 rather than a silently ignored field.
    if let Some(obj) = raw.as_object() {
        if let Some(k) = obj.keys().find(|k| k.as_str() != "name" && k.as_str() != "schema") {
            return Err(ApiError::bad(format!("property {k} should not exist")));
        }
    }
    let dto: CreateSnapshotDto =
        serde_json::from_value(raw).map_err(|e| ApiError::bad(e.to_string()))?;

    let name = match dto.name.as_ref() {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(ApiError::bad("name must be a string")),
    };
    if name.chars().count() < 1 || name.chars().count() > 200 {
        return Err(ApiError::bad(
            "name must be longer than or equal to 1 and shorter than or equal to 200 characters",
        ));
    }
    let schema = match dto.schema.as_ref() {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            if s.chars().count() > 100 {
                return Err(ApiError::bad(
                    "schema must be longer than or equal to 0 and shorter than or equal to 100 characters",
                ));
            }
            Some(s.clone())
        }
        _ => return Err(ApiError::bad("schema must be a string")),
    };
    if name.trim().is_empty() {
        return Err(ApiError::bad("Snapshot name is required"));
    }

    let mut c = connect_target(&state, &id, &user.id).await?;
    let er = introspect_for_er(&mut c, schema.as_deref()).await?;
    let payload =
        serde_json::to_value(&er).map_err(|e| ApiError::internal(format!("payload encode failed: {e}")))?;

    let r = sqlx::query(
        r#"INSERT INTO "SchemaSnapshot"
             ("id","connectionId","name","dbSchema","payload","createdById","createdAt")
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,now())
           RETURNING "id","name","createdAt""#,
    )
    // Prisma generates `@default(cuid())` client-side, so Postgres has no
    // default for "id" — every INSERT must supply one.
    .bind(gen_id())
    .bind(&id)
    .bind(name.trim().chars().take(200).collect::<String>())
    .bind(&schema)
    .bind(&payload)
    .bind(&user.id)
    .fetch_one(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": text(&r, "id"),
            "name": text(&r, "name"),
            "createdAt": ts(&r, "createdAt"),
        })),
    )
        .into_response())
}

/// `DELETE /snapshots/:snapshotId` — VIEWER (v1's RbacGuard default). The
/// `connectionId` predicate is what stops a snapshot id from another connection
/// being deleted through a connection you happen to have access to; v1 does the
/// same check by reading the row first.
async fn snapshot_delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, snapshot_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let res = sqlx::query(r#"DELETE FROM "SchemaSnapshot" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&snapshot_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Snapshot not found"));
    }
    Ok(Json(json!({ "ok": true })))
}

/// `GET /snapshots/:snapshotId/diff` — VIEWER. ALTER statements that take the
/// snapshot's schema to the current live one.
async fn snapshot_diff(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, snapshot_id)): Path<(String, String)>,
    req: Request,
) -> Result<Response, ApiError> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let dialect = match rust_dialect(&state, &id).await? {
        Some(d) => d,
        None => return Ok(crate::proxy(State(state), req).await),
    };
    // SECURITY: `connectionId` in the WHERE — a snapshot id from someone else's
    // connection must not resolve just because you can read this one.
    let snap = sqlx::query(
        r#"SELECT "id","dbSchema","payload" FROM "SchemaSnapshot"
            WHERE "id" = $1 AND "connectionId" = $2"#,
    )
    .bind(&snapshot_id)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Snapshot not found"))?;

    let db_schema = opt_text(&snap, "dbSchema");
    let payload: Value = snap
        .try_get("payload")
        .map_err(|e| ApiError::internal(format!("payload decode failed: {e}")))?;
    let before: ErDiagram = serde_json::from_value(payload)
        .map_err(|e| ApiError::bad(format!("Snapshot payload is not an ER diagram: {e}")))?;

    let mut c = connect_target(&state, &id, &user.id).await?;
    let after = introspect_for_er(&mut c, db_schema.as_deref()).await?;

    Ok(Json(render_diff(&before, &after, &dialect, &text(&snap, "id"))).into_response())
}

// ---------------------------------------------------------------------------
// Diff engine — a direct port of snapshot.service.ts `renderDiff`
// ---------------------------------------------------------------------------

/// Insertion-ordered map, because the generated SQL's statement order is the
/// iteration order of v1's `Map`s and people diff these scripts.
struct OrderedMap<V> {
    keys: Vec<String>,
    idx: HashMap<String, usize>,
    vals: Vec<V>,
}

impl<V> OrderedMap<V> {
    fn new() -> Self {
        Self { keys: Vec::new(), idx: HashMap::new(), vals: Vec::new() }
    }
    fn insert(&mut self, k: String, v: V) {
        match self.idx.get(&k) {
            Some(&i) => self.vals[i] = v,
            None => {
                self.idx.insert(k.clone(), self.keys.len());
                self.keys.push(k);
                self.vals.push(v);
            }
        }
    }
    fn get(&self, k: &str) -> Option<&V> {
        self.idx.get(k).map(|&i| &self.vals[i])
    }
    fn contains_key(&self, k: &str) -> bool {
        self.idx.contains_key(k)
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.keys.iter().zip(self.vals.iter())
    }
}

enum ColChange {
    Type(String),
    Nullable(bool),
    Default(Option<String>),
}

impl ColChange {
    fn kind(&self) -> &'static str {
        match self {
            ColChange::Type(_) => "type",
            ColChange::Nullable(_) => "nullable",
            ColChange::Default(_) => "default",
        }
    }
}

fn diff_column(before: &ColumnMeta, after: &ColumnMeta) -> Vec<ColChange> {
    let mut out = Vec::new();
    if before.data_type.trim() != after.data_type.trim() {
        out.push(ColChange::Type(after.data_type.clone()));
    }
    if before.nullable != after.nullable {
        out.push(ColChange::Nullable(after.nullable));
    }
    if before.default_value != after.default_value {
        out.push(ColChange::Default(after.default_value.clone()));
    }
    out
}

/// Postgres/SQLite branch of v1's `renderColumnChange`. MySQL's `MODIFY COLUMN`
/// and the MSSQL "review manually" comments are unreachable here: non-Postgres
/// connections never get this far (see `rust_dialect`).
fn render_column_change(schema: &str, table: &str, col: &str, chg: &ColChange) -> String {
    let t = qualified(schema, table);
    let c = quote_ident(col);
    match chg {
        ColChange::Type(v) => format!("ALTER TABLE {t} ALTER COLUMN {c} TYPE {v};"),
        ColChange::Nullable(true) => format!("ALTER TABLE {t} ALTER COLUMN {c} DROP NOT NULL;"),
        ColChange::Nullable(false) => format!("ALTER TABLE {t} ALTER COLUMN {c} SET NOT NULL;"),
        ColChange::Default(None) => format!("ALTER TABLE {t} ALTER COLUMN {c} DROP DEFAULT;"),
        ColChange::Default(Some(v)) => {
            format!("ALTER TABLE {t} ALTER COLUMN {c} SET DEFAULT {v};")
        }
    }
}

/// v1 `renderColumnDef` — note this one treats an empty-string default as "no
/// default", unlike `renderSql`'s CREATE TABLE path.
fn render_column_def(col: &ColumnMeta) -> String {
    let mut parts = vec![col.data_type.clone()];
    if !col.nullable {
        parts.push("NOT NULL".into());
    }
    if let Some(d) = col.default_value.as_deref().filter(|d| !d.is_empty()) {
        parts.push(format!("DEFAULT {d}"));
    }
    parts.join(" ")
}

fn render_create_table(t: &TableMeta) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("CREATE TABLE {} (", qualified(&t.schema, &t.name)));
    let mut col_lines: Vec<String> = t
        .columns
        .iter()
        .map(|c| format!("  {} {}", quote_ident(&c.name), render_column_def(c)))
        .collect();
    let pks: Vec<String> = t
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| quote_ident(&c.name))
        .collect();
    if !pks.is_empty() {
        col_lines.push(format!("  PRIMARY KEY ({})", pks.join(", ")));
    }
    lines.push(col_lines.join(",\n"));
    lines.push(");".into());
    lines.join("\n")
}

fn render_fk(fk: &ForeignKeyMeta) -> String {
    format!(
        "ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}){}{};",
        qualified(&fk.schema, &fk.table),
        quote_ident(&fk.name),
        fk.columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", "),
        qualified(&fk.ref_schema, &fk.ref_table),
        fk.ref_columns.iter().map(|c| quote_ident(c)).collect::<Vec<_>>().join(", "),
        fk.on_delete.as_deref().map(|d| format!(" ON DELETE {d}")).unwrap_or_default(),
        fk.on_update.as_deref().map(|d| format!(" ON UPDATE {d}")).unwrap_or_default(),
    )
}

fn render_diff(before: &ErDiagram, after: &ErDiagram, dialect: &str, from_snapshot_id: &str) -> Value {
    let mut before_tables: OrderedMap<&TableMeta> = OrderedMap::new();
    for t in &before.tables {
        before_tables.insert(format!("{}.{}", t.schema, t.name), t);
    }
    let mut after_tables: OrderedMap<&TableMeta> = OrderedMap::new();
    for t in &after.tables {
        after_tables.insert(format!("{}.{}", t.schema, t.name), t);
    }
    let mut before_fks: OrderedMap<&ForeignKeyMeta> = OrderedMap::new();
    for fk in &before.foreign_keys {
        before_fks.insert(format!("{}.{}.{}", fk.schema, fk.table, fk.name), fk);
    }
    let mut after_fks: OrderedMap<&ForeignKeyMeta> = OrderedMap::new();
    for fk in &after.foreign_keys {
        after_fks.insert(format!("{}.{}.{}", fk.schema, fk.table, fk.name), fk);
    }

    let mut sql: Vec<String> = Vec::new();
    let mut added_tables: Vec<String> = Vec::new();
    let mut dropped_tables: Vec<String> = Vec::new();
    let mut added_columns: Vec<String> = Vec::new();
    let mut dropped_columns: Vec<String> = Vec::new();
    let mut changed_columns: Vec<String> = Vec::new();
    let mut added_fks: Vec<String> = Vec::new();
    let mut dropped_fks: Vec<String> = Vec::new();

    // 1) Drop FKs that no longer exist (before we touch the referenced tables).
    for (k, fk) in before_fks.iter() {
        if !after_fks.contains_key(k) {
            dropped_fks.push(k.clone());
            sql.push(format!(
                "ALTER TABLE {} DROP CONSTRAINT {};",
                qualified(&fk.schema, &fk.table),
                quote_ident(&fk.name)
            ));
        }
    }

    // 2) Drop tables that disappeared.
    for (k, t) in before_tables.iter() {
        if !after_tables.contains_key(k) {
            dropped_tables.push(k.clone());
            sql.push(format!("DROP TABLE {};", qualified(&t.schema, &t.name)));
        }
    }

    // 3) Create tables that appeared.
    for (k, t) in after_tables.iter() {
        if !before_tables.contains_key(k) {
            added_tables.push(k.clone());
            sql.push(render_create_table(t));
        }
    }

    // 4) For tables present in both, diff columns.
    for (k, before_t) in before_tables.iter() {
        let after_t = match after_tables.get(k) {
            Some(t) => *t,
            None => continue,
        };
        for c in &before_t.columns {
            if find_col(&after_t.columns, &c.name).is_none() {
                dropped_columns.push(format!("{k}.{}", c.name));
                sql.push(format!(
                    "ALTER TABLE {} DROP COLUMN {};",
                    qualified(&before_t.schema, &before_t.name),
                    quote_ident(&c.name)
                ));
            }
        }
        for c in &after_t.columns {
            if find_col(&before_t.columns, &c.name).is_none() {
                added_columns.push(format!("{k}.{}", c.name));
                sql.push(format!(
                    "ALTER TABLE {} ADD COLUMN {} {};",
                    qualified(&after_t.schema, &after_t.name),
                    quote_ident(&c.name),
                    render_column_def(c)
                ));
            }
        }
        for before_col in &before_t.columns {
            let after_col = match find_col(&after_t.columns, &before_col.name) {
                Some(c) => c,
                None => continue,
            };
            let changes = diff_column(before_col, after_col);
            if changes.is_empty() {
                continue;
            }
            let kinds: Vec<&str> = changes.iter().map(|c| c.kind()).collect();
            changed_columns.push(format!("{k}.{}: {}", before_col.name, kinds.join(", ")));
            for chg in &changes {
                sql.push(render_column_change(
                    &after_t.schema,
                    &after_t.name,
                    &before_col.name,
                    chg,
                ));
            }
        }
    }

    // 5) Add FKs that are new (AFTER the tables/columns they reference exist).
    for (k, fk) in after_fks.iter() {
        if !before_fks.contains_key(k) {
            added_fks.push(k.clone());
            sql.push(render_fk(fk));
        }
    }

    let header = [
        "-- Diff generated by Query Schema".to_string(),
        format!("-- From snapshot: {from_snapshot_id}"),
        format!("-- Dialect: {dialect}"),
        "-- Review each statement before running; some changes (DROP COLUMN, type changes)".to_string(),
        "-- are not reversible once applied.".to_string(),
        String::new(),
    ]
    .join("\n");

    let body = if sql.is_empty() {
        format!("{header}-- No differences detected.")
    } else {
        format!("{header}{}", sql.join("\n"))
    };

    json!({
        "fromSnapshotId": from_snapshot_id,
        "dialect": dialect,
        "sql": body,
        "summary": {
            "addedTables": added_tables,
            "droppedTables": dropped_tables,
            "addedColumns": added_columns,
            "droppedColumns": dropped_columns,
            "changedColumns": changed_columns,
            "addedFks": added_fks,
            "droppedFks": dropped_fks,
        },
    })
}
