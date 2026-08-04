//! Query analysis tools â€” Rust port of the v1 NestJS `src/query/` endpoints that
//! hang off `/api/connections/:id/query/â€¦`, wire-compatible with them: same
//! paths, methods, status codes, error messages and JSON field names.
//!
//! v1 sources of truth:
//!   backend/src/query/query.controller.ts        (routes, roles, status codes)
//!   backend/src/query/explain.service.ts         (EXPLAIN â†’ flattened plan)
//!   backend/src/query/perf-insights.service.ts   (findings + index suggestions)
//!   backend/src/query/query-cost.service.ts      (row/cost estimate)
//!   backend/src/query/plan-regression.service.ts (PlanSnapshot capture/diff)
//!   backend/src/slow-query/slow-query.service.ts (`normalizeSql`, shape hash)
//!
//! Ported here (all `@RequireRole('VIEWER')`, all POSTs `@HttpCode(200)`):
//!   POST /api/connections/:id/query/explain
//!   POST /api/connections/:id/query/insights
//!   POST /api/connections/:id/query/estimate
//!   POST /api/connections/:id/query/plan-capture
//!   GET  /api/connections/:id/query/plan-history/:shapeHash
//!   GET  /api/connections/:id/query/plan-regressions
//!   GET  /api/connections/:id/query/plan-diff
//!
//! Deliberately NOT ported (they fall through to the strangler proxy â†’ v1):
//!   POST /query/transpile          â€” v1 round-trips the SQL through
//!       node-sql-parser's AST (astify in the source dialect, sqlify in the
//!       target). There is no equivalent parser among v2's dependencies and
//!       adding one is out of scope, so a port could only be a regex
//!       approximation â€” exactly the "silently-wrong SQL" the v1 service is
//!       written to avoid.
//!
//! Also NOT here, but ported elsewhere:
//!   POST /query/cursor, /query/cursor/:cursorId/{fetch,close}
//!       â€” server-side cursors keep live per-cursor sessions (open READ ONLY
//!       transaction + reaper + global cap) in a process-local map, so they sit
//!       with the CSV import sessions in `src/importer.rs`.
//!
//! Notes on faithfulness:
//!   * Prisma has no `@map`, so every identifier below is the exact quoted
//!     PascalCase/camelCase name (`"PlanSnapshot"."connectionId"`), and
//!     `DateTime` columns are `TIMESTAMP(3)` *without* time zone â†’ they decode
//!     as `chrono::NaiveDateTime` (via `crate::iso`), never `DateTime<Utc>`.
//!   * Non-Postgres dialects (and a missing ENCRYPTION_KEY / agent-tunnelled
//!     connections) forward to v1 rather than erroring â€” v2 has no MySQL /
//!     SQLite / MSSQL driver, and v1's explain service does support them.
//!   * v1 runs EXPLAIN through the OWNER driver, which applies the connection's
//!     `statementTimeoutMs` and sets the session READ ONLY when the connection
//!     is marked read-only; both are reproduced. `mode=analyze` really executes
//!     the statement, so â€” like v1 â€” it is wrapped in a transaction that is
//!     always rolled back (v1 only wraps mutations; wrapping unconditionally is
//!     identical for reads and strictly safer for anything misclassified).

use std::collections::{HashMap, HashSet};

use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request, State},
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{PgConnection, PgPool, Row};

use crate::{conn_role, connect_target, gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

/// Every ported query-tool route, at its full v1 path (Nest sets a global `api`
/// prefix, so `@Controller('connections/:id/query')` serves
/// `/api/connections/:id/query`). The `:id` parameter name must match the one
/// main.rs already uses for `/api/connections/:id/...` or axum's router panics
/// on the conflicting capture name.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connections/:id/query/explain", post(explain_route))
        .route("/api/connections/:id/query/insights", post(insights_route))
        .route("/api/connections/:id/query/estimate", post(estimate_route))
        .route("/api/connections/:id/query/plan-capture", post(plan_capture_route))
        .route(
            "/api/connections/:id/query/plan-history/:shapeHash",
            get(plan_history_route),
        )
        .route("/api/connections/:id/query/plan-regressions", get(plan_regressions_route))
        .route("/api/connections/:id/query/plan-diff", get(plan_diff_route))
}

// ---------------------------------------------------------------------------
// Thresholds â€” copied verbatim from the v1 services.
// ---------------------------------------------------------------------------

/// explain.service.ts
const HIGH_COST: f64 = 10_000.0;
const HIGH_ROWS: f64 = 10_000.0;
const WAY_OFF_ESTIMATE_RATIO: f64 = 10.0;

/// perf-insights.service.ts
const SEQ_SCAN_ROW_THRESHOLD: f64 = 1_000.0;

/// query-cost.service.ts
const MS_PER_ROW_SCANNED: f64 = 0.0001;
const DANGEROUS_ROWS: f64 = 50_000_000.0;
const SLOW_ROWS: f64 = 5_000_000.0;
const MODERATE_ROWS: f64 = 500_000.0;

/// plan-regression.service.ts
const COST_REGRESSION_RATIO: f64 = 4.0;

/// Join strategies tracked in the structural fingerprint.
const JOIN_TYPES: [&str; 3] = ["Nested Loop", "Hash Join", "Merge Join"];

/// Scan strategies ranked best â†’ worst; a drop in rank is a regression signal.
/// Includes MySQL access types mapped onto the same ladder (v1 keeps them in one
/// object, and plans captured from a MySQL connection go through v1 anyway).
fn scan_rank(node_type: &str) -> Option<i32> {
    Some(match node_type {
        "Index Only Scan" => 0,
        "Index Scan" => 1,
        "Bitmap Heap Scan" => 2,
        "Bitmap Index Scan" => 2,
        "Tile Scan" => 3,
        "Seq Scan" => 4,
        "const" => 0,
        "eq_ref" => 0,
        "ref" => 1,
        "range" => 2,
        "index" => 3,
        "ALL" => 4,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

fn dberr(e: sqlx::Error) -> ApiError {
    ApiError::internal(e.to_string())
}

/// `RbacService.require` â€” VIEWER is the floor for every route here, so the rank
/// check never rejects, but the not-found / no-access split must match v1.
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

fn role_rank(role: &str) -> i32 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        _ => 1,
    }
}

/// The bits of `Connection` these routes need.
struct ConnMeta {
    dialect: String,
    read_only: bool,
    statement_timeout_ms: i32,
    via_agent: bool,
}

async fn load_conn_meta(state: &AppState, id: &str) -> ApiResult<Option<ConnMeta>> {
    let row = sqlx::query(
        r#"SELECT "dialect"::text AS dialect, "readOnly", "statementTimeoutMs", "viaAgent"
             FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(r) = row else { return Ok(None) };
    Ok(Some(ConnMeta {
        dialect: r.try_get::<String, _>("dialect").map_err(dberr)?,
        read_only: r.try_get::<bool, _>("readOnly").map_err(dberr)?,
        statement_timeout_ms: r.try_get::<i32, _>("statementTimeoutMs").unwrap_or(30_000),
        via_agent: r.try_get::<bool, _>("viaAgent").unwrap_or(false),
    }))
}

impl ConnMeta {
    /// Anything v2 cannot execute faithfully goes to the v1 Node API instead of
    /// failing: the agent tunnel and the non-Postgres drivers live only there,
    /// and without ENCRYPTION_KEY we cannot reach a target database at all.
    fn must_proxy(&self, state: &AppState) -> bool {
        // viaAgent handled by agent_guard (live presence) + connect_target.
        !self.dialect.to_lowercase().contains("postgres") || state.crypto.is_none()
    }
}

/// Open the target database the way v1's driver does per checkout: the
/// connection's statement timeout, plus a READ ONLY session when the connection
/// is flagged read-only (`buildDriverForRole(id, OWNER)` â†’ `readOnly` defaults
/// to the connection's own setting).
async fn open_target(state: &AppState, id: &str, user_id: &str, meta: &ConnMeta) -> ApiResult<crate::TargetConn> {
    let mut c = connect_target(state, id, user_id).await?;
    let _ = sqlx::query(&format!("SET statement_timeout = {}", meta.statement_timeout_ms))
        .execute(&mut *c)
        .await;
    if meta.read_only {
        let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
            .execute(&mut *c)
            .await;
    }
    Ok(c)
}

/// `JSON.stringify` of a JS number: integers print without a `.0`, and
/// NaN/Infinity become `null`.
fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9_007_199_254_740_992.0 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn opt_num(x: Option<f64>) -> Value {
    x.map(num).unwrap_or(Value::Null)
}

/// `Number.prototype.toFixed` â€” rounds half away from zero, unlike Rust's
/// round-half-to-even formatting.
fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return format!("{x}");
    }
    let m = 10f64.powi(digits as i32);
    let r = (x * m).round() / m;
    format!("{r:.digits$}")
}

