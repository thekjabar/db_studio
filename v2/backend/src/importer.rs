//! CSV import + server-side query cursors â€” Rust port of the v1 NestJS
//! `src/csv-import/` module and the cursor endpoints of `src/query/`
//! (`query.controller.ts` + `cursor.service.ts`), wire-compatible with them:
//! same paths, methods, status codes, error messages and JSON field names.
//!
//! v1 sources of truth:
//!   backend/src/csv-import/csv-import.controller.ts   (routes, roles, DTO shape)
//!   backend/src/csv-import/csv-import.service.ts      (sessions, coercion, commit)
//!   backend/src/query/cursor.service.ts               (DECLARE/FETCH, reaper, cap)
//!   backend/src/query/query.controller.ts             (cursor routes, roles)
//!   backend/src/drivers/postgres.driver.ts            (`getTableColumns`, `insertRow`)
//!   backend/src/drivers/quote.util.ts                 (`quotePg`, ident shape)
//!
//! â”€â”€ Why this module owns process-local state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//! Neither feature has a database model: v1 keeps parsed CSV uploads in a
//! `Map<sessionId, Session>` on the `CsvImportService` singleton, and open
//! cursors in a `Map<cursorId, CursorSession>` on `CursorService` â€” each holding
//! a live `pg.Client` with an open `READ ONLY` transaction. v2 is a single pod,
//! so the same shape works here: two `LazyLock`-style statics below
//! (`OnceLock<Mutex<HashMap<..>>>`) hold them, which is why `AppState` did not
//! have to change.
//!
//! CONSEQUENCE (single-pod assumption): a CSV upload served by this process must
//! be dry-run/committed by this process, and a cursor opened here must be
//! fetched/closed here. That holds because every route below routes on the
//! *connection*, not on the session: a connection v2 can serve is served by v2
//! for all four/three calls, and a connection it cannot serve (agent tunnel,
//! non-Postgres, SSH-tunnelled, unreadable credentials) is forwarded to v1 for
//! all of them, so the session lives entirely in one process either way. A v2
//! restart drops both maps â€” exactly as a v1 restart does.
//!
//! â”€â”€ Safety notes (csv-import WRITES to the customer database) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//!   * schema / table / target column names are checked against v1's two ident
//!     regexes â€” the DTO's `^[A-Za-z_][A-Za-z0-9_]{0,63}$` and, before any
//!     interpolation, `quotePg`'s stricter `^[A-Za-z_][A-Za-z0-9_]{0,62}$` â€”
//!     and quoted, never concatenated raw.
//!   * cell values are NEVER interpolated. Every coerced cell is bound as a text
//!     parameter carrying exactly the bytes node-postgres would put on the wire
//!     (JS `String(value)`), and read back as `CAST($n AS <type>)` where `<type>`
//!     is `format_type(atttypid, NULL)` from the catalog â€” the type WITHOUT its
//!     modifier, on purpose. That is precisely what v1 gets: node-postgres sends
//!     parameters with an unspecified type OID, Postgres infers the column's
//!     base type, converts with its input function, and the INSERT's own
//!     assignment coercion then applies the modifier â€” so `varchar(50)` still
//!     raises "value too long" instead of silently truncating, and `numeric(10,2)`
//!     still rounds the way it does in v1.
//!   * `readOnly` connections still get `SET SESSION CHARACTERISTICS AS
//!     TRANSACTION READ ONLY`, as v1's driver does per checkout, so the inserts
//!     are refused by Postgres exactly as they are in v1.
//!   * caps are v1's: 500k rows per upload, 100 dry-run errors, 1000 commit
//!     failures, `stopOnError`, and one autocommitted INSERT per row (no
//!     wrapping transaction â€” a partial import stays partial, as in v1).
//!
//! Prisma has no `@map`, so every app-DB identifier below is the quoted
//! PascalCase/camelCase name Prisma created (`"ColumnMask"."connectionId"`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::{DefaultBodyLimit, FromRequest, Multipart, Path, Request, State};
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{Column, Connection, Executor, PgConnection, PgPool, Row};

use crate::{conn_role, connect_target, ApiError, ApiResult, AppState, AuthUser};

/// Every ported route at its full v1 path (Nest sets a global `api` prefix, so
/// `@Controller('connections/:id/csv-import')` serves
/// `/api/connections/:id/csv-import`). The `:id` capture name must match the one
/// main.rs already uses for `/api/connections/:id/...` or axum's router panics.
pub fn routes() -> Router<AppState> {
    Router::new()
        // --- csv-import (JwtAuthGuard + RbacGuard on the whole controller) ---
        .route(
            "/api/connections/:id/csv-import/upload",
            // v1: FileInterceptor('file', { limits: { fileSize: 50MB } }). axum's
            // default body limit is 2 MB, which would reject almost every real
            // import, so it is raised to the same 50 MB for this route only.
            post(csv_upload).layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES)),
        )
        .route(
            "/api/connections/:id/csv-import/:sessionId",
            get(csv_get).delete(csv_discard),
        )
        .route(
            "/api/connections/:id/csv-import/:sessionId/dry-run",
            post(csv_dry_run),
        )
        .route(
            "/api/connections/:id/csv-import/:sessionId/commit",
            post(csv_commit),
        )
        // --- server-side cursor streaming (QueryController, all VIEWER, 200) ---
        .route("/api/connections/:id/query/cursor", post(cursor_open))
        .route(
            "/api/connections/:id/query/cursor/:cursorId/fetch",
            post(cursor_fetch),
        )
        .route(
            "/api/connections/:id/query/cursor/:cursorId/close",
            post(cursor_close),
        )
}

// ---------------------------------------------------------------------------
// Constants â€” copied verbatim from the v1 services.
// ---------------------------------------------------------------------------

/// csv-import.service.ts
const SESSION_TTL_MS: i64 = 15 * 60_000;
const MAX_PARSED_ROWS: usize = 500_000;
const SAMPLE_SIZE: usize = 20;
/// csv-import.controller.ts (`FileInterceptor` limits).
const MAX_UPLOAD_BYTES: usize = 50 * 1024 * 1024;
/// Reporting caps in `dryRun` / `commit`.
const MAX_DRY_RUN_ERRORS: usize = 100;
const MAX_COMMIT_FAILURES: usize = 1000;

/// cursor.service.ts
const IDLE_MS: i64 = 2 * 60 * 1000;
const MAX_LIFETIME_MS: i64 = 10 * 60 * 1000;
const MAX_OPEN_CURSORS: usize = 50;
const MAX_PAGE: i64 = 5_000;
const SWEEP_MS: u64 = 30 * 1000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------------------------------------------------------------------------
// Shared helpers: RBAC, connection metadata, proxy decision, error shapes
// ---------------------------------------------------------------------------

/// class-validator's 400 envelope (`message` is an array of failures).
fn validation_error(msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: msg.to_string(),
        body: Some(json!({
            "message": [msg],
            "error": "Bad Request",
            "statusCode": 400,
        })),
    }
}

fn role_rank(role: &str) -> i32 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        _ => 1,
    }
}

/// `RbacService.require` â€” same not-found / no-access split and message text.
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
                Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "No access to this connection",
                ))
            }
        }
    }
}

/// The bits of `Connection` these routes need.
struct ConnMeta {
    dialect: String,
    read_only: bool,
    statement_timeout_ms: i32,
    via_agent: bool,
    /// True when the stored credentials carry an `ssh` tunnel config, or when
    /// they could not be decrypted at all. Both mean this process must not open
    /// a direct socket to `creds.host`: with a tunnel it is not the database the
    /// user configured, and an unreadable blob means we cannot know what it is.
    ssh_or_unreadable: bool,
}

