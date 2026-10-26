//! Named parameters for the SQL editor — `:start_date` in the text, a value
//! supplied alongside it, and a real bound placeholder in what reaches the
//! database.
//!
//! Why bind rather than substitute text: a saved query that filters on
//! `WHERE email = :email` must stay safe when the value is `' OR 1=1 --`.
//! Everything below rewrites `:name` to `$n` and hands the value to Postgres as
//! a parameter, so the value can never become SQL.
//!
//! The scan is the delicate part. These all look like `:name` and are NOT
//! parameters:
//!
//!   * `id::text`           — a Postgres cast (the `::` is consumed as a unit)
//!   * `'12:30'`            — inside a single-quoted literal
//!   * `"col:name"`         — inside a quoted identifier
//!   * `-- note: here`      — inside a line comment
//!   * `/* note: here */`   — inside a block comment (which nests in Postgres)
//!   * `$tag$ a:b $tag$`    — inside a dollar-quoted body
//!   * `array[1:2]`         — a slice, no identifier after the colon
//!
//! A parameter is a `:` followed immediately by a letter or underscore, in
//! ordinary SQL text.

use std::collections::HashMap;

use serde_json::Value;

/// One parameter, ready to bind.
pub(crate) struct Bound {
    /// `None` is a SQL NULL.
    pub value: Option<String>,
    /// The SQL type the placeholder is cast to, e.g. `text`, `numeric`.
    pub cast: &'static str,
}

/// What a caller gets back: SQL with `$1…$n`, and the values in that order.
pub(crate) struct Prepared {
    pub sql: String,
    pub binds: Vec<Bound>,
    /// Parameter names in placeholder order — handy for error messages.
    pub names: Vec<String>,
}

/// Decide how to send a JSON value to Postgres.
///
/// Everything is sent as text and cast in the statement, because that is the
/// one form that round-trips every type through JSON without the driver
/// guessing. The cast is what makes `WHERE created_at >= :from` work: a bare
/// text parameter would fail with "operator does not exist: timestamp >= text".
fn classify(v: &Value) -> Bound {
    match v {
        Value::Null => Bound { value: None, cast: "text" },
        Value::Bool(b) => Bound { value: Some(b.to_string()), cast: "boolean" },
        Value::Number(n) => Bound { value: Some(n.to_string()), cast: "numeric" },
        Value::String(s) => {
            let t = s.trim();
            if looks_like_timestamp(t) {
                Bound { value: Some(t.to_string()), cast: "timestamptz" }
            } else if looks_like_date(t) {
                Bound { value: Some(t.to_string()), cast: "date" }
            } else {
                Bound { value: Some(s.clone()), cast: "text" }
            }
        }
        // Objects and arrays go as jsonb — the only honest mapping.
        other => Bound { value: Some(other.to_string()), cast: "jsonb" },
    }
}

fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn looks_like_timestamp(s: &str) -> bool {
    s.len() >= 16
        && looks_like_date(&s[..10.min(s.len())])
        && matches!(s.as_bytes().get(10), Some(b'T') | Some(b' '))
}

/// Rewrite `:name` into `$n` and collect the values to bind.
///
/// Returns `Err(name)` when the SQL uses a parameter the caller did not supply
/// — the editor turns that into "fill in :name before running".
pub(crate) fn prepare(sql: &str, params: &HashMap<String, Value>) -> Result<Prepared, String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len() + 16);
    let mut binds: Vec<Bound> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];

        // ---- regions where a colon means nothing ----
        if c == '\'' || c == '"' {
            let quote = c;
            out.push(c);
            i += 1;
            while i < chars.len() {
                out.push(chars[i]);
                // '' and "" are escaped quotes, not the end of the literal.
                if chars[i] == quote {
                    if chars.get(i + 1) == Some(&quote) {
                        out.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == '-' && chars.get(i + 1) == Some(&'-') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let mut depth = 0usize;
            while i < chars.len() {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    out.push('/');
                    out.push('*');
                    i += 2;
                    continue;
                }
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    out.push('*');
                    out.push('/');
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                out.push(chars[i]);
                i += 1;
            }
            continue;
        }
        if c == '$' {
            // Dollar quoting: $tag$ … $tag$ (tag may be empty).
            if let Some(tag_end) = dollar_tag_end(&chars, i) {
                let tag: String = chars[i..=tag_end].iter().collect();
                out.push_str(&tag);
                i = tag_end + 1;
                while i < chars.len() {
                    if chars[i] == '$' && chars[i..].starts_with(&tag.chars().collect::<Vec<_>>()[..]) {
                        out.push_str(&tag);
                        i += tag.chars().count();
                        break;
                    }
                    out.push(chars[i]);
                    i += 1;
                }
                continue;
            }
        }
        // `::` is a cast — emit both colons so the second cannot start a name.
        if c == ':' && chars.get(i + 1) == Some(&':') {
            out.push(':');
            out.push(':');
            i += 2;
            continue;
        }

        // ---- a parameter ----
        if c == ':' && matches!(chars.get(i + 1), Some(ch) if ch.is_alphabetic() || *ch == '_') {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && (chars[end].is_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            let name: String = chars[start..end].iter().collect();
            let idx = match seen.get(&name) {
                // The same parameter used twice binds once and is referenced twice.
                Some(n) => *n,
                None => {
                    let v = params.get(&name).ok_or_else(|| name.clone())?;
                    binds.push(classify(v));
                    names.push(name.clone());
                    let n = binds.len();
                    seen.insert(name.clone(), n);
                    n
                }
            };
            let cast = binds[idx - 1].cast;
            out.push_str(&format!("(${idx})::{cast}"));
            i = end;
            continue;
        }

        out.push(c);
        i += 1;
    }

    Ok(Prepared { sql: out, binds, names })
}

/// If a `$` at `i` opens a dollar-quote, return the index of its closing `$`.
fn dollar_tag_end(chars: &[char], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
        j += 1;
    }
    (chars.get(j) == Some(&'$')).then_some(j)
}

