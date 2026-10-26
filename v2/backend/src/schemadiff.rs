//! `GET /api/connections/:id/schema-diff` — compare one database's schema with
//! another's: "does staging still match production?"
//!
//! The existing diff page compares *rows* returned by two queries. This
//! compares *structure*: which tables exist on each side, which columns they
//! have, and how those columns are declared. It is read-only — it never writes
//! to either database and never produces migration SQL to run blindly; the
//! point is to see the drift.
//!
//! Both sides are introspected through `connect_target`, which performs the
//! caller's access check per connection, and the caller must hold at least
//! VIEWER on each: a diff is a read of both schemas, so being able to see one
//! must not reveal the shape of the other.

use std::collections::{BTreeMap, BTreeSet};

use axum::{
    extract::{Path, Query, State},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;

use crate::{ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/connections/:id/schema-diff", get(schema_diff))
}

#[derive(Deserialize)]
struct Q {
    /// The connection to compare against.
    target: String,
    /// Schema name on both sides; defaults to `public`.
    schema: Option<String>,
}

/// One column as the catalog declares it.
#[derive(PartialEq, Eq)]
struct Column {
    data_type: String,
    nullable: bool,
    default_expr: Option<String>,
}

type Tables = BTreeMap<String, BTreeMap<String, Column>>;

const COLUMNS_SQL: &str = r#"
SELECT c.relname::text                                      AS table_name,
       a.attname::text                                      AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod)      AS data_type,
       NOT a.attnotnull                                     AS nullable,
       pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)         AS default_expr
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
 WHERE n.nspname = $1
   AND c.relkind IN ('r', 'p')
 ORDER BY c.relname, a.attnum"#;

/// Index definitions, compared as the text Postgres itself prints. That is
/// stricter than comparing names — a differently-ordered or partial index on
/// the same columns is drift worth seeing — and it needs no modelling here.
const INDEX_SQL: &str = r#"
SELECT c.relname::text                               AS table_name,
       i.relname::text                               AS index_name,
       pg_catalog.pg_get_indexdef(ix.indexrelid)     AS def
  FROM pg_catalog.pg_index ix
  JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
  JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = $1
 ORDER BY c.relname, i.relname"#;

async fn read_tables(conn: &mut crate::TargetConn, schema: &str) -> ApiResult<Tables> {
    let rows = sqlx::query(COLUMNS_SQL).bind(schema).fetch_all(&mut **conn).await?;
    let mut out: Tables = BTreeMap::new();
    for r in rows {
        let table: String = r.try_get("table_name").unwrap_or_default();
        let column: String = r.try_get("column_name").unwrap_or_default();
        out.entry(table).or_default().insert(
            column,
            Column {
                data_type: r.try_get("data_type").unwrap_or_default(),
                nullable: r.try_get("nullable").unwrap_or(true),
                default_expr: r.try_get::<Option<String>, _>("default_expr").unwrap_or(None),
            },
        );
    }
    Ok(out)
}

async fn read_indexes(
    conn: &mut crate::TargetConn,
    schema: &str,
) -> ApiResult<BTreeMap<String, BTreeMap<String, String>>> {
    let rows = sqlx::query(INDEX_SQL).bind(schema).fetch_all(&mut **conn).await?;
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for r in rows {
        let table: String = r.try_get("table_name").unwrap_or_default();
        let name: String = r.try_get("index_name").unwrap_or_default();
        let def: String = r.try_get("def").unwrap_or_default();
        out.entry(table).or_default().insert(name, def);
    }
    Ok(out)
}

fn column_json(c: &Column) -> Value {
    json!({
        "type": c.data_type,
        "nullable": c.nullable,
        "default": c.default_expr,
    })
}