async fn load_conn_meta(state: &AppState, id: &str) -> ApiResult<Option<ConnMeta>> {
    let row = sqlx::query(
        r#"SELECT "dialect"::text AS dialect, "readOnly", "statementTimeoutMs", "viaAgent",
                  "credentialsCt"
             FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(r) = row else { return Ok(None) };

    let ssh_or_unreadable = match state.crypto.as_ref() {
        // No key at all â†’ `must_proxy` is already true via `crypto.is_none()`.
        None => false,
        Some(crypto) => {
            let ct: String = r
                .try_get("credentialsCt")
                .map_err(|e| ApiError::internal(e.to_string()))?;
            match crypto.decrypt(&ct, &crate::crypto::Crypto::conn_purpose(id)) {
                Err(_) => true,
                Ok(json_text) => match serde_json::from_str::<Value>(&json_text) {
                    Err(_) => true,
                    Ok(v) => !v.get("ssh").unwrap_or(&Value::Null).is_null(),
                },
            }
        }
    };

    Ok(Some(ConnMeta {
        dialect: r
            .try_get::<String, _>("dialect")
            .map_err(|e| ApiError::internal(e.to_string()))?,
        read_only: r
            .try_get::<bool, _>("readOnly")
            .map_err(|e| ApiError::internal(e.to_string()))?,
        statement_timeout_ms: r.try_get::<i32, _>("statementTimeoutMs").unwrap_or(30_000),
        via_agent: r.try_get::<bool, _>("viaAgent").unwrap_or(false),
        ssh_or_unreadable,
    }))
}

impl ConnMeta {
    /// Anything v2 cannot execute faithfully goes to the v1 Node API instead of
    /// failing or â€” much worse for an importer â€” writing to the wrong place: the
    /// agent tunnel, the SSH tunnel and the non-Postgres drivers live only
    /// there, and without ENCRYPTION_KEY no target database is reachable at all.
    fn must_proxy(&self, state: &AppState) -> bool {
        self.via_agent
            || self.ssh_or_unreadable
            || !self.dialect.to_lowercase().contains("postgres")
            || state.crypto.is_none()
    }
}

/// Split a request so the body can be inspected here and still be replayed to
/// v1 verbatim when the connection turns out to be one v2 cannot serve.
async fn split_body(req: Request) -> ApiResult<(Parts, bytes::Bytes)> {
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, MAX_UPLOAD_BYTES)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))?;
    Ok((parts, bytes))
}

fn rebuild(parts: Parts, bytes: bytes::Bytes) -> Request {
    Request::from_parts(parts, Body::from(bytes))
}

/// `ColumnMasksService.maskedColumnNames` â€” every column name masked for this
/// user anywhere on this connection. Errors propagate: a failed lookup must
/// never be read as "no masks".
async fn masked_columns(pool: &PgPool, connection_id: &str, user_id: &str) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar::<_, String>(
        r#"SELECT DISTINCT "columnName" FROM "ColumnMask"
            WHERE "connectionId" = $1 AND "userId" = $2"#,
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?)
}

/// `ColumnMasksService.applyMasks` â€” null out masked keys in place.
fn mask_row(row: &mut Value, masked: &[String]) {
    if let Some(obj) = row.as_object_mut() {
        for col in masked {
            if obj.contains_key(col.as_str()) {
                obj.insert(col.clone(), Value::Null);
            }
        }
    }
}

/// JS `String.prototype.trim` â€” like Rust's `trim` but U+FEFF is whitespace too.
fn is_js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `String.prototype.slice(0, n)` on a code-point basis.
fn slice_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `/\b<word>/` (and `/\b<word>\b/` when `trailing`) against an already
/// lowercased haystack â€” JS `\b` is ASCII-only, which `is_word_char` mirrors.
fn re_word(hay: &str, word: &str, trailing: bool) -> bool {
    let mut from = 0usize;
    while let Some(rel) = hay[from..].find(word) {
        let start = from + rel;
        let end = start + word.len();
        let before_ok = hay[..start].chars().next_back().map(|c| !is_word_char(c)).unwrap_or(true);
        let after_ok = !trailing || hay[end..].chars().next().map(|c| !is_word_char(c)).unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
        if from >= hay.len() {
            break;
        }
    }
    false
}

fn re_any_word(hay: &str, words: &[&str], trailing: bool) -> bool {
    words.iter().any(|w| re_word(hay, w, trailing))
}

// ---------------------------------------------------------------------------
// Identifiers â€” v1 has TWO regexes and both must fire (the DTO's is looser).
// ---------------------------------------------------------------------------

/// csv-import.controller.ts `IDENT_RE` â€” `^[A-Za-z_][A-Za-z0-9_]{0,63}$`.
fn dto_ident_ok(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    let rest: Vec<char> = it.collect();
    rest.len() <= 63 && rest.iter().all(|c| is_word_char(*c))
}

/// quote.util.ts `assertIdentShape` + `quotePg` â€”
/// `^[A-Za-z_][A-Za-z0-9_]{0,62}$`, then `"` doubling.
fn quote_pg(ident: &str) -> Result<String, String> {
    let mut it = ident.chars();
    let head_ok = matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_');
    let rest: Vec<char> = it.collect();
    if !head_ok || rest.len() > 62 || !rest.iter().all(|c| is_word_char(*c)) {
        // v1: `Invalid identifier: ${JSON.stringify(s)}`
        let quoted = serde_json::to_string(ident).unwrap_or_else(|_| format!("\"{ident}\""));
        return Err(format!("Invalid identifier: {quoted}"));
    }
    Ok(format!("\"{}\"", ident.replace('"', "\"\"")))
}

// ===========================================================================
// papaparse port â€” v1 parses uploads with `papaParse(text, { skipEmptyLines: true })`
// ===========================================================================
//
// Ported from papaparse 5.5.3 (backend/node_modules/papaparse/papaparse.js):
// `guessLineEndings`, `guessDelimiter`, the `Parser` loop (fast mode + the
// quoted-field state machine, including the `extraSpaces` tolerance and the
// MissingQuotes/InvalidQuotes errors), and the `skipEmptyLines` filter. Byte
// indices stand in for JS's UTF-16 ones, which is identical for any input whose
// delimiters, quotes and newlines are ASCII (they always are: papaparse only
// ever guesses among `,`, `\t`, `|`, `;`, RS, US).

const RECORD_SEP: &str = "\u{1e}";
const UNIT_SEP: &str = "\u{1f}";

struct CsvErr {
    message: String,
    /// papaparse's `row`; `None` renders as JS's `undefined` (the
    /// UndetectableDelimiter error carries no row).
    row: Option<usize>,
}

struct ParsedCsv {
    data: Vec<Vec<String>>,
    errors: Vec<CsvErr>,
}

fn idx_of(hay: &[u8], needle: &[u8], from: i64) -> i64 {
    let start = if from < 0 { 0usize } else { from as usize };
    if start > hay.len() || needle.is_empty() {
        return -1;
    }
    hay[start..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| (start + p) as i64)
        .unwrap_or(-1)
}

fn substr_eq(hay: &[u8], at: usize, needle: &str) -> bool {
    let n = needle.as_bytes();
    at + n.len() <= hay.len() && &hay[at..at + n.len()] == n
}