/// Every parameter name the SQL refers to, in first-use order. The editor uses
/// this to render one input per parameter.
pub(crate) fn names_in(sql: &str) -> Vec<String> {
    // Reuse `prepare` with a map that supplies every name it asks for: the
    // error path hands back the first missing name, so loop until it stops.
    let mut known: HashMap<String, Value> = HashMap::new();
    loop {
        match prepare(sql, &known) {
            Ok(p) => return p.names,
            Err(missing) => {
                known.insert(missing, Value::Null);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(sql: &str, params: &[(&str, Value)]) -> Prepared {
        let map: HashMap<String, Value> =
            params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        prepare(sql, &map).expect("prepares")
    }

    #[test]
    fn a_parameter_becomes_a_placeholder_with_a_cast() {
        let out = p("SELECT * FROM t WHERE id = :id", &[("id", json!(7))]);
        assert_eq!(out.sql, "SELECT * FROM t WHERE id = ($1)::numeric");
        assert_eq!(out.binds[0].value.as_deref(), Some("7"));
    }

    #[test]
    fn the_same_name_twice_binds_once() {
        let out = p(
            "SELECT * FROM t WHERE a = :x OR b = :x",
            &[("x", json!("hi"))],
        );
        assert_eq!(out.sql, "SELECT * FROM t WHERE a = ($1)::text OR b = ($1)::text");
        assert_eq!(out.binds.len(), 1);
    }

    #[test]
    fn casts_and_literals_are_not_parameters() {
        let out = p("SELECT id::text, '12:30' AS t, \"a:b\" FROM t", &[]);
        assert_eq!(out.sql, "SELECT id::text, '12:30' AS t, \"a:b\" FROM t");
        assert!(out.binds.is_empty());
    }

    #[test]
    fn comments_and_dollar_quotes_are_not_parameters() {
        let sql = "SELECT 1 -- note: here\n, $$ body :x $$, /* block :y */ 2";
        let out = p(sql, &[]);
        assert_eq!(out.sql, sql);
        assert!(out.binds.is_empty());

        // An escaped quote inside a literal must not end it early.
        let sql2 = "SELECT 'it''s :not a param'";
        assert_eq!(p(sql2, &[]).sql, sql2);
    }

    #[test]
    fn value_types_drive_the_cast() {
        let out = p(
            "SELECT :s, :n, :b, :nul, :ts, :d",
            &[
                ("s", json!("text")),
                ("n", json!(1.5)),
                ("b", json!(true)),
                ("nul", Value::Null),
                ("ts", json!("2026-01-02T03:04:05Z")),
                ("d", json!("2026-01-02")),
            ],
        );
        assert_eq!(
            out.sql,
            "SELECT ($1)::text, ($2)::numeric, ($3)::boolean, ($4)::text, ($5)::timestamptz, ($6)::date"
        );
        assert_eq!(out.binds[3].value, None);
    }

    #[test]
    fn a_missing_value_names_itself() {
        let map: HashMap<String, Value> = HashMap::new();
        let err = prepare("SELECT :missing", &map).unwrap_err();
        assert_eq!(err, "missing");
    }

    #[test]
    fn names_are_listed_in_first_use_order() {
        assert_eq!(
            names_in("SELECT :b, :a, :b FROM t WHERE x = :c"),
            vec!["b".to_string(), "a".to_string(), "c".to_string()]
        );
        assert!(names_in("SELECT id::text FROM t").is_empty());
    }
}