async fn schema_diff(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<Q>,
) -> ApiResult<Json<Value>> {
    if q.target == id {
        return Err(ApiError::bad("Pick a different connection to compare against"));
    }
    let schema = q.schema.unwrap_or_else(|| "public".into());

    // VIEWER on both sides, checked before either database is dialled.
    crate::audit_log::audit_require_role(&state, &id, &user.id, "VIEWER").await?;
    crate::audit_log::audit_require_role(&state, &q.target, &user.id, "VIEWER").await?;

    let mut a = crate::connect_target(&state, &id, &user.id).await?;
    let tables_a = read_tables(&mut a, &schema).await?;
    let idx_a = read_indexes(&mut a, &schema).await?;
    drop(a);

    let mut b = crate::connect_target(&state, &q.target, &user.id).await?;
    let tables_b = read_tables(&mut b, &schema).await?;
    let idx_b = read_indexes(&mut b, &schema).await?;
    drop(b);

    let names_a: BTreeSet<&String> = tables_a.keys().collect();
    let names_b: BTreeSet<&String> = tables_b.keys().collect();

    let only_a: Vec<&&String> = names_a.difference(&names_b).collect();
    let only_b: Vec<&&String> = names_b.difference(&names_a).collect();

    let mut changed: Vec<Value> = Vec::new();
    for name in names_a.intersection(&names_b) {
        let ca = &tables_a[*name];
        let cb = &tables_b[*name];
        let cols_a: BTreeSet<&String> = ca.keys().collect();
        let cols_b: BTreeSet<&String> = cb.keys().collect();

        let col_only_a: Vec<Value> = cols_a
            .difference(&cols_b)
            .map(|c| json!({ "name": c, "a": column_json(&ca[*c]) }))
            .collect();
        let col_only_b: Vec<Value> = cols_b
            .difference(&cols_a)
            .map(|c| json!({ "name": c, "b": column_json(&cb[*c]) }))
            .collect();
        let col_changed: Vec<Value> = cols_a
            .intersection(&cols_b)
            .filter(|c| ca[**c] != cb[**c])
            .map(|c| json!({ "name": c, "a": column_json(&ca[*c]), "b": column_json(&cb[*c]) }))
            .collect();

        let empty = BTreeMap::new();
        let ia = idx_a.get(*name).unwrap_or(&empty);
        let ib = idx_b.get(*name).unwrap_or(&empty);
        let ia_names: BTreeSet<&String> = ia.keys().collect();
        let ib_names: BTreeSet<&String> = ib.keys().collect();
        let idx_only_a: Vec<Value> = ia_names
            .difference(&ib_names)
            .map(|n| json!({ "name": n, "def": ia[*n] }))
            .collect();
        let idx_only_b: Vec<Value> = ib_names
            .difference(&ia_names)
            .map(|n| json!({ "name": n, "def": ib[*n] }))
            .collect();
        let idx_changed: Vec<Value> = ia_names
            .intersection(&ib_names)
            .filter(|n| ia[**n] != ib[**n])
            .map(|n| json!({ "name": n, "a": ia[*n], "b": ib[*n] }))
            .collect();

        if !col_only_a.is_empty()
            || !col_only_b.is_empty()
            || !col_changed.is_empty()
            || !idx_only_a.is_empty()
            || !idx_only_b.is_empty()
            || !idx_changed.is_empty()
        {
            changed.push(json!({
                "table": name,
                "columnsOnlyInA": col_only_a,
                "columnsOnlyInB": col_only_b,
                "columnsChanged": col_changed,
                "indexesOnlyInA": idx_only_a,
                "indexesOnlyInB": idx_only_b,
                "indexesChanged": idx_changed,
            }));
        }
    }

    let identical = only_a.is_empty() && only_b.is_empty() && changed.is_empty();
    Ok(Json(json!({
        "schema": schema,
        "identical": identical,
        "tablesOnlyInA": only_a,
        "tablesOnlyInB": only_b,
        "tablesChanged": changed,
        "counts": {
            "a": tables_a.len(),
            "b": tables_b.len(),
        },
    })))
}