/// papaparse `Parser.prototype.parse` with `comments: false`, `escapeChar ==
/// quoteChar == '"'`, `step` unset and `ignoreLastRow` false.
fn parse_with(input: &str, delim: &str, newline: &str, preview: Option<usize>) -> ParsedCsv {
    let b = input.as_bytes();
    let input_len = b.len();
    let delim_len = delim.len();
    let newline_len = newline.len();
    let mut data: Vec<Vec<String>> = Vec::new();
    let mut errors: Vec<CsvErr> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cursor: usize = 0;

    if input.is_empty() {
        return ParsedCsv { data, errors };
    }

    // fastMode: no quote character anywhere â†’ plain splits.
    if !input.contains('"') {
        for (i, line) in input.split(newline).enumerate() {
            data.push(line.split(delim).map(|s| s.to_string()).collect());
            if let Some(p) = preview {
                if i + 1 > p {
                    data.truncate(p);
                    break;
                }
            }
        }
        return ParsedCsv { data, errors };
    }

    let mut next_delim = idx_of(b, delim.as_bytes(), cursor as i64);
    let mut next_newline = idx_of(b, newline.as_bytes(), cursor as i64);
    let mut quote_search = idx_of(b, b"\"", cursor as i64);

    // `finish(value)` â€” push the remainder as the last field and return.
    macro_rules! finish {
        ($value:expr) => {{
            let v: Option<String> = $value;
            let v = v.unwrap_or_else(|| input[cursor..].to_string());
            row.push(v);
            data.push(std::mem::take(&mut row));
            return ParsedCsv { data, errors };
        }};
    }

    loop {
        // Field has an opening quote.
        if cursor < input_len && b[cursor] == b'"' {
            quote_search = cursor as i64;
            cursor += 1;
            loop {
                quote_search = idx_of(b, b"\"", quote_search + 1);
                if quote_search == -1 {
                    errors.push(CsvErr {
                        message: "Quoted field unterminated".into(),
                        row: Some(data.len()),
                    });
                    finish!(None);
                }
                if quote_search == input_len as i64 - 1 {
                    let value = input[cursor..quote_search as usize].replace("\"\"", "\"");
                    finish!(Some(value));
                }
                // Escaped quote (`""`) â€” part of the data.
                if b[quote_search as usize + 1] == b'"' {
                    quote_search += 1;
                    continue;
                }
                if next_delim != -1 && next_delim < quote_search + 1 {
                    next_delim = idx_of(b, delim.as_bytes(), quote_search + 1);
                }
                if next_newline != -1 && next_newline < quote_search + 1 {
                    next_newline = idx_of(b, newline.as_bytes(), quote_search + 1);
                }
                let check_up_to = if next_newline == -1 {
                    next_delim
                } else {
                    next_delim.min(next_newline)
                };
                let spaces_delim = extra_spaces(input, quote_search, check_up_to);

                // Closing quote followed by (spaces +) delimiter.
                if substr_eq(b, quote_search as usize + 1 + spaces_delim, delim) {
                    row.push(input[cursor..quote_search as usize].replace("\"\"", "\""));
                    cursor = quote_search as usize + 1 + spaces_delim + delim_len;
                    if !(cursor < input_len && b[cursor] == b'"') {
                        quote_search = idx_of(b, b"\"", cursor as i64);
                    }
                    next_delim = idx_of(b, delim.as_bytes(), cursor as i64);
                    next_newline = idx_of(b, newline.as_bytes(), cursor as i64);
                    break;
                }

                let spaces_nl = extra_spaces(input, quote_search, next_newline);
                // Closing quote followed by (spaces +) newline.
                if substr_eq(b, quote_search as usize + 1 + spaces_nl, newline) {
                    row.push(input[cursor..quote_search as usize].replace("\"\"", "\""));
                    cursor = quote_search as usize + 1 + spaces_nl + newline_len;
                    data.push(std::mem::take(&mut row));
                    next_newline = idx_of(b, newline.as_bytes(), cursor as i64);
                    next_delim = idx_of(b, delim.as_bytes(), cursor as i64);
                    quote_search = idx_of(b, b"\"", cursor as i64);
                    if let Some(p) = preview {
                        if data.len() >= p {
                            return ParsedCsv { data, errors };
                        }
                    }
                    break;
                }

                // Not a valid closing quote â€” record and keep scanning.
                errors.push(CsvErr {
                    message: "Trailing quote on quoted field is malformed".into(),
                    row: Some(data.len()),
                });
                quote_search += 1;
            }
            continue;
        }

        // Next delimiter comes before the next newline â†’ end of field.
        if next_delim != -1 && (next_delim < next_newline || next_newline == -1) {
            row.push(input[cursor..next_delim as usize].to_string());
            cursor = next_delim as usize + delim_len;
            next_delim = idx_of(b, delim.as_bytes(), cursor as i64);
            continue;
        }

        // End of row.
        if next_newline != -1 {
            row.push(input[cursor..next_newline as usize].to_string());
            cursor = next_newline as usize + newline_len;
            data.push(std::mem::take(&mut row));
            next_newline = idx_of(b, newline.as_bytes(), cursor as i64);
            if let Some(p) = preview {
                if data.len() >= p {
                    return ParsedCsv { data, errors };
                }
            }
            continue;
        }

        break;
    }

    finish!(None)
}

/// papaparse `extraSpaces` â€” number of whitespace-only characters between the
/// closing quote and `index`.
fn extra_spaces(input: &str, quote_search: i64, index: i64) -> usize {
    if index == -1 {
        return 0;
    }
    let from = (quote_search + 1) as usize;
    let to = index as usize;
    if to <= from || to > input.len() {
        return 0;
    }
    let between = &input[from..to];
    if !between.is_empty() && js_trim(between).is_empty() {
        between.len()
    } else {
        0
    }
}

/// papaparse `guessLineEndings`.
fn guess_line_endings(input: &str) -> String {
    let capped: String = input.chars().take(1024 * 1024).collect();
    // Strip every non-greedy `"â€¦"` span, as the /"([^]*?)"/gm replace does.
    let mut stripped = String::with_capacity(capped.len());
    let bytes = capped.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            match idx_of(bytes, b"\"", i as i64 + 1) {
                -1 => {
                    stripped.push('"');
                    i += 1;
                }
                j => i = j as usize + 1,
            }
        } else {
            let ch_len = capped[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            stripped.push_str(&capped[i..i + ch_len]);
            i += ch_len;
        }
    }

    let r: Vec<&str> = stripped.split('\r').collect();
    let n: Vec<&str> = stripped.split('\n').collect();
    let n_appears_first = n.len() > 1 && n[0].chars().count() < r[0].chars().count();
    if r.len() == 1 || n_appears_first {
        return "\n".into();
    }
    let num_with_n = r.iter().filter(|s| s.starts_with('\n')).count();
    if num_with_n as f64 >= r.len() as f64 / 2.0 {
        "\r\n".into()
    } else {
        "\r".into()
    }
}

/// papaparse `testEmptyLine` for `skipEmptyLines: true` (not `'greedy'`).
fn test_empty_line(row: &[String]) -> bool {
    row.len() == 1 && row[0].is_empty()
}

/// papaparse `guessDelimiter` (`skipEmptyLines` is on, `comments` off).
fn guess_delimiter(input: &str, newline: &str) -> Option<String> {
    let candidates = [",", "\t", "|", ";", RECORD_SEP, UNIT_SEP];
    let mut best_delim: Option<String> = None;
    let mut best_delta: Option<i64> = None;
    let mut max_field_count: Option<f64> = None;

    for delim in candidates {
        let mut delta: i64 = 0;
        let mut avg_field_count: f64 = 0.0;
        let mut empty_lines = 0usize;
        let mut prev: Option<usize> = None;

        let preview = parse_with(input, delim, newline, Some(10));
        for row in &preview.data {
            if test_empty_line(row) {
                empty_lines += 1;
                continue;
            }
            let field_count = row.len();
            avg_field_count += field_count as f64;
            match prev {
                None => {
                    prev = Some(field_count);
                    continue;
                }
                Some(p) => {
                    if field_count > 0 {
                        delta += (field_count as i64 - p as i64).abs();
                        prev = Some(field_count);
                    }
                }
            }
        }
        if !preview.data.is_empty() {
            avg_field_count /= (preview.data.len() - empty_lines) as f64;
        }

        let delta_ok = best_delta.map(|b| delta <= b).unwrap_or(true);
        let count_ok = max_field_count.map(|m| avg_field_count > m).unwrap_or(true);
        if delta_ok && count_ok && avg_field_count > 1.99 {
            best_delta = Some(delta);
            best_delim = Some(delim.to_string());
            max_field_count = Some(avg_field_count);
        }
    }
    best_delim
}

/// `papaParse(text, { skipEmptyLines: true })`.
fn papa_parse(input: &str) -> ParsedCsv {
    // papaparse's `stripBom` â€” a leading U+FEFF would otherwise become part of
    // the first header name (and of the sample's first key).
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let newline = guess_line_endings(input);
    let guessed = guess_delimiter(input, &newline);
    let delim = guessed.clone().unwrap_or_else(|| ",".to_string());
    let mut out = parse_with(input, &delim, &newline, None);
    out.data.retain(|r| !test_empty_line(r));
    if guessed.is_none() {
        // papaparse appends this AFTER parsing, so quote errors stay first.
        out.errors.push(CsvErr {
            message: "Unable to auto-detect delimiting character; defaulted to ','".into(),
            row: None,
        });
    }
    out
}

// ===========================================================================
// CSV import â€” session store
// ===========================================================================