/// `sql.replace(/;\s*$/, '')` â€” drops a single trailing semicolon (and anything
/// blank after it), leaving the rest of the statement untouched.
fn strip_trailing_semicolon(sql: &str) -> String {
    let trimmed = sql.trim_end_matches(is_js_ws);
    match trimmed.strip_suffix(';') {
        Some(rest) => rest.to_string(),
        None => sql.to_string(),
    }
}

/// `String.prototype.slice(0, n)` â€” n is a code-unit count in JS; using chars
/// keeps us on a valid boundary and matches for everything but astral planes.
fn slice_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

fn is_js_ws(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// JS truthiness for a JSON value (`undefined`/`null`/`false`/`0`/`""`).
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `String(v)` for the plan-JSON values we read.
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(|f| format!("{}", num(f))).unwrap_or_else(|| n.to_string()),
        other => other.to_string(),
    }
}

/// `typeof x === 'number' ? x : undefined`.
fn plan_num(plan: &Value, key: &str) -> Option<f64> {
    plan.get(key).and_then(|v| v.as_f64())
}

// ---------------------------------------------------------------------------
// SHA-1 (v1 fingerprints shapes and plans with `createHash('sha1')`; the digest
// has to match byte-for-byte or plan history stops lining up with the slow-query
// history that shares the scheme). No sha1 crate is available and Cargo.toml is
// off-limits, so it is implemented here â€” verified against the RFC 3174 vectors.
// ---------------------------------------------------------------------------

fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 80];
    for chunk in msg.chunks_exact(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = String::with_capacity(40);
    for v in h.iter() {
        out.push_str(&format!("{v:08x}"));
    }
    out
}

/// `createHash('sha1').update(x).digest('hex').slice(0, 24)`.
fn short_sha1(s: &str) -> String {
    sha1_hex(s.as_bytes()).chars().take(24).collect()
}

// ---------------------------------------------------------------------------
// normalizeSql â€” port of slow-query.service.ts. The shape hash derived from it
// is the join key between plan snapshots and slow-query groups, so each pass is
// a separate left-to-right scan, exactly like the chained `String.replace`
// calls it mirrors.
// ---------------------------------------------------------------------------

fn normalize_sql(sql: &str) -> String {
    let s = strip_block_comments(sql);
    let s = strip_line_comments(&s);
    let s = collapse_quoted(&s, '\'', "?");
    let s = collapse_quoted(&s, '"', "?");
    let s = collapse_numbers(&s);
    let s = collapse_in_lists(&s);
    let s = collapse_values_lists(&s);
    let s = collapse_whitespace(&s);
    let s = s.trim_matches(is_js_ws).to_string();
    s.trim_end_matches(';').to_string()
}

