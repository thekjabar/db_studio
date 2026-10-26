//! `POST /api/connections/:id/query/transpile` — rewrite one SELECT from one
//! SQL dialect into another.
//!
//! v1 source: `backend/src/query/transpile.service.ts`. Its contract, kept
//! exactly: parse in the SOURCE dialect (refuse what will not parse — never
//! regex-hack unparseable SQL), regenerate in the TARGET dialect, apply a
//! small set of verified idiom rewrites the parser does not do, and warn about
//! constructs whose semantics cannot be guaranteed to survive. SELECT only;
//! DML/DDL differ too much between engines to convert safely.
//!
//! v1 round-tripped through node-sql-parser, which emits per-dialect. The Rust
//! `sqlparser` crate parses per-dialect but has a single generic `Display`, so
//! the quoting style of the source survives into the output — `"user"` stays
//! double-quoted when targeting MySQL, which is a syntax error there. The fix
//! is not a regex over the SQL text: the rendered statement is re-tokenized
//! with the real tokenizer, and only tokens the tokenizer calls *quoted
//! identifiers* get the target's quote character. String literals, numbers and
//! comments are tokens of other kinds, so they are never touched — which is
//! precisely the property a regex cannot offer.

use axum::{extract::{Path, State}, routing::post, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlparser::dialect::{Dialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::{ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/connections/:id/query/transpile", post(transpile_route))
}

#[derive(Deserialize)]
struct Body {
    sql: String,
    to: String,
    #[serde(default)]
    from: Option<String>,
}

fn dialect_of(name: &str) -> Option<Box<dyn Dialect>> {
    match name.to_uppercase().as_str() {
        "POSTGRES" => Some(Box::new(PostgreSqlDialect {})),
        "MYSQL" => Some(Box::new(MySqlDialect {})),
        "SQLITE" => Some(Box::new(SQLiteDialect {})),
        "MSSQL" => Some(Box::new(MsSqlDialect {})),
        _ => None,
    }
}

/// How each engine quotes an identifier that needs quoting.
fn quote_char(dialect: &str) -> char {
    match dialect {
        "MYSQL" => '`',
        "MSSQL" => '[',
        _ => '"', // Postgres and SQLite
    }
}

/// `POST /api/connections/:id/query/transpile` — 200, VIEWER.
async fn transpile_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Body>,
) -> ApiResult<Json<Value>> {
    crate::audit_log::audit_require_role(&state, &id, &user.id, "VIEWER").await?;

    let to = body.to.to_uppercase();
    if dialect_of(&to).is_none() {
        return Err(ApiError::bad("to must be one of POSTGRES, MYSQL, SQLITE, MSSQL"));
    }
    // v1: `dto.from ?? conn.dialect`.
    let from = match body.from {
        Some(f) => {
            let f = f.to_uppercase();
            if dialect_of(&f).is_none() {
                return Err(ApiError::bad("from must be one of POSTGRES, MYSQL, SQLITE, MSSQL"));
            }
            f
        }
        None => sqlx::query_scalar::<_, String>(
            r#"SELECT "dialect"::text FROM "Connection" WHERE "id" = $1"#,
        )
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or_else(|| "POSTGRES".into())
        .to_uppercase(),
    };

    let result = transpile(&body.sql, &from, &to)?;
    Ok(Json(result))
}

fn transpile(sql: &str, from: &str, to: &str) -> ApiResult<Value> {
    let trimmed = sql.trim().trim_end_matches(';').trim().to_string();
    if trimmed.is_empty() {
        return Err(ApiError::bad("SQL required"));
    }
    if from == to {
        return Ok(json!({ "from": from, "to": to, "sql": trimmed, "warnings": [], "noop": true }));
    }

    let src = dialect_of(from).unwrap_or_else(|| Box::new(GenericDialect {}));
    let statements = Parser::parse_sql(src.as_ref(), &trimmed)
        .map_err(|e| ApiError::bad(format!("Could not parse the query as {from} SQL: {e}")))?;
    if statements.len() != 1 {
        return Err(ApiError::bad("Transpilation supports a single statement"));
    }
    let stmt = &statements[0];
    if !matches!(stmt, sqlparser::ast::Statement::Query(_)) {
        return Err(ApiError::bad(
            "Only SELECT statements can be transpiled — DML/DDL differ too much across engines to convert safely.",
        ));
    }

    let rendered = requote(&stmt.to_string(), src.as_ref(), quote_char(to))?;

    let mut warnings: Vec<Value> = Vec::new();
    let out = rewrite_idioms(&rendered, from, to, &mut warnings);
    collect_warnings(&trimmed, to, &mut warnings);

    Ok(json!({ "from": from, "to": to, "sql": out, "warnings": warnings, "noop": false }))
}

/// Re-emit every *quoted identifier* with the target engine's quote character,
/// leaving every other token byte-identical.
fn requote(sql: &str, src: &dyn Dialect, quote: char) -> ApiResult<String> {
    let tokens = Tokenizer::new(src, sql)
        .tokenize()
        .map_err(|e| ApiError::internal(format!("could not re-read generated SQL: {e}")))?;
    let mut out = String::with_capacity(sql.len());
    for token in tokens {
        match token {
            Token::Word(mut w) if w.quote_style.is_some() => {
                w.quote_style = Some(quote);
                out.push_str(&w.to_string());
            }
            other => out.push_str(&other.to_string()),
        }
    }
    Ok(out)
}

fn warn(severity: &str, message: impl Into<String>) -> Value {
    json!({ "severity": severity, "message": message.into() })
}

/// The idiom rewrites v1 performs after regeneration. Each rule is narrow and
/// only fires on a pattern that can be rewritten without changing meaning;
/// anything ambiguous is left alone and warned about instead.
fn rewrite_idioms(sql: &str, from: &str, to: &str, warnings: &mut Vec<Value>) -> String {
    let mut out = sql.to_string();

    // --- LIMIT / OFFSET <-> SQL Server TOP / OFFSET-FETCH ---
    if to == "MSSQL" {
        if let Some((head, lim, off)) = split_limit_offset(&out) {
            out = head.trim_end().to_string();
            if !contains_kw(&out, "ORDER BY") {
                warnings.push(warn(
                    "warn",
                    "SQL Server OFFSET/FETCH requires an ORDER BY. Add one or the converted query will error.",
                ));
            }
            out = format!("{out} OFFSET {off} ROWS FETCH NEXT {lim} ROWS ONLY");
        } else if let Some((head, lim)) = split_limit(&out) {
            let head = head.trim_end();
            out = match head.strip_prefix("SELECT ").or_else(|| head.strip_prefix("select ")) {
                Some(rest) => format!("SELECT TOP ({lim}) {rest}"),
                None => head.to_string(),
            };
        }
    }
    if from == "MSSQL" && to != "MSSQL" {
        if let Some((rest, n)) = strip_top(&out) {
            out = format!("SELECT {rest} LIMIT {n}");
        }
    }

    // --- String concatenation: `||` is logical OR in MySQL by default ---
    if to == "MYSQL" && out.contains("||") {
        warnings.push(warn(
            "warn",
            "Found `||` string concatenation. In MySQL `||` means logical OR by default — rewrite as CONCAT(...) or enable PIPES_AS_CONCAT.",
        ));
    }

    // --- Boolean literals ---
    if to == "MSSQL" && (contains_kw(&out, "TRUE") || contains_kw(&out, "FALSE")) {
        warnings.push(warn(
            "info",
            "SQL Server has no TRUE/FALSE literals — use 1/0 with a BIT column.",
        ));
    }

    // --- ILIKE is Postgres-only ---
    if from == "POSTGRES" && to != "POSTGRES" && contains_kw(sql, "ILIKE") {
        if to == "MYSQL" {
            out = replace_kw(&out, "ILIKE", "LIKE");
            warnings.push(warn(
                "info",
                "ILIKE rewritten to LIKE (MySQL LIKE is case-insensitive under default collations).",
            ));
        } else {
            warnings.push(warn(
                "warn",
                "ILIKE has no direct equivalent in the target — use LOWER(col) LIKE LOWER(...).",
            ));
        }
    }

    out
}

/// Functions whose name or semantics differ across dialects. v1 never rewrites
/// these — guessing intent is the risky part — it warns so the author checks.
const NON_PORTABLE_FUNCS: &[(&str, &str)] = &[
    ("now", "NOW() — Postgres/MySQL; SQLite uses CURRENT_TIMESTAMP; MSSQL uses GETDATE()"),
    ("getdate", "GETDATE() is SQL Server only"),
    ("ifnull", "IFNULL is MySQL/SQLite; Postgres/MSSQL use COALESCE"),
    ("isnull", "ISNULL is MySQL/MSSQL with different signatures; prefer COALESCE"),
    ("nvl", "NVL is Oracle; use COALESCE"),
    ("date_trunc", "date_trunc is Postgres; MySQL/MSSQL differ"),
    ("datediff", "DATEDIFF signatures differ between MySQL and SQL Server"),
    ("group_concat", "GROUP_CONCAT (MySQL/SQLite) vs STRING_AGG (Postgres/MSSQL)"),
    ("string_agg", "STRING_AGG (Postgres/MSSQL) vs GROUP_CONCAT (MySQL/SQLite)"),
    ("top", "TOP is SQL Server; others use LIMIT"),
];

/// Inspect the ORIGINAL SQL for non-portable constructs, as v1 does.
fn collect_warnings(sql: &str, to: &str, warnings: &mut Vec<Value>) {
    let lower = sql.to_lowercase();
    for (name, note) in NON_PORTABLE_FUNCS {
        if called_in(&lower, name) {
            warnings.push(warn(
                "warn",
                format!("Function {}() may not behave the same in {to}: {note}", name.to_uppercase()),
            ));
        }
    }
    if to != "POSTGRES" && has_pg_cast(sql) {
        warnings.push(warn(
            "warn",
            "Postgres `::type` casts are not portable — use CAST(expr AS type) for the target dialect.",
        ));
    }
}

// ---------------------------------------------------------------------------
// Small text helpers. These run over SQL that has already been parsed and
// regenerated, so they only ever see canonical output — but they still match on
// word boundaries rather than bare substrings, so a column named `limit_note`
// or a string containing "true" is not mistaken for the keyword.
// ---------------------------------------------------------------------------

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Case-insensitive, word-boundary-aware find of every occurrence.
fn find_kw(hay: &str, needle: &str) -> Vec<usize> {
    let h = hay.to_lowercase();
    let n = needle.to_lowercase();
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = h[from..].find(&n) {
        let at = from + rel;
        let before_ok = at == 0 || !h[..at].chars().next_back().map(is_word_char).unwrap_or(false);
        let after = at + n.len();
        let after_ok = after >= h.len() || !h[after..].chars().next().map(is_word_char).unwrap_or(false);
        if before_ok && after_ok {
            out.push(at);
        }
        from = at + n.len();
    }
    out
}

fn contains_kw(hay: &str, needle: &str) -> bool {
    !find_kw(hay, needle).is_empty()
}

fn replace_kw(hay: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(hay.len());
    let mut last = 0usize;
    for at in find_kw(hay, needle) {
        out.push_str(&hay[last..at]);
        out.push_str(with);
        last = at + needle.len();
    }
    out.push_str(&hay[last..]);
    out
}

fn called_in(lower_sql: &str, func: &str) -> bool {
    find_kw(lower_sql, func)
        .into_iter()
        .any(|at| lower_sql[at + func.len()..].trim_start().starts_with('('))
}

/// `::type` outside a string literal.
fn has_pg_cast(sql: &str) -> bool {
    let bytes: Vec<char> = sql.chars().collect();
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '\'' {
            in_str = !in_str;
        } else if !in_str && c == ':' && i + 1 < bytes.len() && bytes[i + 1] == ':' {
            if bytes[i + 2..].iter().find(|c| !c.is_whitespace()).map(|c| is_word_char(*c)).unwrap_or(false) {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// `… LIMIT n OFFSET m` at the very end → (head, limit, offset).
fn split_limit_offset(sql: &str) -> Option<(String, String, String)> {
    let at = *find_kw(sql, "LIMIT").last()?;
    let rest = &sql[at + 5..];
    let mut it = rest.split_whitespace();
    let lim = it.next()?.to_string();
    if !it.next().map(|w| w.eq_ignore_ascii_case("offset")).unwrap_or(false) {
        return None;
    }
    let off = it.next()?.to_string();
    if it.next().is_some() {
        return None; // not the tail of the statement — leave it alone
    }
    if lim.chars().all(|c| c.is_ascii_digit()) && off.chars().all(|c| c.is_ascii_digit()) {
        Some((sql[..at].to_string(), lim, off))
    } else {
        None
    }
}

/// `… LIMIT n` at the very end → (head, limit).
fn split_limit(sql: &str) -> Option<(String, String)> {
    let at = *find_kw(sql, "LIMIT").last()?;
    let rest = &sql[at + 5..];
    let mut it = rest.split_whitespace();
    let lim = it.next()?.to_string();
    if it.next().is_some() {
        return None;
    }
    lim.chars().all(|c| c.is_ascii_digit()).then(|| (sql[..at].to_string(), lim))
}

/// `SELECT TOP (n) rest` / `SELECT TOP n rest` → (rest, n).
fn strip_top(sql: &str) -> Option<(String, String)> {
    let trimmed = sql.trim_start();
    let rest = trimmed.strip_prefix("SELECT").or_else(|| trimmed.strip_prefix("select"))?;
    let rest = rest.trim_start();
    let rest = rest.strip_prefix("TOP").or_else(|| rest.strip_prefix("top"))?;
    let rest = rest.trim_start();
    let (digits, tail) = if let Some(inner) = rest.strip_prefix('(') {
        let close = inner.find(')')?;
        (inner[..close].trim().to_string(), &inner[close + 1..])
    } else {
        let end = rest.find(|c: char| !c.is_ascii_digit())?;
        (rest[..end].to_string(), &rest[end..])
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((tail.trim_start().to_string(), digits))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ApiError` deliberately has no `Debug` (it is an HTTP response shape,
    /// not a diagnostic), so these unwrap by hand and report `message`.
    fn out(sql: &str, from: &str, to: &str) -> Value {
        match transpile(sql, from, to) {
            Ok(v) => v,
            Err(e) => panic!("expected {sql:?} to transpile, got: {}", e.message),
        }
    }

    fn err(sql: &str, from: &str, to: &str) -> String {
        match transpile(sql, from, to) {
            Ok(v) => panic!("expected {sql:?} to be refused, got: {v}"),
            Err(e) => e.message,
        }
    }

    #[test]
    fn same_dialect_is_a_passthrough() {
        let v = out("SELECT 1;", "POSTGRES", "POSTGRES");
        assert_eq!(v["noop"], json!(true));
        assert_eq!(v["sql"], json!("SELECT 1"));
    }

    #[test]
    fn quoted_identifiers_take_the_target_quoting() {
        let v = out(r#"SELECT "user"."id" FROM "user""#, "POSTGRES", "MYSQL");
        let sql = v["sql"].as_str().unwrap();
        assert!(sql.contains("`user`"), "{sql}");
        assert!(!sql.contains('"'), "{sql}");

        // …and a string literal that looks like an identifier is left alone.
        let v = out(r#"SELECT "id" FROM "t" WHERE "name" = 'a "quoted" word'"#, "POSTGRES", "MYSQL");
        let sql = v["sql"].as_str().unwrap();
        assert!(sql.contains(r#"'a "quoted" word'"#), "{sql}");
    }

    #[test]
    fn limit_becomes_top_and_back() {
        let v = out("SELECT a FROM t LIMIT 10", "POSTGRES", "MSSQL");
        assert_eq!(v["sql"], json!("SELECT TOP (10) a FROM t"));

        let v = out("SELECT TOP (10) a FROM t", "MSSQL", "POSTGRES");
        assert_eq!(v["sql"], json!("SELECT a FROM t LIMIT 10"));
    }

    #[test]
    fn limit_offset_becomes_offset_fetch_and_warns_without_order_by() {
        let v = out("SELECT a FROM t LIMIT 10 OFFSET 20", "POSTGRES", "MSSQL");
        assert_eq!(v["sql"], json!("SELECT a FROM t OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY"));
        let warnings = v["warnings"].as_array().unwrap();
        assert!(warnings.iter().any(|w| w["message"].as_str().unwrap().contains("ORDER BY")));

        let v = out("SELECT a FROM t ORDER BY a LIMIT 10 OFFSET 20", "POSTGRES", "MSSQL");
        let warnings = v["warnings"].as_array().unwrap();
        assert!(!warnings.iter().any(|w| w["message"].as_str().unwrap().contains("ORDER BY")));
    }

    #[test]
    fn ilike_is_rewritten_for_mysql_and_flagged_elsewhere() {
        let v = out("SELECT a FROM t WHERE a ILIKE 'x%'", "POSTGRES", "MYSQL");
        assert!(v["sql"].as_str().unwrap().contains("LIKE"));
        assert!(!v["sql"].as_str().unwrap().to_uppercase().contains("ILIKE"));

        let v = out("SELECT a FROM t WHERE a ILIKE 'x%'", "POSTGRES", "SQLITE");
        let warnings = v["warnings"].as_array().unwrap();
        assert!(warnings.iter().any(|w| w["message"].as_str().unwrap().contains("ILIKE")));
    }

    #[test]
    fn non_portable_functions_and_casts_warn() {
        let v = out("SELECT now(), id::text FROM t", "POSTGRES", "MYSQL");
        let msgs: Vec<String> = v["warnings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["message"].as_str().unwrap().to_string())
            .collect();
        assert!(msgs.iter().any(|m| m.contains("NOW()")), "{msgs:?}");
        assert!(msgs.iter().any(|m| m.contains("::type")), "{msgs:?}");

        // A column merely NAMED like a function is not a call.
        let v = out("SELECT now_label FROM t", "POSTGRES", "MYSQL");
        assert!(v["warnings"].as_array().unwrap().is_empty());
    }

    #[test]
    fn non_select_and_unparseable_sql_are_refused() {
        let m = err("DELETE FROM t", "POSTGRES", "MYSQL");
        assert!(m.contains("Only SELECT"), "{m}");

        let m = err("SELECT FROM WHERE", "POSTGRES", "MYSQL");
        assert!(m.contains("Could not parse"), "{m}");

        let m = err("SELECT 1; SELECT 2", "POSTGRES", "MYSQL");
        assert!(m.contains("single statement"), "{m}");
    }
}