struct CsvSession {
    id: String,
    user_id: String,
    connection_id: String,
    filename: String,
    /// v1 stores `headers.map(h => h.trim())` on the sessionâ€¦ and then never
    /// reads it (`buildMapIndex` takes it and ignores it; mappings address CSV
    /// columns by index). Kept so the stored shape matches v1 exactly.
    #[allow(dead_code)]
    headers: Vec<String>,
    /// â€¦but responds with the untrimmed header row, and keys the sample by it.
    raw_headers: Vec<String>,
    sample: Vec<Value>,
    rows: Vec<Vec<String>>,
    last_touched: AtomicI64,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<CsvSession>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<CsvSession>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `CsvImportService.getSession` â€” same 404 for missing, expired and
/// another-user's session (the message must not distinguish them).
fn get_session(user_id: &str, session_id: &str) -> ApiResult<Arc<CsvSession>> {
    let found = sessions().lock().unwrap().get(session_id).cloned();
    let s = found.ok_or_else(|| {
        ApiError::new(StatusCode::NOT_FOUND, "Import session not found or expired")
    })?;
    if s.user_id != user_id {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "Import session not found or expired",
        ));
    }
    s.last_touched.store(now_ms(), Ordering::Relaxed);
    Ok(s)
}

/// `CsvImportService.sweep` â€” drop sessions idle for longer than the TTL.
fn sweep_sessions() {
    let cutoff = now_ms() - SESSION_TTL_MS;
    sessions()
        .lock()
        .unwrap()
        .retain(|_, s| s.last_touched.load(Ordering::Relaxed) >= cutoff);
}

// ===========================================================================
// CSV import â€” column metadata + value coercion
// ===========================================================================

struct ColumnMeta {
    name: String,
    data_type: String,
    nullable: bool,
    default_value: Option<String>,
    is_identity: bool,
}

/// `PostgresDriver.getTableColumns`, reduced to the fields the importer reads
/// (v1's query also resolves PK/unique/comment, which csv-import never looks
/// at). Schema and table are bound, never interpolated.
async fn load_columns(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> ApiResult<Vec<ColumnMeta>> {
    let rows = sqlx::query(
        r#"SELECT c.column_name AS name,
                  c.data_type AS data_type,
                  (c.is_nullable = 'YES') AS nullable,
                  c.column_default AS default_value,
                  (c.is_identity = 'YES') AS is_identity
             FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position"#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;

    Ok(rows
        .iter()
        .map(|r| ColumnMeta {
            name: r.try_get::<String, _>("name").unwrap_or_default(),
            data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
            nullable: r.try_get::<bool, _>("nullable").unwrap_or(true),
            default_value: r.try_get::<Option<String>, _>("default_value").unwrap_or(None),
            is_identity: r.try_get::<bool, _>("is_identity").unwrap_or(false),
        })
        .collect())
}

/// JS `Number(string)`.
fn js_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> Option<f64> {
        t.strip_prefix(p)
            .filter(|d| !d.is_empty())
            .map(|d| match u128::from_str_radix(d, r) {
                Ok(v) => v as f64,
                Err(_) => {
                    if d.chars().all(|c| c.is_digit(r)) {
                        f64::INFINITY // overflowed u128; JS keeps a (huge) float
                    } else {
                        f64::NAN
                    }
                }
            })
    };
    for (p, r) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(v) = radix(p, r) {
            return v;
        }
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    let neg = t.starts_with('-');
    if body == "Infinity" {
        return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    // StrDecimalLiteral: digits [ . digits ] [ (e|E) [+|-] digits ] | . digits â€¦
    if !is_js_decimal(body) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn is_js_decimal(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    let mut int_digits = 0usize;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        int_digits += 1;
    }
    let mut frac_digits = 0usize;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            frac_digits += 1;
        }
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
            i += 1;
        }
        let mut exp_digits = 0usize;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            exp_digits += 1;
        }
        if exp_digits == 0 {
            return false;
        }
    }
    i == bytes.len()
}

/// JS `String(number)` â€” ECMA-262 `Number::toString`, which is the exact text
/// node-postgres puts on the wire for a numeric parameter and therefore what
/// Postgres's input function parses. Rust's own `{}`/`{:.0}` disagree with it on
/// both ends of the range (`1e21`, `1e-7`, and any integer past 2^53), so the
/// digits come from `{:e}` â€” shortest round-trip, same as V8's â€” and the
/// positional/exponential choice is the spec's.
fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into(); // JS renders -0 as "0"
    }
    if n < 0.0 {
        return format!("-{}", js_number_to_string(-n));
    }
    if n.is_infinite() {
        return "Infinity".into();
    }
    let sci = format!("{n:e}"); // e.g. "1.2345678901234567e19"
    let (mant, exp) = match sci.split_once('e') {
        Some(p) => p,
        None => return sci,
    };
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    // ECMA's `n`: value = digits * 10^(n - k).
    let nn = exp + 1;
    if k <= nn && nn <= 21 {
        return format!("{}{}", digits, "0".repeat((nn - k) as usize));
    }
    if 0 < nn && nn <= 21 {
        return format!("{}.{}", &digits[..nn as usize], &digits[nn as usize..]);
    }
    if -6 < nn && nn <= 0 {
        return format!("0.{}{}", "0".repeat((-nn) as usize), digits);
    }
    let e_part = if nn - 1 >= 0 {
        format!("e+{}", nn - 1)
    } else {
        format!("e-{}", 1 - nn)
    };
    if k == 1 {
        format!("{digits}{e_part}")
    } else {
        format!("{}.{}{}", &digits[..1], &digits[1..], e_part)
    }
}

/// node-postgres `prepareValue` â€” how a JS value becomes a text parameter.
/// `null`/`undefined` stay NULL, objects and arrays are `JSON.stringify`d,
/// everything else is `String(value)`. Only the cases `coerce`'s JSON branch can
/// produce are reachable here.
fn prepare_value(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        // NB: a bare JSON string coerces to its *contents*, so `"x"` reaches
        // Postgres as `x` and json_in rejects it â€” exactly as it does in v1.
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(js_number_to_string(n.as_f64().unwrap_or(f64::NAN))),
        other => Some(js_stringify(other)),
    }
}