/// `/\/\*[\s\S]*?\*\//g` â†’ ' ' (an unterminated `/*` is left alone).
fn strip_block_comments(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '/' && i + 1 < c.len() && c[i + 1] == '*' {
            let mut j = i + 2;
            let mut end = None;
            while j + 1 < c.len() {
                if c[j] == '*' && c[j + 1] == '/' {
                    end = Some(j + 2);
                    break;
                }
                j += 1;
            }
            if let Some(e) = end {
                out.push(' ');
                i = e;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// `/--[^\n]*/g` â†’ ' '.
fn strip_line_comments(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] == '-' && i + 1 < c.len() && c[i + 1] == '-' {
            out.push(' ');
            i += 2;
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// `/'(?:[^']|'')*'/g` (and the `"` twin) â†’ `replacement`.
///
/// The greedy repetition prefers the `''` escape but backtracks to treat that
/// first quote as the terminator when the literal would otherwise run off the
/// end of the string â€” so `'a''` matches `'a'` and leaves a dangling quote,
/// which is what the JS engine does.
fn collapse_quoted(s: &str, q: char, replacement: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if c[i] != q {
            out.push(c[i]);
            i += 1;
            continue;
        }
        // Walk the body, remembering every `''` we consumed as a backtrack point.
        let mut j = i + 1;
        let mut escapes: Vec<usize> = Vec::new();
        let mut close: Option<usize> = None;
        while j < c.len() {
            if c[j] == q {
                if j + 1 < c.len() && c[j + 1] == q {
                    escapes.push(j);
                    j += 2;
                    continue;
                }
                close = Some(j);
                break;
            }
            j += 1;
        }
        let close = close.or_else(|| escapes.pop());
        match close {
            Some(end) => {
                out.push_str(replacement);
                i = end + 1;
            }
            None => {
                out.push(c[i]);
                i += 1;
            }
        }
    }
    out
}

/// `/(?<![A-Za-z0-9_])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g` â†’ '?'.
fn collapse_numbers(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        let lookbehind_ok = i == 0 || !is_word_char(c[i - 1]);
        if lookbehind_ok {
            if let Some(end) = match_number(&c, i) {
                out.push('?');
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn match_number(c: &[char], start: usize) -> Option<usize> {
    let mut k = start;
    if k < c.len() && c[k] == '-' {
        k += 1;
    }
    let digits_start = k;
    while k < c.len() && c[k].is_ascii_digit() {
        k += 1;
    }
    if k == digits_start {
        return None;
    }
    // (?:\.\d+)?
    if k + 1 < c.len() && c[k] == '.' && c[k + 1].is_ascii_digit() {
        k += 1;
        while k < c.len() && c[k].is_ascii_digit() {
            k += 1;
        }
    }
    // (?:[eE][+-]?\d+)?
    if k < c.len() && (c[k] == 'e' || c[k] == 'E') {
        let mut m = k + 1;
        if m < c.len() && (c[m] == '+' || c[m] == '-') {
            m += 1;
        }
        if m < c.len() && c[m].is_ascii_digit() {
            while m < c.len() && c[m].is_ascii_digit() {
                m += 1;
            }
            k = m;
        }
    }
    Some(k)
}

/// `/\bin\s*\(\s*(?:\?\s*,\s*)+\?\s*\)/gi` â†’ 'IN (?)'.
fn collapse_in_lists(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if (i == 0 || !is_word_char(c[i - 1])) && kw_at(&c, i, "in") {
            if let Some(end) = match_in_list(&c, i + 2) {
                out.push_str("IN (?)");
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

/// After `in`: `\s*\(\s*(?:\?\s*,\s*)+\?\s*\)`.
fn match_in_list(c: &[char], start: usize) -> Option<usize> {
    let mut k = skip_ws(c, start);
    if k >= c.len() || c[k] != '(' {
        return None;
    }
    k = skip_ws(c, k + 1);
    let mut placeholders = 0;
    loop {
        if k >= c.len() || c[k] != '?' {
            return None;
        }
        placeholders += 1;
        k = skip_ws(c, k + 1);
        if k < c.len() && c[k] == ',' {
            k = skip_ws(c, k + 1);
            continue;
        }
        break;
    }
    if placeholders < 2 || k >= c.len() || c[k] != ')' {
        return None;
    }
    Some(k + 1)
}

/// `/\bvalues\s*(?:\(\s*(?:\?\s*,\s*)*\?\s*\)\s*,\s*)+\(\s*(?:\?\s*,\s*)*\?\s*\)/gi`
/// â†’ 'VALUES (?)'.
fn collapse_values_lists(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < c.len() {
        if (i == 0 || !is_word_char(c[i - 1])) && kw_at(&c, i, "values") {
            if let Some(end) = match_values_lists(&c, i + 6) {
                out.push_str("VALUES (?)");
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

fn match_values_lists(c: &[char], start: usize) -> Option<usize> {
    let mut k = skip_ws(c, start);
    let mut tuples = 0;
    let mut last_end;
    loop {
        let Some(after) = match_placeholder_tuple(c, k) else {
            return None;
        };
        tuples += 1;
        last_end = after;
        let comma = skip_ws(c, after);
        if comma < c.len() && c[comma] == ',' {
            k = skip_ws(c, comma + 1);
            continue;
        }
        break;
    }
    if tuples < 2 {
        return None;
    }
    Some(last_end)
}

/// `\(\s*(?:\?\s*,\s*)*\?\s*\)`
fn match_placeholder_tuple(c: &[char], start: usize) -> Option<usize> {
    if start >= c.len() || c[start] != '(' {
        return None;
    }
    let mut k = skip_ws(c, start + 1);
    loop {
        if k >= c.len() || c[k] != '?' {
            return None;
        }
        k = skip_ws(c, k + 1);
        if k < c.len() && c[k] == ',' {
            k = skip_ws(c, k + 1);
            continue;
        }
        break;
    }
    if k >= c.len() || c[k] != ')' {
        return None;
    }
    Some(k + 1)
}

fn skip_ws(c: &[char], mut i: usize) -> usize {
    while i < c.len() && is_js_ws(c[i]) {
        i += 1;
    }
    i
}

/// Case-insensitive literal match of `kw` at `i`.
fn kw_at(c: &[char], i: usize, kw: &str) -> bool {
    let k: Vec<char> = kw.chars().collect();
    if i + k.len() > c.len() {
        return false;
    }
    for (n, kc) in k.iter().enumerate() {
        if !c[i + n].eq_ignore_ascii_case(kc) {
            return false;
        }
    }
    true
}

/// `/\s+/g` â†’ ' '.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_ws = false;
    for ch in s.chars() {
        if is_js_ws(ch) {
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

// ---------------------------------------------------------------------------
// EXPLAIN â€” explain.service.ts (Postgres branch; other dialects proxy to v1)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Warning {
    severity: &'static str,
    message: String,
    node_path: Option<String>,
}

#[derive(Clone)]
struct PlanNodeRs {
    id: String,
    parent_id: Option<String>,
    depth: i64,
    label: String,
    node_type: String,
    relation: Option<String>,
    total_cost: Option<f64>,
    startup_cost: Option<f64>,
    plan_rows: Option<f64>,
    actual_rows: Option<f64>,
    actual_total_ms: Option<f64>,
    warnings: Vec<Warning>,
}

struct ExplainOut {
    mode: String,
    raw: Value,
    nodes: Vec<PlanNodeRs>,
    warnings: Vec<Warning>,
    total_cost: Option<f64>,
    total_time_ms: Option<f64>,
    plan_time_ms: Option<f64>,
    execution_time_ms: Option<f64>,
}

fn warning_json(w: &Warning) -> Value {
    let mut m = Map::new();
    m.insert("severity".into(), json!(w.severity));
    m.insert("message".into(), json!(w.message));
    if let Some(p) = &w.node_path {
        m.insert("nodePath".into(), json!(p));
    }
    Value::Object(m)
}

/// Keys v1 leaves `undefined` are omitted, because `JSON.stringify` drops them.
fn node_json(n: &PlanNodeRs) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(n.id));
    m.insert(
        "parentId".into(),
        n.parent_id.as_ref().map(|p| json!(p)).unwrap_or(Value::Null),
    );
    m.insert("depth".into(), json!(n.depth));
    m.insert("label".into(), json!(n.label));
    m.insert("nodeType".into(), json!(n.node_type));
    if let Some(r) = &n.relation {
        m.insert("relation".into(), json!(r));
    }
    if let Some(v) = n.total_cost {
        m.insert("totalCost".into(), num(v));
    }
    if let Some(v) = n.startup_cost {
        m.insert("startupCost".into(), num(v));
    }
    if let Some(v) = n.plan_rows {
        m.insert("planRows".into(), num(v));
    }
    if let Some(v) = n.actual_rows {
        m.insert("actualRows".into(), num(v));
    }
    if let Some(v) = n.actual_total_ms {
        m.insert("actualTotalMs".into(), num(v));
    }
    m.insert(
        "warnings".into(),
        Value::Array(n.warnings.iter().map(warning_json).collect()),
    );
    Value::Object(m)
}

fn explain_json(e: &ExplainOut) -> Value {
    let mut m = Map::new();
    m.insert("dialect".into(), json!("POSTGRES"));
    m.insert("mode".into(), json!(e.mode));
    m.insert("raw".into(), e.raw.clone());
    m.insert("nodes".into(), Value::Array(e.nodes.iter().map(node_json).collect()));
    m.insert(
        "warnings".into(),
        Value::Array(e.warnings.iter().map(warning_json).collect()),
    );
    if let Some(v) = e.total_cost {
        m.insert("totalCost".into(), num(v));
    }
    if let Some(v) = e.plan_time_ms {
        m.insert("planTimeMs".into(), num(v));
    }
    if let Some(v) = e.execution_time_ms {
        m.insert("executionTimeMs".into(), num(v));
    }
    if let Some(v) = e.total_time_ms {
        m.insert("totalTimeMs".into(), num(v));
    }
    Value::Object(m)
}

/// `ExplainService.explain` for Postgres.
async fn explain_postgres(c: &mut PgConnection, sql: &str, mode: &str) -> ApiResult<ExplainOut> {
    let mut opts = vec!["FORMAT JSON", "VERBOSE FALSE", "SETTINGS FALSE"];
    if mode == "analyze" {
        opts.push("ANALYZE TRUE");
        opts.push("BUFFERS TRUE");
    }
    let explain_sql = format!("EXPLAIN ({}) {}", opts.join(", "), strip_trailing_semicolon(sql));

    // `analyze` really runs the statement. v1 wraps mutations in BEGIN/ROLLBACK
    // so nothing persists; wrapping unconditionally is identical for a read and
    // removes the dependence on classifying the statement correctly first.
    let row = if mode == "analyze" {
        sqlx::query("BEGIN").execute(&mut *c).await?;
        let r = sqlx::query(&explain_sql).fetch_one(&mut *c).await;
        let _ = sqlx::query("ROLLBACK").execute(&mut *c).await;
        r?
    } else {
        sqlx::query(&explain_sql).fetch_one(&mut *c).await?
    };

    // `EXPLAIN (FORMAT JSON)` describes its single "QUERY PLAN" column as json,
    // but accept text too in case a proxy/pooler rewrites the descriptor.
    let plan_col: Value = match row.try_get::<Value, _>(0) {
        Ok(v) => v,
        Err(_) => {
            let s: String = row.try_get(0).map_err(dberr)?;
            serde_json::from_str(&s).map_err(|e| ApiError::bad(format!("could not read EXPLAIN output: {e}")))?
        }
    };
    let plan_arr = match plan_col {
        Value::Array(a) => a,
        other => vec![other],
    };
    let top = plan_arr.first().cloned().unwrap_or(Value::Null);
    let root_plan = top.get("Plan").cloned();

    let mut nodes: Vec<PlanNodeRs> = Vec::new();
    let mut warnings: Vec<Warning> = Vec::new();
    if let Some(root) = root_plan.as_ref().filter(|v| v.is_object()) {
        walk_postgres(root, None, 0, &mut nodes, &mut warnings);
    }

    let plan_time = plan_num(&top, "Planning Time");
    let exec_time = plan_num(&top, "Execution Time");
    let total_time_ms = if plan_time.is_some() || exec_time.is_some() {
        Some(plan_time.unwrap_or(0.0) + exec_time.unwrap_or(0.0))
    } else {
        None
    };

    Ok(ExplainOut {
        mode: mode.to_string(),
        raw: Value::Array(plan_arr),
        total_cost: nodes.first().and_then(|n| n.total_cost),
        nodes,
        warnings,
        plan_time_ms: plan_time,
        execution_time_ms: exec_time,
        total_time_ms,
    })
}

fn walk_postgres(
    plan: &Value,
    parent_id: Option<String>,
    depth: i64,
    out: &mut Vec<PlanNodeRs>,
    warnings: &mut Vec<Warning>,
) {
    let id = format!("n{}", out.len());
    let node_type = plan
        .get("Node Type")
        .filter(|v| !v.is_null())
        .map(js_string)
        .unwrap_or_else(|| "Unknown".into());
    let relation = plan
        .get("Relation Name")
        .filter(|v| truthy(v))
        .map(js_string);
    let total_cost = plan_num(plan, "Total Cost");
    let startup_cost = plan_num(plan, "Startup Cost");
    let plan_rows = plan_num(plan, "Plan Rows");
    let actual_rows = plan_num(plan, "Actual Rows");
    let actual_total_ms = plan_num(plan, "Actual Total Time");

    let label = match &relation {
        Some(r) => format!("{node_type} on {r}"),
        None => node_type.clone(),
    };
    let mut node_warnings: Vec<Warning> = Vec::new();

    // Sequential scan on something big.
    let rows_or_zero = actual_rows.or(plan_rows).unwrap_or(0.0);
    if node_type == "Seq Scan" && rows_or_zero > HIGH_ROWS {
        let seen = actual_rows.or(plan_rows).map(num).unwrap_or(Value::Null);
        node_warnings.push(Warning {
            severity: "warn",
            message: format!(
                "Sequential scan on {} reads {} rows â€” consider an index",
                relation.clone().unwrap_or_else(|| "table".into()),
                seen
            ),
            node_path: Some(label.clone()),
        });
    }
    // Expensive node overall.
    if let Some(tc) = total_cost {
        if tc > HIGH_COST {
            node_warnings.push(Warning {
                severity: "warn",
                message: format!("High planner cost on {label} ({})", to_fixed(tc, 0)),
                node_path: Some(label.clone()),
            });
        }
    }
    // Plan vs actual row estimate way off (ANALYZE only).
    if let (Some(pr), Some(ar)) = (plan_rows, actual_rows) {
        if ar > 0.0 {
            let ratio = pr.max(ar) / 1.0f64.max(pr.min(ar));
            if ratio > WAY_OFF_ESTIMATE_RATIO && ar > 1000.0 {
                node_warnings.push(Warning {
                    severity: "info",
                    message: format!(
                        "Row estimate off by {}Ã— on {label} (planned {}, got {}) â€” ANALYZE the table?",
                        to_fixed(ratio, 0),
                        num(pr),
                        num(ar)
                    ),
                    node_path: Some(label.clone()),
                });
            }
        }
    }
    // Nested loop over many rows on the outer side.
    if node_type == "Nested Loop" && rows_or_zero > 100_000.0 {
        let seen = actual_rows.or(plan_rows).map(num).unwrap_or(Value::Null);
        node_warnings.push(Warning {
            severity: "warn",
            message: format!("Nested Loop with {seen} rows â€” hash/merge join may be cheaper"),
            node_path: Some(label.clone()),
        });
    }

    warnings.extend(node_warnings.iter().cloned());
    out.push(PlanNodeRs {
        id: id.clone(),
        parent_id,
        depth,
        label,
        node_type,
        relation,
        total_cost,
        startup_cost,
        plan_rows,
        actual_rows,
        actual_total_ms,
        warnings: node_warnings,
    });

    if let Some(children) = plan.get("Plans").and_then(|v| v.as_array()) {
        for child in children {
            walk_postgres(child, Some(id.clone()), depth + 1, out, warnings);
        }
    }
}

// ---------------------------------------------------------------------------
// Perf insights â€” perf-insights.service.ts
// ---------------------------------------------------------------------------

struct Predicate {
    table: String,
    column: String,
}

fn insights_json(dialect: &str, sql: &str, plan: &ExplainOut) -> Value {
    let findings: Vec<Value> = plan
        .warnings
        .iter()
        .map(|w| {
            let mut m = Map::new();
            m.insert("severity".into(), json!(w.severity));
            m.insert("title".into(), json!(derive_title(&w.message)));
            m.insert("detail".into(), json!(w.message));
            if let Some(p) = &w.node_path {
                m.insert("nodePath".into(), json!(p));
            }
            Value::Object(m)
        })
        .collect();

    let predicates = extract_predicates(sql);
    let mut suggestions: Vec<Value> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    for node in &plan.nodes {
        if !is_sequential_scan(&node.node_type) {
            continue;
        }
        if node.actual_rows.or(node.plan_rows).unwrap_or(0.0) < SEQ_SCAN_ROW_THRESHOLD {
            continue;
        }
        let Some(relation) = node.relation.as_ref() else { continue };
        let rel_lower = relation.to_lowercase();
        let matched: Vec<&Predicate> = predicates
            .iter()
            .filter(|p| rel_lower.ends_with(&p.table.to_lowercase()) || p.table.is_empty())
            .collect();
        if matched.is_empty() {
            continue;
        }
        let cols = dedupe(matched.iter().map(|m| m.column.clone()).collect());
        if cols.is_empty() {
            continue;
        }
        let key = format!("{relation}:{}", cols.join(","));
        if seen_keys.contains(&key) {
            continue;
        }
        seen_keys.insert(key);
        let impact = node.actual_rows.or(node.plan_rows);
        let scanned = impact.map(|v| format!("{}", num(v))).unwrap_or_else(|| "?".into());
        let mut m = Map::new();
        m.insert("table".into(), json!(relation));
        m.insert("columns".into(), json!(cols));
        m.insert(
            "reason".into(),
            json!(format!(
                "Sequential scan on {relation} filtered by {} â€” estimated {scanned} rows scanned.",
                cols.join(", ")
            )),
        );
        m.insert("sql".into(), json!(render_create_index(dialect, relation, &cols)));
        if let Some(v) = impact {
            m.insert("impact".into(), num(v));
        }
        suggestions.push(Value::Object(m));
    }

    let mut out = Map::new();
    out.insert("dialect".into(), json!(dialect));
    out.insert("findings".into(), Value::Array(findings));
    out.insert("suggestions".into(), Value::Array(suggestions));
    out.insert(
        "plan".into(),
        Value::Array(plan.nodes.iter().map(node_json).collect()),
    );
    if let Some(v) = plan.total_cost {
        out.insert("totalCost".into(), num(v));
    }
    if let Some(v) = plan.total_time_ms {
        out.insert("totalTimeMs".into(), num(v));
    }
    Value::Object(out)
}

/// `msg.split(/[.â€”â€“]/)[0]`, truncated to 80 chars with an ellipsis.
fn derive_title(msg: &str) -> String {
    let first: String = msg.chars().take_while(|c| *c != '.' && *c != '\u{2014}' && *c != '\u{2013}').collect();
    if first.chars().count() > 80 {
        format!("{}â€¦", slice_chars(&first, 77))
    } else {
        first
    }
}

fn is_sequential_scan(node_type: &str) -> bool {
    let t = node_type.to_lowercase();
    t.contains("seq scan") || t.contains("table scan") || t == "full" || t == "all"
}

fn dedupe(items: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for x in items {
        if seen.contains(&x) {
            continue;
        }
        seen.insert(x.clone());
        out.push(x);
    }
    out
}

/// Port of `extractPredicates`: strip comments and string/identifier literals,
/// then pull `table.column OP` pairs out of every WHERE / ON clause.
fn extract_predicates(sql: &str) -> Vec<Predicate> {
    let cleaned = strip_line_comments(sql);
    let cleaned = strip_block_comments(&cleaned);
    let cleaned = collapse_quoted(&cleaned, '\'', "'?'");
    let cleaned = collapse_quoted(&cleaned, '"', "\"?\"");
    let c: Vec<char> = cleaned.chars().collect();

    let mut out: Vec<Predicate> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let boundary_before = i == 0 || !is_word_char(c[i - 1]);
        let kw_len = if boundary_before && kw_at(&c, i, "where") && word_boundary_after(&c, i + 5) {
            Some(5)
        } else if boundary_before && kw_at(&c, i, "on") && word_boundary_after(&c, i + 2) {
            Some(2)
        } else {
            None
        };
        let Some(kw_len) = kw_len else {
            i += 1;
            continue;
        };
        // `[\s\S]+?` up to the first position where the terminator lookahead hits.
        let body_start = i + kw_len;
        let mut end = None;
        let mut p = body_start + 1;
        while p <= c.len() {
            if clause_terminator(&c, p) {
                end = Some(p);
                break;
            }
            p += 1;
        }
        let Some(end) = end else {
            i += 1;
            continue;
        };
        collect_predicates(&c[body_start..end], &mut out);
        i = end.max(i + 1);
    }
    out
}

/// The lookahead `(?=\b(?:group|order|limit|having|join|union|select|$)\b|\)|\s*$)`.
fn clause_terminator(c: &[char], p: usize) -> bool {
    if p < c.len() && c[p] == ')' {
        return true;
    }
    // `\s*$` â€” only whitespace left (this also covers end-of-string).
    if c[p.min(c.len())..].iter().all(|ch| is_js_ws(*ch)) {
        return true;
    }
    if p > 0 && is_word_char(c[p - 1]) {
        return false; // no `\b` before the keyword
    }
    for kw in ["group", "order", "limit", "having", "join", "union", "select"] {
        if kw_at(c, p, kw) && word_boundary_after(c, p + kw.chars().count()) {
            return true;
        }
    }
    false
}

fn word_boundary_after(c: &[char], p: usize) -> bool {
    p >= c.len() || !is_word_char(c[p])
}

/// `/\b(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*(=|<>|!=|>=|<=|>|<|\bIN\b|\bLIKE\b)/gi`
fn collect_predicates(body: &[char], out: &mut Vec<Predicate>) {
    const SKIP: [&str; 6] = ["and", "or", "not", "true", "false", "null"];
    let mut i = 0;
    while i < body.len() {
        if i > 0 && is_word_char(body[i - 1]) {
            i += 1;
            continue;
        }
        // Greedy: try `table.column` first, then bare `column`.
        let mut hit: Option<(String, String, usize)> = None;
        if let Some((table, after_table)) = match_ident(body, i) {
            if after_table < body.len() && body[after_table] == '.' {
                if let Some((column, after_col)) = match_ident(body, after_table + 1) {
                    if let Some(end) = match_operator(body, skip_ws(body, after_col)) {
                        hit = Some((table.clone(), column, end));
                    }
                }
            }
        }
        if hit.is_none() {
            if let Some((column, after_col)) = match_ident(body, i) {
                if let Some(end) = match_operator(body, skip_ws(body, after_col)) {
                    hit = Some((String::new(), column, end));
                }
            }
        }
        match hit {
            Some((table, column, end)) => {
                let column = column.to_lowercase();
                if !SKIP.contains(&column.as_str()) {
                    out.push(Predicate {
                        table: table.to_lowercase(),
                        column,
                    });
                }
                i = end;
            }
            None => i += 1,
        }
    }
}

/// `[A-Za-z_][A-Za-z0-9_]*`
fn match_ident(c: &[char], start: usize) -> Option<(String, usize)> {
    if start >= c.len() || !(c[start].is_ascii_alphabetic() || c[start] == '_') {
        return None;
    }
    let mut k = start + 1;
    while k < c.len() && is_word_char(c[k]) {
        k += 1;
    }
    Some((c[start..k].iter().collect(), k))
}

/// `(=|<>|!=|>=|<=|>|<|\bIN\b|\bLIKE\b)` â€” alternation order matters (`>=`
/// before `>`), and the word operators need boundaries on both sides.
fn match_operator(c: &[char], p: usize) -> Option<usize> {
    if p >= c.len() {
        return None;
    }
    for op in ["=", "<>", "!=", ">=", "<=", ">", "<"] {
        if kw_at(c, p, op) {
            return Some(p + op.len());
        }
    }
    if p > 0 && is_word_char(c[p - 1]) {
        return None;
    }
    for kw in ["in", "like"] {
        let n = kw.len();
        if kw_at(c, p, kw) && word_boundary_after(c, p + n) {
            return Some(p + n);
        }
    }
    None
}

fn render_create_index(dialect: &str, relation: &str, columns: &[String]) -> String {
    let idx_name = slice_chars(
        &format!("idx_{}_{}", relation.replace('.', "_"), columns.join("_")),
        60,
    );
    let q_table = quote_qualified(relation, dialect);
    let q_cols = columns
        .iter()
        .map(|c| quote_ident(c, dialect))
        .collect::<Vec<_>>()
        .join(", ");
    let q_idx = quote_ident(&idx_name, dialect);
    if dialect == "POSTGRES" {
        format!("CREATE INDEX CONCURRENTLY {q_idx} ON {q_table} ({q_cols});")
    } else {
        format!("CREATE INDEX {q_idx} ON {q_table} ({q_cols});")
    }
}

fn quote_ident(name: &str, dialect: &str) -> String {
    match dialect {
        "MYSQL" => format!("`{}`", name.replace('`', "``")),
        "MSSQL" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn quote_qualified(relation: &str, dialect: &str) -> String {
    if !relation.contains('.') {
        return quote_ident(relation, dialect);
    }
    relation
        .split('.')
        .map(|p| quote_ident(p, dialect))
        .collect::<Vec<_>>()
        .join(".")
}

// ---------------------------------------------------------------------------
// Cost estimate â€” query-cost.service.ts
// ---------------------------------------------------------------------------

fn estimate_json(plan: &ExplainOut) -> Value {
    let rows_scanned: f64 = plan.nodes.iter().map(|n| n.plan_rows.unwrap_or(0.0)).sum();
    let planner_cost = plan.total_cost;

    let mut warnings: Vec<String> = Vec::new();
    if rows_scanned > DANGEROUS_ROWS {
        warnings.push("Query may scan tens of millions of rows â€” consider an index or a LIMIT.".into());
    } else if rows_scanned > SLOW_ROWS {
        warnings.push(format!(
            "Query will scan ~{} rows. That's a lot â€” expect slow response.",
            fmt_rows(rows_scanned)
        ));
    }
    for node in &plan.nodes {
        let t = node.node_type.to_lowercase();
        let seq_like = t.contains("seq scan") || t.contains("seqscan") || t.contains("full scan") || t.contains("table scan");
        if seq_like && node.plan_rows.unwrap_or(0.0) > 10_000.0 {
            warnings.push(format!(
                "Sequential scan on {} with ~{} rows.",
                node.relation.clone().unwrap_or_else(|| "a table".into()),
                fmt_rows(node.plan_rows.unwrap_or(0.0))
            ));
            break; // one warning is enough
        }
    }

    let verdict = if rows_scanned > DANGEROUS_ROWS {
        "dangerous"
    } else if rows_scanned > SLOW_ROWS {
        "slow"
    } else if rows_scanned > MODERATE_ROWS {
        "moderate"
    } else {
        "fast"
    };

    json!({
        "estimatedRowsScanned": num(rows_scanned),
        "plannerCost": opt_num(planner_cost),
        "estimatedDurationMs": num((rows_scanned * MS_PER_ROW_SCANNED).round()),
        "verdict": verdict,
        "warnings": warnings,
    })
}

fn fmt_rows(n: f64) -> String {
    if n >= 1_000_000_000.0 {
        format!("{}B", to_fixed(n / 1_000_000_000.0, 1))
    } else if n >= 1_000_000.0 {
        format!("{}M", to_fixed(n / 1_000_000.0, 1))
    } else if n >= 1_000.0 {
        format!("{}K", to_fixed(n / 1_000.0, 1))
    } else {
        format!("{}", num(n.round()))
    }
}

// ---------------------------------------------------------------------------
// Plan regression â€” plan-regression.service.ts
// ---------------------------------------------------------------------------

struct PlanScan {
    node_type: String,
    relation: Option<String>,
}

fn extract_scans(nodes: &[PlanNodeRs]) -> Vec<PlanScan> {
    nodes
        .iter()
        .filter(|n| n.node_type.to_lowercase().contains("scan") || JOIN_TYPES.contains(&n.node_type.as_str()))
        .map(|n| PlanScan {
            node_type: n.node_type.clone(),
            relation: n.relation.clone(),
        })
        .collect()
}

fn scans_json(scans: &[PlanScan]) -> Value {
    Value::Array(
        scans
            .iter()
            .map(|s| {
                json!({
                    "nodeType": s.node_type,
                    "relation": s.relation.clone().map(Value::String).unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

fn scans_from_json(v: &Value) -> Vec<PlanScan> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| PlanScan {
                    node_type: s
                        .get("nodeType")
                        .filter(|x| !x.is_null())
                        .map(js_string)
                        .unwrap_or_default(),
                    relation: s.get("relation").filter(|x| truthy(x)).map(js_string),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Stable structural fingerprint: the sequence of (nodeType, relation) pairs.
fn fingerprint(scans: &[PlanScan]) -> String {
    let sig = scans
        .iter()
        .map(|s| format!("{}@{}", s.node_type, s.relation.clone().unwrap_or_else(|| "*".into())))
        .collect::<Vec<_>>()
        .join("|");
    short_sha1(&sig)
}

fn summarize(scans: &[PlanScan]) -> String {
    if scans.is_empty() {
        return "(no scans)".into();
    }
    let joined = scans
        .iter()
        .map(|s| match &s.relation {
            Some(r) => format!("{} on {}", s.node_type, r),
            None => s.node_type.clone(),
        })
        .collect::<Vec<_>>()
        .join("; ");
    slice_chars(&joined, 500)
}

fn detect_regression(
    prev: Option<(&[PlanScan], Option<f64>)>,
    next_scans: &[PlanScan],
    next_cost: Option<f64>,
) -> Option<String> {
    let (prev_scans, prev_cost) = prev?;
    let mut reasons: Vec<String> = Vec::new();

    // 1) Scan strategy downgrade on a relation present in both plans.
    let mut prev_by_rel: HashMap<String, String> = HashMap::new();
    for s in prev_scans {
        if let Some(r) = s.relation.as_ref().filter(|r| !r.is_empty()) {
            prev_by_rel.insert(r.clone(), s.node_type.clone());
        }
    }
    for s in next_scans {
        let Some(rel) = s.relation.as_ref().filter(|r| !r.is_empty()) else { continue };
        let Some(before) = prev_by_rel.get(rel) else { continue };
        if before == &s.node_type {
            continue;
        }
        if let (Some(before_rank), Some(after_rank)) = (scan_rank(before), scan_rank(&s.node_type)) {
            if after_rank > before_rank {
                reasons.push(format!("{rel}: {before} â†’ {}", s.node_type));
            }
        }
    }

    // 2) Join strategy change to Nested Loop.
    let prev_joins: Vec<String> = prev_scans
        .iter()
        .filter(|s| JOIN_TYPES.contains(&s.node_type.as_str()))
        .map(|s| s.node_type.clone())
        .collect();
    let next_joins: Vec<String> = next_scans
        .iter()
        .filter(|s| JOIN_TYPES.contains(&s.node_type.as_str()))
        .map(|s| s.node_type.clone())
        .collect();
    if next_joins.iter().any(|j| j == "Nested Loop")
        && !prev_joins.iter().any(|j| j == "Nested Loop")
        && !prev_joins.is_empty()
    {
        reasons.push(format!("join switched to Nested Loop (was {})", prev_joins.join(", ")));
    }

    // 3) Large planner-cost jump even if structure looks similar.
    if let (Some(pc), Some(nc)) = (prev_cost, next_cost) {
        if pc > 0.0 && nc / pc >= COST_REGRESSION_RATIO {
            reasons.push(format!(
                "planner cost rose {}Ã— ({} â†’ {})",
                to_fixed(nc / pc, 1),
                to_fixed(pc, 0),
                to_fixed(nc, 0)
            ));
        }
    }

    if reasons.is_empty() {
        None
    } else {
        Some(reasons.join("; "))
    }
}

const SNAPSHOT_COLS: &str = r#""id","shapeHash","normalizedSql","exampleSql","planHash","planSummary","totalCost","totalTimeMs","scans","nodes","regressed","regressionNote","createdAt""#;

/// `PlanRegressionService.toSnapshot`.
fn snapshot_json(r: &sqlx::postgres::PgRow) -> ApiResult<Value> {
    let json_or_empty = |v: Value| if v.is_null() { json!([]) } else { v };
    Ok(json!({
        "id": r.try_get::<String, _>("id").map_err(dberr)?,
        "shapeHash": r.try_get::<String, _>("shapeHash").map_err(dberr)?,
        "normalizedSql": r.try_get::<String, _>("normalizedSql").map_err(dberr)?,
        "exampleSql": r.try_get::<String, _>("exampleSql").map_err(dberr)?,
        "planHash": r.try_get::<String, _>("planHash").map_err(dberr)?,
        "planSummary": r.try_get::<String, _>("planSummary").map_err(dberr)?,
        "totalCost": opt_num(r.try_get::<Option<f64>, _>("totalCost").map_err(dberr)?),
        "totalTimeMs": opt_num(r.try_get::<Option<f64>, _>("totalTimeMs").map_err(dberr)?),
        "scans": json_or_empty(r.try_get::<Value, _>("scans").map_err(dberr)?),
        "nodes": json_or_empty(r.try_get::<Value, _>("nodes").map_err(dberr)?),
        "regressed": r.try_get::<bool, _>("regressed").map_err(dberr)?,
        "regressionNote": r.try_get::<Option<String>, _>("regressionNote").map_err(dberr)?,
        "createdAt": iso(r, "createdAt"),
    }))
}

/// `PlanRegressionService.capture` â€” everything inside is fail-open at the call
/// site, so the caller turns any `Err` into "not captured".
async fn capture(
    state: &AppState,
    meta: &ConnMeta,
    connection_id: &str,
    sql: &str,
    user_id: &str,
) -> ApiResult<Option<Value>> {
    let normalized = slice_chars(&normalize_sql(sql), 4_000);
    if normalized.is_empty() {
        return Ok(None);
    }
    let shape_hash = short_sha1(&normalized);

    // EXPLAIN â€” plan only; capture must never run the query.
    let mut c = open_target(state, connection_id, user_id, meta).await?;
    let result = explain_postgres(&mut c, sql, "plan").await?;

    let scans = extract_scans(&result.nodes);
    let plan_hash = fingerprint(&scans);
    let plan_summary = summarize(&scans);
    let total_cost = result.total_cost;

    let prev_row = sqlx::query(
        r#"SELECT "planHash","scans","totalCost" FROM "PlanSnapshot"
            WHERE "connectionId" = $1 AND "shapeHash" = $2
            ORDER BY "createdAt" DESC LIMIT 1"#,
    )
    .bind(connection_id)
    .bind(&shape_hash)
    .fetch_optional(&state.pool)
    .await?;

    let prev: Option<(Vec<PlanScan>, Option<f64>)> = match &prev_row {
        Some(r) => Some((
            scans_from_json(&r.try_get::<Value, _>("scans").map_err(dberr)?),
            r.try_get::<Option<f64>, _>("totalCost").map_err(dberr)?,
        )),
        None => None,
    };
    let structurally_same = match &prev_row {
        Some(r) => r.try_get::<String, _>("planHash").map_err(dberr)? == plan_hash,
        None => false,
    };
    let regression_note = detect_regression(
        prev.as_ref().map(|(s, c)| (s.as_slice(), *c)),
        &scans,
        total_cost,
    );
    if structurally_same && regression_note.is_none() {
        return Ok(None);
    }

    // Cap stored node JSON so a pathological plan can't bloat a row.
    let capped_nodes: Vec<Value> = result.nodes.iter().take(200).map(node_json).collect();

    let created = sqlx::query(&format!(
        r#"INSERT INTO "PlanSnapshot"
             ("id","connectionId","userId","shapeHash","normalizedSql","exampleSql","planHash",
              "planSummary","totalCost","totalTimeMs","scans","nodes","regressed","regressionNote","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING {SNAPSHOT_COLS}"#
    ))
    .bind(gen_id())
    .bind(connection_id)
    .bind(if user_id.is_empty() { None } else { Some(user_id) })
    .bind(&shape_hash)
    .bind(&normalized)
    .bind(slice_chars(sql, 8_000))
    .bind(&plan_hash)
    .bind(&plan_summary)
    .bind(total_cost)
    .bind(result.execution_time_ms)
    .bind(scans_json(&scans))
    .bind(Value::Array(capped_nodes))
    .bind(regression_note.is_some())
    .bind(regression_note.as_deref())
    // `@default(now())` is generated by Prisma in UTC, and the column is
    // TIMESTAMP(3) *without* time zone â€” bind a NaiveDateTime so the value can
    // never be shifted by the DB session's TimeZone the way `now()` would be.
    .bind(chrono::Utc::now().naive_utc())
    .fetch_one(&state.pool)
    .await?;

    Ok(Some(snapshot_json(&created)?))
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/// Nest's ValidationPipe envelope: `{ message: string[], error, statusCode }`.
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

#[derive(Deserialize, Default)]
struct ExplainDto {
    #[serde(default)]
    sql: Option<Value>,
    #[serde(default)]
    mode: Option<Value>,
}

/// `ExplainQueryDto`: `@IsString() @Length(1, 100_000) sql`,
/// `@IsOptional() @IsIn(['plan','analyze']) mode`.
fn parse_explain_dto(bytes: &[u8]) -> ApiResult<(String, String)> {
    let dto: ExplainDto = serde_json::from_slice(bytes).unwrap_or_default();
    let sql = match dto.sql {
        Some(Value::String(s)) => s,
        _ => return Err(validation_error("sql must be a string")),
    };
    let len = sql.chars().count();
    if len < 1 {
        return Err(validation_error("sql must be longer than or equal to 1 characters"));
    }
    if len > 100_000 {
        return Err(validation_error("sql must be shorter than or equal to 100000 characters"));
    }
    let mode = match dto.mode {
        None | Some(Value::Null) => "plan".to_string(),
        Some(Value::String(m)) if m == "plan" || m == "analyze" => m,
        _ => return Err(validation_error("mode must be one of the following values: plan, analyze")),
    };
    Ok((sql, mode))
}

/// Split a request so the body can be inspected here and still be replayed to
/// v1 verbatim when the connection turns out to be one v2 cannot serve.
async fn split_body(req: Request) -> ApiResult<(Parts, bytes::Bytes)> {
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, 26_214_400)
        .await
        .map_err(|_| ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "body too large"))?;
    Ok((parts, bytes))
}

/// Shared preamble for the three POSTs that need the target database: RBAC (v1
/// runs its guard before validation), then the proxy decision, then the DTO.
enum Prepared {
    Serve {
        meta: ConnMeta,
        sql: String,
        mode: String,
    },
    Proxy(Request),
}

async fn prepare(state: &AppState, id: &str, user_id: &str, req: Request) -> ApiResult<Prepared> {
    require_role(&state.pool, id, user_id, "VIEWER").await?;
    let meta = load_conn_meta(state, id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let (parts, bytes) = split_body(req).await?;
    if meta.must_proxy(state) {
        return Ok(Prepared::Proxy(Request::from_parts(parts, Body::from(bytes))));
    }
    let (sql, mode) = parse_explain_dto(&bytes)?;
    Ok(Prepared::Serve { meta, sql, mode })
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/connections/:id/query/explain` â€” 200, VIEWER.
async fn explain_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    let (meta, sql, mode) = match prepare(&state, &id, &user.id, req).await? {
        Prepared::Proxy(r) => return Ok(crate::proxy(State(state), r).await),
        Prepared::Serve { meta, sql, mode } => (meta, sql, mode),
    };
    if sql.trim().is_empty() {
        return Err(ApiError::bad("SQL required"));
    }
    let mut c = open_target(&state, &id, &user.id, &meta).await?;
    let plan = explain_postgres(&mut c, &sql, &mode).await?;
    Ok(Json(explain_json(&plan)).into_response())
}

/// `POST /api/connections/:id/query/insights` â€” 200, VIEWER.
async fn insights_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    let (meta, sql) = match prepare(&state, &id, &user.id, req).await? {
        Prepared::Proxy(r) => return Ok(crate::proxy(State(state), r).await),
        Prepared::Serve { meta, sql, .. } => (meta, sql),
    };
    if sql.trim().is_empty() {
        return Err(ApiError::bad("SQL required"));
    }
    let mut c = open_target(&state, &id, &user.id, &meta).await?;
    // v1 always explains in 'plan' mode here, whatever the body said.
    let plan = explain_postgres(&mut c, &sql, "plan").await?;
    Ok(Json(insights_json(&meta.dialect, &sql, &plan)).into_response())
}

/// `POST /api/connections/:id/query/estimate` â€” 200, VIEWER.
async fn estimate_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    let (meta, sql) = match prepare(&state, &id, &user.id, req).await? {
        Prepared::Proxy(r) => return Ok(crate::proxy(State(state), r).await),
        Prepared::Serve { meta, sql, .. } => (meta, sql),
    };
    if sql.trim().is_empty() {
        return Err(ApiError::bad("SQL required"));
    }
    let mut c = open_target(&state, &id, &user.id, &meta).await?;
    let plan = explain_postgres(&mut c, &sql, "plan").await?;
    Ok(Json(estimate_json(&plan)).into_response())
}

/// `POST /api/connections/:id/query/plan-capture` â€” 200, VIEWER.
/// `{ captured, snapshot }`; capture itself is fail-open in v1, so any failure
/// below the guard/validation line returns `{captured:false, snapshot:null}`.
async fn plan_capture_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    let (meta, sql) = match prepare(&state, &id, &user.id, req).await? {
        Prepared::Proxy(r) => return Ok(crate::proxy(State(state), r).await),
        Prepared::Serve { meta, sql, .. } => (meta, sql),
    };
    let snapshot = match capture(&state, &meta, &id, &sql, &user.id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::debug!("plan capture failed: {}", e.message);
            None
        }
    };
    Ok(Json(json!({
        "captured": snapshot.is_some(),
        "snapshot": snapshot.unwrap_or(Value::Null),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct LimitQuery {
    #[serde(default)]
    limit: Option<String>,
}

/// `GET /api/connections/:id/query/plan-history/:shapeHash` â€” VIEWER.
async fn plan_history_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, shape_hash)): Path<(String, String)>,
    Query(q): Query<LimitQuery>,
) -> ApiResult<Json<Value>> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let take = clamp_take(js_parse_int(q.limit.as_deref()).unwrap_or(50.0));
    let rows = sqlx::query(&format!(
        r#"SELECT {SNAPSHOT_COLS} FROM "PlanSnapshot"
            WHERE "connectionId" = $1 AND "shapeHash" = $2
            ORDER BY "createdAt" DESC LIMIT $3"#
    ))
    .bind(&id)
    .bind(&shape_hash)
    .bind(take)
    .fetch_all(&state.pool)
    .await?;
    let out: ApiResult<Vec<Value>> = rows.iter().map(snapshot_json).collect();
    Ok(Json(Value::Array(out?)))
}

#[derive(Deserialize)]
struct RegressionsQuery {
    #[serde(default)]
    hours: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// `GET /api/connections/:id/query/plan-regressions` â€” VIEWER.
async fn plan_regressions_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<RegressionsQuery>,
) -> ApiResult<Json<Value>> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    // `hours ? clamp(parseInt(hours), 1, 24*90) : 168`
    let hours = match js_parse_int(q.hours.as_deref()) {
        Some(h) => h.max(1.0).min(24.0 * 90.0),
        None => 168.0,
    };
    let take = clamp_take(js_parse_int(q.limit.as_deref()).unwrap_or(50.0));
    // v1 computes the bound in Node (`new Date(Date.now() - sinceMs)`) and lets
    // Prisma bind it; do the same rather than trusting the app DB's clock.
    // "PlanSnapshot"."createdAt" is TIMESTAMP(3) *without* time zone holding a
    // UTC instant, so the bound must be a NaiveDateTime â€” never DateTime<Utc>.
    let since: chrono::NaiveDateTime =
        (chrono::Utc::now() - chrono::Duration::milliseconds((hours * 3_600_000.0) as i64)).naive_utc();
    let rows = sqlx::query(&format!(
        r#"SELECT {SNAPSHOT_COLS} FROM "PlanSnapshot"
            WHERE "connectionId" = $1 AND "regressed" = true AND "createdAt" >= $2
            ORDER BY "createdAt" DESC LIMIT $3"#
    ))
    .bind(&id)
    .bind(since)
    .bind(take)
    .fetch_all(&state.pool)
    .await?;
    let out: ApiResult<Vec<Value>> = rows.iter().map(snapshot_json).collect();
    Ok(Json(Value::Array(out?)))
}

#[derive(Deserialize)]
struct DiffQuery {
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
}

/// `GET /api/connections/:id/query/plan-diff?from=&to=` â€” VIEWER.
async fn plan_diff_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<DiffQuery>,
) -> ApiResult<Json<Value>> {
    require_role(&state.pool, &id, &user.id, "VIEWER").await?;
    let from_id = q.from.unwrap_or_default();
    let to_id = q.to.unwrap_or_default();
    if from_id.is_empty() || to_id.is_empty() {
        return Err(ApiError::bad("from and to snapshot ids required"));
    }

    let sql = format!(
        r#"SELECT {SNAPSHOT_COLS} FROM "PlanSnapshot" WHERE "id" = $1 AND "connectionId" = $2 LIMIT 1"#
    );
    let from = sqlx::query(&sql)
        .bind(&from_id)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    let to = sqlx::query(&sql)
        .bind(&to_id)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    let (Some(from), Some(to)) = (from, to) else {
        return Err(ApiError::bad("Snapshot not found"));
    };

    let from_scans = scans_from_json(&from.try_get::<Value, _>("scans").map_err(dberr)?);
    let to_scans = scans_from_json(&to.try_get::<Value, _>("scans").map_err(dberr)?);
    let from_cost = from.try_get::<Option<f64>, _>("totalCost").map_err(dberr)?;
    let to_cost = to.try_get::<Option<f64>, _>("totalCost").map_err(dberr)?;
    let note = detect_regression(Some((from_scans.as_slice(), from_cost)), &to_scans, to_cost);

    // `from.totalCost && to.totalCost && from.totalCost > 0 ? to/from : null`
    // â€” JS truthiness, so a 0 cost on either side yields null.
    let ratio = match (from_cost, to_cost) {
        (Some(f), Some(t)) if f != 0.0 && t != 0.0 && f > 0.0 => num(t / f),
        _ => Value::Null,
    };

    Ok(Json(json!({
        "from": snapshot_json(&from)?,
        "to": snapshot_json(&to)?,
        "changed": from.try_get::<String, _>("planHash").map_err(dberr)?
            != to.try_get::<String, _>("planHash").map_err(dberr)?,
        "costDeltaRatio": ratio,
        "regressionNote": note,
    })))
}

/// `parseInt(x, 10)` â€” leading whitespace, optional sign, leading digits; `NaN`
/// (â†’ None) when there are none. An absent or empty param is falsy in v1's
/// `limit ? parseInt(limit, 10) : default`, so it takes the default too.
fn js_parse_int(s: Option<&str>) -> Option<f64> {
    let s = s?.trim_start_matches(is_js_ws);
    if s.is_empty() {
        return None;
    }
    let (neg, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let taken: String = digits.chars().take_while(|c| c.is_ascii_digit()).collect();
    if taken.is_empty() {
        return None;
    }
    let v: f64 = taken.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// `Math.min(Math.max(limit, 1), 200)`
fn clamp_take(limit: f64) -> i64 {
    limit.max(1.0).min(200.0) as i64
}