/// `JSON.stringify` for a value that came out of `JSON.parse`: every number is
/// an IEEE double rendered by `Number::toString`, which is where serde_json's
/// own output differs (it keeps `1e3` as `1000.0` and 2^53+1 exactly).
fn js_stringify(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().map(js_stringify).collect();
            format!("[{}]", parts.join(","))
        }
        Value::Object(o) => {
            let parts: Vec<String> = o
                .iter()
                .map(|(k, val)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into()),
                        js_stringify(val)
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

fn js_is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// `CsvImportService.coerce` â€” same branches, same messages. The result is the
/// text node-postgres would send for the coerced JS value (`prepareValue`:
/// numbers and booleans via `toString`, objects via `JSON.stringify`, `null`
/// stays NULL); Postgres's input function for the column type does the rest.
fn coerce(value: &str, col: &ColumnMeta) -> Result<Option<String>, String> {
    if value.is_empty() {
        if !col.nullable && col.default_value.is_none() {
            return Err(format!("Column {} is NOT NULL and has no default", col.name));
        }
        return Ok(None);
    }
    let t = col.data_type.to_lowercase();

    const NUMERIC: [&str; 10] = [
        "int", "integer", "bigint", "smallint", "serial", "numeric", "decimal", "real", "double",
        "float",
    ];
    const INTEGRAL: [&str; 5] = ["int", "integer", "bigint", "smallint", "serial"];

    if re_any_word(&t, &NUMERIC, true) {
        let n = js_number(value);
        if n.is_nan() {
            return Err(format!("Column {}: \"{}\" is not a number", col.name, value));
        }
        if re_any_word(&t, &INTEGRAL, true) && !js_is_integer(n) {
            return Err(format!(
                "Column {}: \"{}\" has a fractional part",
                col.name, value
            ));
        }
        return Ok(Some(js_number_to_string(n)));
    }

    if re_word(&t, "bool", false) {
        let v = js_trim(value).to_lowercase();
        if ["true", "t", "1", "yes", "y"].contains(&v.as_str()) {
            return Ok(Some("true".into()));
        }
        if ["false", "f", "0", "no", "n"].contains(&v.as_str()) {
            return Ok(Some("false".into()));
        }
        return Err(format!(
            "Column {}: \"{}\" is not a valid boolean",
            col.name, value
        ));
    }

    if re_word(&t, "json", false) {
        // v1 parses here so the driver serializes it; `prepareValue` then decides
        // what actually goes on the wire â€” including `JSON.parse('null')`, which
        // becomes a SQL NULL rather than the JSON value `null`.
        //
        // Two documented differences from `JSON.parse`, both only reachable from
        // a pathological numeric literal in a json/jsonb cell: an out-of-range
        // number (`1e309`) becomes `Infinity` in JS and is then rejected by
        // `json_in`, while serde_json refuses it here â€” the row fails either way,
        // only the message differs; and a literal with more than 17 significant
        // digits can land one ULP away from V8's double.
        return match serde_json::from_str::<Value>(value) {
            Ok(v) => Ok(prepare_value(&v)),
            Err(_) => Err(format!(
                "Column {}: \"{}\" is not valid JSON",
                col.name, value
            )),
        };
    }

    // text / varchar / timestamp / uuid / â€¦ pass through as a string.
    Ok(Some(value.to_string()))
}

// ===========================================================================
// CSV import â€” DTOs
// ===========================================================================

#[derive(Deserialize, Default)]
struct RawImportDto {
    #[serde(default)]
    schema: Option<Value>,
    #[serde(default)]
    table: Option<Value>,
    #[serde(default)]
    mappings: Option<Value>,
    #[serde(default)]
    stop_on_error: Option<Value>,
    #[serde(rename = "stopOnError", default)]
    stop_on_error_camel: Option<Value>,
}

struct Mapping {
    csv_column: Option<usize>,
    target_column: String,
}

struct ImportDto {
    schema: String,
    table: String,
    mappings: Vec<Mapping>,
    stop_on_error: bool,
}

/// `DryRunDto` / `CommitDto` â€” `@IsString() @Length(1,64) @Matches(IDENT_RE)` on
/// schema/table/targetColumn, `@IsArray() @ArrayNotEmpty()` on mappings,
/// `@IsInt() @Min(0)` on a non-null csvColumn, optional `@IsBoolean()`
/// stopOnError.
fn parse_import_dto(bytes: &[u8]) -> ApiResult<ImportDto> {
    let dto: RawImportDto = serde_json::from_slice(bytes).unwrap_or_default();

    let ident = |v: &Option<Value>, field: &str| -> ApiResult<String> {
        match v {
            Some(Value::String(s)) => {
                if s.is_empty() || s.chars().count() > 64 {
                    return Err(validation_error(&format!(
                        "{field} must be longer than or equal to 1 and shorter than or equal to 64 characters"
                    )));
                }
                if !dto_ident_ok(s) {
                    return Err(validation_error(&format!(
                        "{field} must match /^[A-Za-z_][A-Za-z0-9_]{{0,63}}$/ regular expression"
                    )));
                }
                Ok(s.clone())
            }
            _ => Err(validation_error(&format!("{field} must be a string"))),
        }
    };
    let schema = ident(&dto.schema, "schema")?;
    let table = ident(&dto.table, "table")?;

    let arr = match dto.mappings {
        Some(Value::Array(a)) if !a.is_empty() => a,
        Some(Value::Array(_)) => return Err(validation_error("mappings should not be empty")),
        _ => return Err(validation_error("mappings must be an array")),
    };
    let mut mappings = Vec::with_capacity(arr.len());
    for m in arr {
        let target = m.get("targetColumn").cloned();
        let target = ident(&target, "targetColumn")?;
        let csv_column = match m.get("csvColumn") {
            None | Some(Value::Null) => None,
            Some(Value::Number(n)) => {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if !js_is_integer(f) {
                    return Err(validation_error("csvColumn must be an integer number"));
                }
                if f < 0.0 {
                    return Err(validation_error("csvColumn must not be less than 0"));
                }
                Some(f as usize)
            }
            _ => return Err(validation_error("csvColumn must be an integer number")),
        };
        mappings.push(Mapping {
            csv_column,
            target_column: target,
        });
    }

    let stop = dto.stop_on_error_camel.or(dto.stop_on_error);
    let stop_on_error = match stop {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => b,
        _ => return Err(validation_error("stopOnError must be a boolean value")),
    };

    Ok(ImportDto {
        schema,
        table,
        mappings,
        stop_on_error,
    })
}

// ===========================================================================
// CSV import â€” handlers
// ===========================================================================

/// Shared preamble: RBAC (v1's guard runs before validation), then the proxy
/// decision on the connection in the path.
async fn csv_preamble(
    state: &AppState,
    id: &str,
    user_id: &str,
    min_role: &str,
) -> ApiResult<ConnMeta> {
    require_role(&state.pool, id, user_id, min_role).await?;
    load_conn_meta(state, id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))
}

/// `POST /api/connections/:id/csv-import/upload` â€” EDITOR, multipart `file`.
async fn csv_upload(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    let meta = csv_preamble(&state, &id, &user.id, "EDITOR").await?;
    if meta.must_proxy(&state) {
        // NB: `crate::proxy` buffers at 25 MB, so an upload above that for a
        // connection only v1 can serve is refused here rather than forwarded.
        return Ok(crate::proxy(State(state), req).await);
    }
    ensure_reaper();

    let mut mp = Multipart::from_request(req, &state)
        .await
        .map_err(|e| ApiError::bad(e.to_string()))?;
    let mut file: Option<(String, bytes::Bytes)> = None;
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| ApiError::bad(e.to_string()))?
    {
        let name = field.name().map(|s| s.to_string());
        let filename = field.file_name().map(|s| s.to_string());
        if name.as_deref() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError::bad(e.to_string()))?;
            file = Some((filename.unwrap_or_default(), data));
            break;
        }
    }
    // v1: `if (!file) throw new Error('file is required')` â†’ a 500.
    let (filename, data) = file.ok_or_else(|| ApiError::internal("file is required"))?;
    if data.len() > MAX_UPLOAD_BYTES {
        // multer's LIMIT_FILE_SIZE â†’ Nest's PayloadTooLargeException.
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "File too large"));
    }

    // Node's `buffer.toString('utf8')` replaces invalid sequences too.
    let text = String::from_utf8_lossy(&data).into_owned();
    let parsed = papa_parse(&text);
    if let Some(first) = parsed.errors.first() {
        let row = first
            .row
            .map(|r| r.to_string())
            .unwrap_or_else(|| "undefined".into());
        return Err(ApiError::bad(format!(
            "CSV parse error: {} (row {})",
            first.message, row
        )));
    }
    if parsed.data.is_empty() {
        return Err(ApiError::bad("CSV contains no rows"));
    }
    let mut data_rows = parsed.data;
    let raw_headers = data_rows.remove(0);
    if raw_headers.is_empty() {
        return Err(ApiError::bad("CSV has no header row"));
    }
    if data_rows.len() > MAX_PARSED_ROWS {
        return Err(ApiError::bad(format!(
            "File has {} rows; max supported via import UI is {}",
            data_rows.len(),
            MAX_PARSED_ROWS
        )));
    }

    // v1 keys the sample by the UNTRIMMED headers and trims only what it stores.
    let mut sample = Vec::new();
    for row in data_rows.iter().take(SAMPLE_SIZE) {
        let mut obj = Map::new();
        for (c, h) in raw_headers.iter().enumerate() {
            obj.insert(
                h.clone(),
                Value::String(row.get(c).cloned().unwrap_or_default()),
            );
        }
        sample.push(Value::Object(obj));
    }

    let session_id = {
        let mut buf = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut buf);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    };
    let total_rows = data_rows.len();
    let session = CsvSession {
        id: session_id.clone(),
        user_id: user.id.clone(),
        connection_id: id.clone(),
        filename: filename.clone(),
        headers: raw_headers.iter().map(|h| js_trim(h).to_string()).collect(),
        raw_headers: raw_headers.clone(),
        sample: sample.clone(),
        rows: data_rows,
        last_touched: AtomicI64::new(now_ms()),
    };
    sessions()
        .lock()
        .unwrap()
        .insert(session_id.clone(), Arc::new(session));

    Ok(Json(json!({
        "sessionId": session_id,
        "filename": filename,
        "headers": raw_headers,
        "sample": sample,
        "totalRows": total_rows,
    }))
    .into_response())
}

/// `GET /api/connections/:id/csv-import/:sessionId` â€” VIEWER. Not a v1 route
/// (v1 has no GET); it reports the stored session in the exact `UploadResult`
/// shape so a client that lost the upload response can recover it.
async fn csv_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, session_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let meta = csv_preamble(&state, &id, &user.id, "VIEWER").await?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let s = get_session(&user.id, &session_id)?;
    Ok(Json(json!({
        "sessionId": s.id,
        "filename": s.filename,
        "headers": s.raw_headers,
        "sample": s.sample,
        "totalRows": s.rows.len(),
    }))
    .into_response())
}

/// `DELETE /api/connections/:id/csv-import/:sessionId` â€” VIEWER, 204.
/// `CsvImportService.discard` is silent when the session is missing or owned by
/// someone else.
async fn csv_discard(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, session_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let meta = csv_preamble(&state, &id, &user.id, "VIEWER").await?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), req).await);
    }
    let mut map = sessions().lock().unwrap();
    if map.get(&session_id).map(|s| s.user_id == user.id).unwrap_or(false) {
        map.remove(&session_id);
    }
    drop(map);
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Open the target database the way v1's driver does per checkout: the
/// connection's statement timeout, plus a READ ONLY session when the connection
/// is flagged read-only (csv-import builds its driver with `readOnly` defaulting
/// to the connection's own setting).
async fn open_target(
    state: &AppState,
    conn_id: &str,
    user_id: &str,
    meta: &ConnMeta,
) -> ApiResult<crate::TargetConn> {
    let mut c = connect_target(state, conn_id, user_id).await?;
    let _ = sqlx::query(&format!(
        "SET statement_timeout = {}",
        meta.statement_timeout_ms
    ))
    .execute(&mut *c)
    .await;
    if meta.read_only {
        let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut *c)
            .await;
    }
    Ok(c)
}

/// The session's own connection decides where the work happens. v1 uses
/// `session.connectionId` (not the `:id` in the path) for both dry-run and
/// commit, so a session whose connection v2 cannot serve is forwarded to v1
/// rather than written to directly.
async fn target_meta_for(
    state: &AppState,
    path_id: &str,
    path_meta: ConnMeta,
    session_conn_id: &str,
) -> ApiResult<Option<ConnMeta>> {
    if session_conn_id == path_id {
        return Ok(Some(path_meta));
    }
    let meta = load_conn_meta(state, session_conn_id).await?;
    Ok(match meta {
        Some(m) if !m.must_proxy(state) => Some(m),
        _ => None,
    })
}

/// `POST /api/connections/:id/csv-import/:sessionId/dry-run` â€” EDITOR.
async fn csv_dry_run(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, session_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let meta = csv_preamble(&state, &id, &user.id, "EDITOR").await?;
    let (parts, bytes) = split_body(req).await?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    }
    let dto = parse_import_dto(&bytes)?;
    let session = get_session(&user.id, &session_id)?;
    let Some(meta) = target_meta_for(&state, &id, meta, &session.connection_id).await? else {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    };

    let mut conn = open_target(&state, &session.connection_id, &user.id, &meta).await?;
    let cols = load_columns(&mut conn, &dto.schema, &dto.table).await?;
    let _ = conn.close().await;
    let by_name: HashMap<&str, &ColumnMeta> =
        cols.iter().map(|c| (c.name.as_str(), c)).collect();

    // Validate the mapping shape once, before iterating the rows.
    for m in &dto.mappings {
        if !by_name.contains_key(m.target_column.as_str()) {
            return Err(ApiError::bad(format!(
                "Column {} does not exist in {}.{}",
                m.target_column, dto.schema, dto.table
            )));
        }
    }
    for c in &cols {
        if !c.nullable && c.default_value.is_none() && !c.is_identity {
            let mapped = dto
                .mappings
                .iter()
                .any(|m| m.target_column == c.name && m.csv_column.is_some());
            if !mapped {
                return Err(ApiError::bad(format!(
                    "Column {} is required but no CSV column is mapped to it",
                    c.name
                )));
            }
        }
    }

    let mut error_rows: Vec<Value> = Vec::new();
    let mut ok_rows = 0usize;
    for (i, row) in session.rows.iter().enumerate() {
        let mut err: Option<String> = None;
        for m in &dto.mappings {
            let Some(csv_index) = m.csv_column else { continue };
            let col = by_name[m.target_column.as_str()];
            let raw = row.get(csv_index).map(|s| s.as_str()).unwrap_or("");
            if let Err(e) = coerce(raw, col) {
                err = Some(e);
                break;
            }
        }
        match err {
            None => ok_rows += 1,
            Some(message) => {
                error_rows.push(json!({ "rowIndex": i, "message": message }));
                if error_rows.len() >= MAX_DRY_RUN_ERRORS {
                    break;
                }
            }
        }
    }
    session.last_touched.store(now_ms(), Ordering::Relaxed);

    Ok(Json(json!({
        "totalRows": session.rows.len(),
        "okRows": ok_rows,
        "errorRows": error_rows,
    }))
    .into_response())
}

/// `POST /api/connections/:id/csv-import/:sessionId/commit` â€” EDITOR.
async fn csv_commit(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, session_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let meta = csv_preamble(&state, &id, &user.id, "EDITOR").await?;
    let (parts, bytes) = split_body(req).await?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    }
    let dto = parse_import_dto(&bytes)?;
    let session = get_session(&user.id, &session_id)?;
    let Some(meta) = target_meta_for(&state, &id, meta, &session.connection_id).await? else {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    };

    let mut conn = open_target(&state, &session.connection_id, &user.id, &meta).await?;
    let cols = load_columns(&mut conn, &dto.schema, &dto.table).await?;
    let casts = column_cast_types(&mut conn, &dto.schema, &dto.table).await?;
    let by_name: HashMap<&str, &ColumnMeta> =
        cols.iter().map(|c| (c.name.as_str(), c)).collect();
    // v1 starts the clock after the column lookup, so `durationMs` measures the
    // insert loop only.
    let started = now_ms();

    // v1's commit does NOT re-run the dry-run's mapping validation: a mapping to
    // a column that does not exist blows up per row inside `coerce`, so every
    // row lands in `failed` and nothing is written.
    let map_index: Vec<&Mapping> = dto
        .mappings
        .iter()
        .filter(|m| m.csv_column.is_some())
        .collect();

    // `insertRow` filters the value keys by the live column list, so the insert
    // column list is the mapped columns that exist, deduplicated in first-seen
    // order (JS object-key semantics).
    let mut insert_cols: Vec<String> = Vec::new();
    for m in &map_index {
        if by_name.contains_key(m.target_column.as_str())
            && !insert_cols.contains(&m.target_column)
        {
            insert_cols.push(m.target_column.clone());
        }
    }
    // quotePg runs per row in v1 and throws inside the try/catch, so a
    // schema/table/column name it rejects fails every row instead of the request.
    let insert_sql = build_insert_sql(&dto.schema, &dto.table, &insert_cols, &casts);

    let mut failed: Vec<Value> = Vec::new();
    let mut inserted: u64 = 0;
    for (i, row) in session.rows.iter().enumerate() {
        let mut values: HashMap<&str, Option<String>> = HashMap::new();
        let mut err: Option<String> = None;
        for m in &map_index {
            let csv_index = m.csv_column.expect("filtered above");
            let raw = row.get(csv_index).map(|s| s.as_str()).unwrap_or("");
            match by_name.get(m.target_column.as_str()) {
                None => {
                    err = Some(format!(
                        "Column {} does not exist in {}.{}",
                        m.target_column, dto.schema, dto.table
                    ));
                    break;
                }
                Some(col) => match coerce(raw, col) {
                    // Later mappings onto the same column overwrite earlier ones,
                    // as assigning twice to one JS object key does.
                    Ok(v) => {
                        values.insert(m.target_column.as_str(), v);
                    }
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                },
            }
        }
        if err.is_none() {
            match &insert_sql {
                Err(e) => err = Some(e.clone()),
                Ok(sql) => {
                    let mut q = sqlx::query(sql);
                    for c in &insert_cols {
                        q = q.bind(values.get(c.as_str()).cloned().unwrap_or(None));
                    }
                    match q.execute(&mut *conn).await {
                        Ok(_) => inserted += 1,
                        Err(e) => err = Some(e.to_string()),
                    }
                }
            }
        }
        if let Some(message) = err {
            failed.push(json!({ "rowIndex": i, "message": slice_chars(&message, 400) }));
            if dto.stop_on_error {
                break;
            }
            if failed.len() >= MAX_COMMIT_FAILURES {
                break;
            }
        }
    }
    let _ = conn.close().await;

    // The session stays alive so the client can re-commit after fixing the CSV.
    session.last_touched.store(now_ms(), Ordering::Relaxed);

    Ok(Json(json!({
        "inserted": inserted,
        "failed": failed,
        "durationMs": now_ms() - started,
    }))
    .into_response())
}

/// Each column's type WITHOUT its modifier (`format_type(atttypid, NULL)`), e.g.
/// "integer", "character varying", "public.my_enum", "text[]". Dropping the
/// modifier is deliberate â€” see the note at the top of this file.
async fn column_cast_types(
    conn: &mut PgConnection,
    schema: &str,
    table: &str,
) -> ApiResult<HashMap<String, String>> {
    let rows = sqlx::query(
        "SELECT a.attname::text AS name, format_type(a.atttypid, NULL) AS ftype \
           FROM pg_attribute a \
           JOIN pg_class c ON c.oid = a.attrelid \
           JOIN pg_namespace n ON n.oid = c.relnamespace \
          WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let name = r.try_get::<String, _>("name").ok()?;
            let ftype = r.try_get::<String, _>("ftype").ok()?;
            Some((name, ftype))
        })
        .collect())
}

/// `PostgresDriver.insertRow` â€” quoted identifiers, one bound text parameter per
/// column read back through the column's own type cast, and `DEFAULT VALUES`
/// when nothing is mapped (exactly what v1 emits for an empty value object).
///
/// The cast type comes from the catalog, never from the request; a column with
/// no catalog entry falls back to a bare `$n`, which fails loudly rather than
/// guessing.
fn build_insert_sql(
    schema: &str,
    table: &str,
    cols: &[String],
    casts: &HashMap<String, String>,
) -> Result<String, String> {
    let qs = quote_pg(schema)?;
    let qt = quote_pg(table)?;
    if cols.is_empty() {
        return Ok(format!("INSERT INTO {qs}.{qt} DEFAULT VALUES"));
    }
    let mut names = Vec::with_capacity(cols.len());
    let mut placeholders = Vec::with_capacity(cols.len());
    for (i, c) in cols.iter().enumerate() {
        names.push(quote_pg(c)?);
        placeholders.push(match casts.get(c) {
            Some(t) => format!("CAST(${} AS {t})", i + 1),
            None => format!("${}", i + 1),
        });
    }
    Ok(format!(
        "INSERT INTO {qs}.{qt} ({}) VALUES ({})",
        names.join(","),
        placeholders.join(",")
    ))
}

// ===========================================================================
// Server-side cursors
// ===========================================================================

struct CursorState {
    fields: Vec<Value>,
    last_used_at: i64,
    exhausted: bool,
}

struct CursorSession {
    id: String,
    user_id: String,
    pg_name: String,
    /// The dedicated connection holding `BEGIN READ ONLY` + the DECLAREd cursor.
    /// The tokio mutex replaces v1's promise `chain`: two concurrent FETCHes
    /// cannot interleave on one connection's protocol state. `None` once closed.
    conn: tokio::sync::Mutex<Option<crate::TargetConn>>,
    st: Mutex<CursorState>,
    created_at: i64,
    /// SECURITY: this opens its own connection instead of going through the
    /// masking driver wrapper, so the user's masked columns are resolved once at
    /// open and applied to every page.
    masked: Vec<String>,
}

fn cursors() -> &'static Mutex<HashMap<String, Arc<CursorSession>>> {
    static CURSORS: OnceLock<Mutex<HashMap<String, Arc<CursorSession>>>> = OnceLock::new();
    CURSORS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cursor_gone() -> ApiError {
    ApiError::coded(
        StatusCode::BAD_REQUEST,
        "CURSOR_GONE",
        "Cursor not found or expired",
    )
}

/// v1 starts both sweepers in the service constructors. There is no v2 startup
/// hook here (main.rs is not touched), so the reaper is spawned the first time
/// this module creates state. One task drives both: cursors on v1's 30s tick,
/// CSV sessions on the same tick instead of their own 60s one â€” the TTL itself
/// is unchanged, only the granularity of the check.
fn ensure_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            loop {
                tokio::time::sleep(Duration::from_millis(SWEEP_MS)).await;
                sweep_cursors().await;
                sweep_sessions();
            }
        });
    });
}

/// `CursorService.sweep` â€” reap idle and over-aged cursors.
async fn sweep_cursors() {
    let now = now_ms();
    let doomed: Vec<Arc<CursorSession>> = {
        let map = cursors().lock().unwrap();
        map.values()
            .filter(|s| {
                let st = s.st.lock().unwrap();
                now - st.last_used_at > IDLE_MS || now - s.created_at > MAX_LIFETIME_MS
            })
            .cloned()
            .collect()
    };
    for s in doomed {
        tracing::debug!("reaping cursor {}", s.id);
        cursors().lock().unwrap().remove(&s.id);
        close_session(&s).await;
    }
}

/// `CursorService.closeSession` â€” ROLLBACK ends the read-only transaction and
/// drops the cursor, then the connection goes away.
async fn close_session(s: &Arc<CursorSession>) {
    let mut guard = s.conn.lock().await;
    if let Some(mut c) = guard.take() {
        let _ = (&mut c).execute("ROLLBACK").await;
        let _ = c.close().await;
    }
}

fn clamp_page(page_size: i64) -> i64 {
    let n = if page_size == 0 { 1000 } else { page_size };
    n.max(1).min(MAX_PAGE)
}

#[derive(Deserialize, Default)]
struct RawCursorDto {
    #[serde(default)]
    sql: Option<Value>,
    #[serde(rename = "pageSize", default)]
    page_size: Option<Value>,
}

/// `CursorOpenDto` / `CursorFetchDto`.
fn parse_cursor_dto(bytes: &[u8], want_sql: bool) -> ApiResult<(String, i64)> {
    let dto: RawCursorDto = serde_json::from_slice(bytes).unwrap_or_default();
    let sql = if want_sql {
        match dto.sql {
            Some(Value::String(s)) => {
                let len = s.chars().count();
                if len < 1 {
                    return Err(validation_error(
                        "sql must be longer than or equal to 1 characters",
                    ));
                }
                if len > 100_000 {
                    return Err(validation_error(
                        "sql must be shorter than or equal to 100000 characters",
                    ));
                }
                s
            }
            _ => return Err(validation_error("sql must be a string")),
        }
    } else {
        String::new()
    };
    let page_size = match dto.page_size {
        None | Some(Value::Null) => 1000,
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if !js_is_integer(f) {
                return Err(validation_error("pageSize must be an integer number"));
            }
            if f < 1.0 {
                return Err(validation_error("pageSize must not be less than 1"));
            }
            if f > MAX_PAGE as f64 {
                return Err(validation_error(&format!(
                    "pageSize must not be greater than {MAX_PAGE}"
                )));
            }
            f as i64
        }
        _ => return Err(validation_error("pageSize must be an integer number")),
    };
    Ok((sql, page_size))
}

/// `POST /api/connections/:id/query/cursor` â€” VIEWER, 200.
async fn cursor_open(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let meta = load_conn_meta(&state, &id)
        .await?
        .ok_or_else(|| ApiError::bad("Connection not found"))?;
    let (parts, bytes) = split_body(req).await?;
    // v1 answers CURSOR_UNSUPPORTED for non-Postgres and SSH-tunnelled
    // connections; forwarding lets the Node service answer for itself (and keeps
    // open/fetch/close on one side for the whole life of the cursor).
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    }
    let (sql, page_size) = parse_cursor_dto(&bytes, true)?;

    // `sql.trim().replace(/;\s*$/, '')` â€” the trim already ate any whitespace
    // after the semicolon, so stripping one trailing `;` is the same rewrite.
    let t = js_trim(&sql);
    let trimmed = t.strip_suffix(';').unwrap_or(t).to_string();
    // A cursor wraps exactly one statement; anything with a second one is out.
    if trimmed.contains(';') {
        return Err(ApiError::bad("Cursor queries must be a single statement"));
    }
    // `/^\s*(select|with)\b/i`
    let head: String = js_trim(&trimmed)
        .chars()
        .take(8)
        .collect::<String>()
        .to_lowercase();
    let is_select = ["select", "with"].iter().any(|kw| {
        head.starts_with(kw)
            && head[kw.len()..]
                .chars()
                .next()
                .map(|c| !is_word_char(c))
                .unwrap_or(true)
    });
    if !is_select {
        return Err(ApiError::bad("Cursor streaming supports SELECT queries only"));
    }

    ensure_reaper();
    if cursors().lock().unwrap().len() >= MAX_OPEN_CURSORS {
        sweep_cursors().await;
        if cursors().lock().unwrap().len() >= MAX_OPEN_CURSORS {
            return Err(ApiError::coded(
                StatusCode::BAD_REQUEST,
                "CURSOR_LIMIT",
                "Too many open cursors on this server. Close one or retry shortly.",
            ));
        }
    }

    let masked = masked_columns(&state.pool, &id, &user.id).await?;

    let cursor_id = {
        let mut buf = [0u8; 18];
        rand::rngs::OsRng.fill_bytes(&mut buf);
        buf.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    let pg_name = format!("dbdash_cur_{}", &cursor_id[..16]);
    debug_assert!(pg_name.chars().all(|c| is_word_char(c)));

    // v1 puts `statement_timeout` in the dedicated client's connection options,
    // so it caps every statement on this cursor â€” including a runaway FETCH.
    let mut conn = connect_target(&state, &id, &user.id).await?;
    let _ = (&mut conn)
        .execute(
            format!("SET statement_timeout = {}", meta.statement_timeout_ms).as_str(),
        )
        .await;

    // Column metadata up front, so an empty first page still names its columns
    // (v1 reads them off the first FETCH's row descriptor).
    let fields: Vec<Value> = match (&mut conn).describe(trimmed.as_str()).await {
        Ok(d) => d
            .columns()
            .iter()
            .map(|c| json!({ "name": c.name() }))
            .collect(),
        Err(_) => vec![],
    };

    // The cursor wraps the query in `to_jsonb` so each FETCH comes back as ready
    // JSON objects (v2's rows are shaped by Postgres everywhere else too). A
    // duplicate column name collapses to the last value â€” same as v1's
    // positional-array-to-object mapping.
    let declare = format!(
        "DECLARE {pg_name} NO SCROLL CURSOR FOR SELECT to_jsonb(t) FROM ({trimmed}) t"
    );
    // Executor::execute on a `&str` takes sqlx's simple-query path â€” the same
    // protocol node-postgres uses for a parameterless query, and it keeps these
    // one-shot statements out of the prepared-statement cache.
    let opened = async {
        // READ ONLY both enforces safety and lets Postgres skip write locks.
        (&mut conn).execute("BEGIN READ ONLY").await?;
        (&mut conn).execute(declare.as_str()).await?;
        Ok::<(), sqlx::Error>(())
    }
    .await;
    if let Err(e) = opened {
        let _ = conn.close().await;
        return Err(ApiError::bad(e.to_string()));
    }

    let session = Arc::new(CursorSession {
        id: cursor_id.clone(),
        user_id: user.id.clone(),
        pg_name,
        conn: tokio::sync::Mutex::new(Some(conn)),
        st: Mutex::new(CursorState {
            fields,
            last_used_at: now_ms(),
            exhausted: false,
        }),
        created_at: now_ms(),
        masked,
    });
    cursors()
        .lock()
        .unwrap()
        .insert(cursor_id.clone(), session.clone());

    let (fields, rows, done) = fetch_page(&session, clamp_page(page_size)).await?;
    Ok(Json(json!({
        "cursorId": cursor_id,
        "fields": fields,
        "rows": rows,
        "done": done,
    }))
    .into_response())
}

/// `POST /api/connections/:id/query/cursor/:cursorId/fetch` â€” VIEWER, 200.
async fn cursor_fetch(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, cursor_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let meta = load_conn_meta(&state, &id)
        .await?
        .ok_or_else(|| ApiError::bad("Connection not found"))?;
    let (parts, bytes) = split_body(req).await?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), rebuild(parts, bytes)).await);
    }
    let (_, page_size) = parse_cursor_dto(&bytes, false)?;

    let session = {
        let map = cursors().lock().unwrap();
        map.get(&cursor_id).cloned()
    }
    .ok_or_else(cursor_gone)?;
    if session.user_id != user.id {
        return Err(ApiError::bad("Cursor belongs to another user"));
    }

    let (fields, rows, done) = fetch_page(&session, clamp_page(page_size)).await?;
    Ok(Json(json!({ "fields": fields, "rows": rows, "done": done })).into_response())
}

/// `POST /api/connections/:id/query/cursor/:cursorId/close` â€” VIEWER, 200.
async fn cursor_close(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, cursor_id)): Path<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let meta = load_conn_meta(&state, &id)
        .await?
        .ok_or_else(|| ApiError::bad("Connection not found"))?;
    if meta.must_proxy(&state) {
        return Ok(crate::proxy(State(state), req).await);
    }

    let session = {
        let map = cursors().lock().unwrap();
        map.get(&cursor_id).cloned()
    };
    let Some(session) = session else {
        return Ok(Json(json!({ "closed": false })).into_response());
    };
    if session.user_id != user.id {
        return Err(ApiError::bad("Cursor belongs to another user"));
    }
    cursors().lock().unwrap().remove(&cursor_id);
    close_session(&session).await;
    Ok(Json(json!({ "closed": true })).into_response())
}

/// `CursorService.fetch` â€” one `FETCH FORWARD n`, masks applied, and the
/// connection freed eagerly the moment the result is drained.
async fn fetch_page(
    session: &Arc<CursorSession>,
    n: i64,
) -> ApiResult<(Vec<Value>, Vec<Value>, bool)> {
    let mut guard = session.conn.lock().await;
    {
        let st = session.st.lock().unwrap();
        if st.exhausted {
            return Ok((st.fields.clone(), vec![], true));
        }
    }

    let sql = format!("FETCH FORWARD {n} FROM {}", session.pg_name);
    let mut rows: Vec<Value> = {
        let conn = guard.as_mut().ok_or_else(cursor_gone)?;
        // Simple-query path (see cursor_open): same protocol as node-postgres,
        // and a varying page size never grows a prepared-statement cache.
        let fetched = conn
            .fetch_all(sql.as_str())
            .await
            .map_err(|e| ApiError::bad(e.to_string()))?;
        fetched
            .iter()
            .map(|r| r.try_get::<Option<Value>, _>(0).unwrap_or(None).unwrap_or(Value::Null))
            .collect()
    };

    // SECURITY: the same SQL through POST /query is masked; without this the
    // cursor endpoint would return the masked columns in the clear.
    if !session.masked.is_empty() {
        for r in rows.iter_mut() {
            mask_row(r, &session.masked);
        }
    }

    let done = (rows.len() as i64) < n;
    let fields = {
        let mut st = session.st.lock().unwrap();
        if st.fields.is_empty() {
            // describe() gave nothing â€” fall back to the first row's keys.
            st.fields = rows
                .first()
                .and_then(|r| r.as_object())
                .map(|o| o.keys().map(|k| json!({ "name": k })).collect())
                .unwrap_or_default();
        }
        st.last_used_at = now_ms();
        if done {
            st.exhausted = true;
        }
        st.fields.clone()
    };

    // Eagerly free the connection once the result is fully drained (v1 fires
    // closeSession without awaiting it; here it is inline because this task
    // already holds the connection lock).
    if done {
        cursors().lock().unwrap().remove(&session.id);
        if let Some(mut c) = guard.take() {
            let _ = (&mut c).execute("ROLLBACK").await;
            let _ = c.close().await;
        }
    }
    Ok((fields, rows, done))
}
