//! Scheduled queries and alerts — the half that actually *runs* them.
//!
//! v1 source of truth: `backend/src/scheduler/scheduler.worker.ts` (plus
//! `alert-evaluator.ts` for the condition semantics). There, a BullMQ
//! repeatable job woke a Node worker, which ran the SQL, wrote a
//! `ScheduledQueryRun` row and mailed/Slacked the result.
//!
//! That worker died with the Node backend. `schedules.rs` still mirrors v1's
//! BullMQ bookkeeping byte-for-byte (so a Node worker could be reattached
//! tomorrow), but nothing consumes those jobs any more — which is why every
//! schedule in the database has silently never fired. This module replaces the
//! consumer, and it does not need Redis at all:
//!
//!   * The queue was only ever a clock. Postgres already stores the same
//!     information in `ScheduledQuery.nextRunAt`, and this process is
//!     single-pod (see `AppState.cooldown` for the same reasoning), so a plain
//!     "what is due?" poll is both simpler and one less thing to keep in sync.
//!   * `nextRunAt` is advanced BEFORE the query runs. A query that outlives its
//!     own interval, or a crash mid-run, therefore costs one skipped firing
//!     rather than an ever-growing pile of overlapping executions.
//!   * The cron arithmetic is `schedules::bull::next_millis` — the same parser
//!     v1's cron-parser drove BullMQ with, timezone handling included — so a
//!     schedule fires at the instant the UI (and v1) said it would.
//!
//! A schedule whose `nextRunAt` is NULL is never run on sight: it is scheduled
//! forward and runs at its next real occurrence. Otherwise enabling the feature
//! would fire every stale schedule in the table at once.

use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{connect_target, gen_id, html_escape, AppState};

/// How often to look for due schedules. The cron resolution is one minute, so
/// this only has to be comfortably under that.
const TICK: Duration = Duration::from_secs(20);

/// v1: `SCHEDULER_QUERY_TIMEOUT_MS`, default 120s.
const DEFAULT_QUERY_TIMEOUT_MS: u64 = 120_000;

/// v1 worker constants.
const MAX_PREVIEW_ROWS: usize = 50;
const MAX_EMAIL_ROWS: usize = 10_000;
const EMAIL_PREVIEW_ROWS: usize = 50;
const EMAIL_PREVIEW_COLS: usize = 12;
const EMAIL_CELL_MAX: usize = 120;
/// Slack caps a message around 40KB; v1 previews ten rows.
const SLACK_PREVIEW_ROWS: usize = 10;

/// Start the background loop. Returns immediately; the task lives for the
/// process. Failures inside a tick are logged and never stop the loop —
/// a broken schedule must not take the scheduler down with it.
pub(crate) fn spawn(state: AppState) {
    tokio::spawn(async move {
        // Let the API finish binding before the first poll, so a boot-time
        // burst of schedule work never competes with the readiness probe.
        tokio::time::sleep(Duration::from_secs(10)).await;
        tracing::info!("scheduler: started (tick {}s)", TICK.as_secs());
        loop {
            if let Err(e) = tick(&state).await {
                tracing::warn!("scheduler tick failed: {e}");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

const DUE_SQL: &str = r#"SELECT "id","connectionId","ownerId","name","cron","timezone",
       "schemaName","sqlText","emailTo","slackWebhook","alertCondition","alertCooldownMin",
       "lastAlertedAt","nextRunAt"
  FROM "ScheduledQuery"
 WHERE "enabled" = true
   AND ("nextRunAt" IS NULL OR "nextRunAt" <= now())
 ORDER BY "nextRunAt" NULLS FIRST
 LIMIT 50"#;

struct Schedule {
    id: String,
    connection_id: String,
    owner_id: String,
    name: String,
    cron: String,
    timezone: Option<String>,
    schema_name: Option<String>,
    sql_text: String,
    email_to: String,
    slack_webhook: Option<String>,
    alert_condition: Option<Value>,
    alert_cooldown_min: Option<i32>,
    last_alerted_at: Option<chrono::NaiveDateTime>,
    /// NULL means "never scheduled" — schedule it forward, don't run it now.
    next_run_at: Option<chrono::NaiveDateTime>,
}

fn read_schedule(r: &PgRow) -> Schedule {
    Schedule {
        id: r.try_get("id").unwrap_or_default(),
        connection_id: r.try_get("connectionId").unwrap_or_default(),
        owner_id: r.try_get("ownerId").unwrap_or_default(),
        name: r.try_get("name").unwrap_or_default(),
        cron: r.try_get("cron").unwrap_or_default(),
        timezone: r.try_get("timezone").ok().flatten(),
        schema_name: r.try_get("schemaName").ok().flatten(),
        sql_text: r.try_get("sqlText").unwrap_or_default(),
        email_to: r.try_get("emailTo").unwrap_or_default(),
        slack_webhook: r.try_get("slackWebhook").ok().flatten(),
        alert_condition: r.try_get("alertCondition").ok().flatten(),
        alert_cooldown_min: r.try_get("alertCooldownMin").ok().flatten(),
        last_alerted_at: r.try_get("lastAlertedAt").ok().flatten(),
        next_run_at: r.try_get("nextRunAt").ok().flatten(),
    }
}

async fn tick(state: &AppState) -> Result<(), sqlx::Error> {
    let rows = sqlx::query(DUE_SQL).fetch_all(&state.pool).await?;
    for row in &rows {
        let s = read_schedule(row);
        let first_sight = s.next_run_at.is_none();

        // Advance the clock first — see the module header.
        match advance(state, &s).await {
            Ok(()) => {}
            Err(e) => {
                // A cron we cannot parse would otherwise be selected forever,
                // every tick. Say so once and disable it; the row keeps its
                // cron so the owner can see and fix what was rejected.
                tracing::warn!("scheduler: disabling schedule {} — bad cron {:?}: {e}", s.id, s.cron);
                let _ = sqlx::query(r#"UPDATE "ScheduledQuery" SET "enabled" = false, "updatedAt" = now() WHERE "id" = $1"#)
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
        // One task per due schedule: a slow query delays its own next firing
        // (nextRunAt is already moved on), not everyone else's.
        tokio::spawn(async move {
            if let Err(e) = run_one(&state, &s).await {
                tracing::warn!("scheduled query {} failed: {e}", s.id);
            }
        });
    }
    Ok(())
}

/// Write the next firing time from the cron expression. `Err` means the cron
/// itself is unusable.
async fn advance(state: &AppState, s: &Schedule) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let next_ms = crate::schedules::cronparser::next_millis(&s.cron, s.timezone.as_deref(), now_ms)?
        .ok_or_else(|| "cron has no further occurrences".to_string())?;
    let next = chrono::DateTime::from_timestamp_millis(next_ms)
        .ok_or_else(|| "cron produced an out-of-range time".to_string())?
        .naive_utc();
    sqlx::query(r#"UPDATE "ScheduledQuery" SET "nextRunAt" = $2 WHERE "id" = $1"#)
        .bind(&s.id)
        .bind(next)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// One execution
// ---------------------------------------------------------------------------

async fn run_one(state: &AppState, s: &Schedule) -> Result<(), String> {
    let run_id = gen_id();
    sqlx::query(
        r#"INSERT INTO "ScheduledQueryRun" ("id","scheduleId","startedAt","status")
           VALUES ($1,$2, now(), 'RUNNING'::"ScheduledRunStatus")"#,
    )
    .bind(&run_id)
    .bind(&s.id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let started = Instant::now();
    let timeout = Duration::from_millis(
        std::env::var("SCHEDULER_QUERY_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_QUERY_TIMEOUT_MS),
    );

    let outcome = match tokio::time::timeout(timeout, execute(state, s)).await {
        Ok(r) => r,
        Err(_) => Err(format!("Query exceeded {}ms", timeout.as_millis())),
    };
    let duration_ms = started.elapsed().as_millis() as i32;

    let rows = match outcome {
        Ok(rows) => rows,
        Err(message) => {
            let trimmed: String = message.chars().take(2000).collect();
            let _ = sqlx::query(
                r#"UPDATE "ScheduledQueryRun"
                      SET "status" = 'FAILED'::"ScheduledRunStatus", "finishedAt" = now(),
                          "durationMs" = $2, "errorMessage" = $3
                    WHERE "id" = $1"#,
            )
            .bind(&run_id)
            .bind(duration_ms)
            .bind(&trimmed)
            .execute(&state.pool)
            .await;
            let _ = sqlx::query(
                r#"UPDATE "ScheduledQuery"
                      SET "lastRunAt" = now(), "lastStatus" = 'FAILED'::"ScheduledRunStatus"
                    WHERE "id" = $1"#,
            )
            .bind(&s.id)
            .execute(&state.pool)
            .await;
            return Err(trimmed);
        }
    };

    let condition = s.alert_condition.as_ref().filter(|v| !v.is_null());
    let alert = evaluate_alert(condition, &rows);
    let in_cooldown = condition.is_some()
        && alert.triggered
        && match (s.last_alerted_at, s.alert_cooldown_min) {
            (Some(last), Some(mins)) => {
                let age = chrono::Utc::now().naive_utc() - last;
                age < chrono::Duration::minutes(mins as i64)
            }
            _ => false,
        };

    let preview: Vec<Value> = rows.iter().take(MAX_PREVIEW_ROWS).cloned().collect();
    sqlx::query(
        r#"UPDATE "ScheduledQueryRun"
              SET "status" = 'SUCCESS'::"ScheduledRunStatus", "finishedAt" = now(),
                  "rowCount" = $2, "durationMs" = $3, "resultPreview" = $4,
                  "alertTriggered" = $5, "alertSummary" = $6
            WHERE "id" = $1"#,
    )
    .bind(&run_id)
    .bind(rows.len() as i32)
    .bind(duration_ms)
    .bind(Value::Array(preview))
    .bind(condition.is_some() && alert.triggered)
    .bind(condition.map(|_| alert.summary.clone()))
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    // v1: only stamp lastAlertedAt when a notification actually goes out, or
    // the cooldown window slides on every evaluation and suppresses real alerts.
    let will_notify = condition.is_none() || (alert.triggered && !in_cooldown);
    let stamp_alert = will_notify && condition.is_some();
    sqlx::query(&format!(
        r#"UPDATE "ScheduledQuery"
              SET "lastRunAt" = now(), "lastStatus" = 'SUCCESS'::"ScheduledRunStatus"{}
            WHERE "id" = $1"#,
        if stamp_alert { r#", "lastAlertedAt" = now()"# } else { "" }
    ))
    .bind(&s.id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    if !will_notify {
        // Condition unmet or suppressed: a silent run. The run row still exists
        // so the history chart shows it happened.
        return Ok(());
    }

    notify(state, s, &run_id, &rows, duration_ms, condition.is_some(), &alert.summary).await;
    Ok(())
}

/// Run the schedule's SQL as its owner and return the rows as JSON.
///
/// v1 builds the driver with `Role.OWNER` *as the schedule's owner* — masking
/// policies are deliberately bypassed, because a masked user must not be able
/// to schedule `SELECT ssn FROM employees` and have the real values mailed out.
/// Same here: `connect_target` is handed `ownerId`.
async fn execute(state: &AppState, s: &Schedule) -> Result<Vec<Value>, String> {
    let mut conn = connect_target(state, &s.connection_id, &s.owner_id)
        .await
        .map_err(|e| e.message)?;

    let timeout_ms: i32 = sqlx::query_scalar(r#"SELECT "statementTimeoutMs" FROM "Connection" WHERE "id" = $1"#)
        .bind(&s.connection_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten()
        .unwrap_or(30_000);
    let _ = sqlx::query(&format!("SET statement_timeout = {timeout_ms}"))
        .execute(&mut *conn)
        .await;

    // Unqualified table names resolve against the schedule's schema, exactly as
    // v1 passes `{ searchPath }` to the driver.
    if let Some(schema) = s.schema_name.as_deref().filter(|v| !v.is_empty()) {
        if !schema.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(format!("Invalid schema name {schema:?}"));
        }
        let _ = sqlx::query(&format!("SET search_path = \"{schema}\""))
            .execute(&mut *conn)
            .await;
    }

    let sql = s.sql_text.trim().trim_end_matches(';').trim();
    if sql.is_empty() {
        return Err("Schedule has no SQL".into());
    }
    let lowered = sql.to_lowercase();
    let returns_rows =
        lowered.starts_with("select") || lowered.starts_with("with") || lowered.starts_with("table");

    if returns_rows {
        // Same jsonb round-trip the ad-hoc runner uses, so every column type
        // serializes. Capped: the result is held in memory and mailed.
        let wrapped = format!(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT * FROM ({sql}) _q LIMIT {MAX_EMAIL_ROWS}) t"
        );
        let v: Value = sqlx::query_scalar(&wrapped)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        Ok(match v {
            Value::Array(a) => a,
            _ => vec![],
        })
    } else {
        // DML/DDL: v1's driver returns no rows, just an affected count.
        let res = sqlx::query(sql)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        Ok(vec![json!({ "rowsAffected": res.rows_affected() })])
    }
}

// ---------------------------------------------------------------------------
// Alert conditions — port of v1's alert-evaluator.ts
// ---------------------------------------------------------------------------

struct AlertOutcome {
    triggered: bool,
    summary: String,
}

fn operator_symbol(op: &str) -> &'static str {
    match op {
        "gt" | "rows_gt" => ">",
        "gte" | "rows_gte" => ">=",
        "lt" | "rows_lt" => "<",
        "lte" => "<=",
        "eq" | "rows_eq" => "==",
        "neq" => "!=",
        _ => "?",
    }
}

fn compare(a: f64, op: &str, b: f64) -> bool {
    match op {
        "gt" => a > b,
        "gte" => a >= b,
        "lt" => a < b,
        "lte" => a <= b,
        "eq" => a == b,
        "neq" => a != b,
        _ => false,
    }
}

/// JS `Number(v)`: numbers pass through, numeric strings parse, anything else
/// is not a number. (The Postgres driver hands back `numeric`/`bigint` as
/// strings, which is exactly why v1 accepts them.)
fn to_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn evaluate_alert(cond: Option<&Value>, rows: &[Value]) -> AlertOutcome {
    let Some(cond) = cond else {
        return AlertOutcome { triggered: false, summary: "no alert condition".into() };
    };
    let op = cond.get("op").and_then(Value::as_str).unwrap_or_default().to_string();
    let value = to_number(cond.get("value")).unwrap_or(f64::NAN);

    if let Some(rest) = op.strip_prefix("rows_") {
        let count = rows.len() as f64;
        return AlertOutcome {
            triggered: compare(count, rest, value),
            summary: format!("rows={} {} {}", rows.len(), operator_symbol(&op), fmt_num(value)),
        };
    }
    let Some(column) = cond.get("column").and_then(Value::as_str).filter(|c| !c.is_empty()) else {
        return AlertOutcome { triggered: false, summary: "invalid condition: missing column".into() };
    };
    if rows.is_empty() {
        return AlertOutcome {
            triggered: false,
            summary: "no rows returned; nothing to evaluate".into(),
        };
    }
    let cell = rows[0].get(column);
    let Some(num) = to_number(cell) else {
        return AlertOutcome {
            triggered: false,
            summary: format!(
                "column \"{column}\" is not numeric (value={})",
                match cell {
                    None | Some(Value::Null) => "null".to_string(),
                    Some(Value::String(s)) => s.clone(),
                    Some(other) => other.to_string(),
                }
            ),
        };
    };
    AlertOutcome {
        triggered: compare(num, &op, value),
        summary: format!("{column}={} {} {}", fmt_num(num), operator_symbol(&op), fmt_num(value)),
    }
}

/// Render like JS: whole floats print without a trailing `.0`.
fn fmt_num(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async fn notify(
    state: &AppState,
    s: &Schedule,
    run_id: &str,
    rows: &[Value],
    duration_ms: i32,
    is_alert: bool,
    alert_summary: &str,
) {
    let subject = if is_alert {
        format!("[Query Schema alert] {} — {}", s.name, alert_summary)
    } else {
        format!("[Query Schema] {} — {} rows", s.name, rows.len())
    };
    let body = if is_alert {
        format!(
            "Alert \"{}\" fired.\n\nCondition matched: {alert_summary}\nRows: {}\nDuration: {duration_ms}ms\n",
            s.name,
            rows.len()
        )
    } else {
        format!(
            "Scheduled query \"{}\" completed successfully.\n\nRows: {}\nDuration: {duration_ms}ms\n",
            s.name,
            rows.len()
        )
    };

    let recipients: Vec<String> = s
        .email_to
        .split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if !recipients.is_empty() {
        let html = email_html(&s.name, rows, duration_ms, is_alert, alert_summary, s.timezone.as_deref());
        let csv = to_csv(rows);
        let filename = format!(
            "{}.csv",
            s.name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect::<String>()
        );
        match send_report(state, &recipients, &subject, &body, &html, &csv, &filename).await {
            Ok(()) => {
                let _ = sqlx::query(r#"UPDATE "ScheduledQueryRun" SET "emailDelivered" = true WHERE "id" = $1"#)
                    .bind(run_id)
                    .execute(&state.pool)
                    .await;
            }
            Err(e) => {
                let trimmed: String = e.chars().take(2000).collect();
                tracing::warn!("scheduled query {} email failed: {trimmed}", s.id);
                let _ = sqlx::query(r#"UPDATE "ScheduledQueryRun" SET "emailError" = $2 WHERE "id" = $1"#)
                    .bind(run_id)
                    .bind(&trimmed)
                    .execute(&state.pool)
                    .await;
            }
        }
    }

    if let Some(webhook) = s.slack_webhook.as_deref().filter(|w| !w.is_empty()) {
        if let Err(e) = post_slack(state, webhook, &s.name, &body, rows).await {
            // v1 logs and carries on: Slack must not break the email path.
            tracing::warn!("Slack post failed for {}: {e}", s.id);
        }
    }
}

/// Resend send with the full result attached as CSV. `send_mail` in main.rs
/// has no attachment support and is deliberately silent about failures (it
/// serves password-reset flows, where saying "that address bounced" leaks
/// whether an account exists); a scheduled report is the opposite — the run
/// row records exactly why delivery failed.
async fn send_report(
    state: &AppState,
    to: &[String],
    subject: &str,
    text: &str,
    html: &str,
    csv: &str,
    filename: &str,
) -> Result<(), String> {
    let (Some(key), Some(from)) = (state.resend_key.as_ref(), state.mail_from.as_ref()) else {
        return Err("mail is not configured on this server (RESEND_API_KEY/RESEND_FROM)".into());
    };
    let mut payload = json!({
        "from": from,
        "to": to,
        "subject": subject,
        "text": text,
        "html": html,
    });
    if !csv.is_empty() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(csv.as_bytes());
        payload["attachments"] = json!([{ "filename": filename, "content": encoded }]);
    }
    let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let res = state
        .http
        .post("https://api.resend.com/emails")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let detail = res.text().await.unwrap_or_default();
    Err(format!("Resend {status}: {}", detail.chars().take(200).collect::<String>()))
}

async fn post_slack(
    state: &AppState,
    webhook: &str,
    name: &str,
    body: &str,
    rows: &[Value],
) -> Result<(), String> {
    let sample = if rows.is_empty() {
        "_(no rows)_".to_string()
    } else {
        let joined = rows
            .iter()
            .take(SLACK_PREVIEW_ROWS)
            .map(|r| r.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        format!("```\n{}\n```", joined.chars().take(2500).collect::<String>())
    };
    let payload = json!({
        "text": name,
        "blocks": [
            { "type": "header", "text": { "type": "plain_text", "text": name } },
            { "type": "section", "text": { "type": "mrkdwn", "text": body } },
            { "type": "section", "text": { "type": "mrkdwn", "text": sample } },
        ]
    });
    let res = state
        .http
        .post(webhook)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&payload).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        return Ok(());
    }
    let status = res.status();
    let detail = res.text().await.unwrap_or_default();
    Err(format!("Slack {status}: {}", detail.chars().take(200).collect::<String>()))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

fn cell_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

/// Column order as Postgres returned it. `to_jsonb(t)` yields an object, and
/// serde_json preserves insertion order only with the `preserve_order` feature,
/// so take the keys of the first row as the header and accept map ordering —
/// same columns either way, which is what matters for a preview.
fn headers_of(rows: &[Value]) -> Vec<String> {
    rows.first()
        .and_then(Value::as_object)
        .map(|m: &Map<String, Value>| m.keys().take(EMAIL_PREVIEW_COLS).cloned().collect())
        .unwrap_or_default()
}

fn to_csv(rows: &[Value]) -> String {
    let Some(first) = rows.first().and_then(Value::as_object) else {
        return String::new();
    };
    let headers: Vec<String> = first.keys().cloned().collect();
    let escape = |s: String| -> String {
        if s.contains('"') || s.contains(',') || s.contains('\n') || s.contains('\r') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s
        }
    };
    let mut out = String::new();
    out.push_str(&headers.iter().cloned().map(escape).collect::<Vec<_>>().join(","));
    for row in rows {
        out.push('\n');
        let line: Vec<String> = headers
            .iter()
            .map(|h| escape(cell_text(row.get(h))))
            .collect();
        out.push_str(&line.join(","));
    }
    out
}

/// The result preview, in the same dark shell as the rest of the product's
/// mail. Inline styles only — every mail client drops <style> blocks.
fn email_html(
    name: &str,
    rows: &[Value],
    duration_ms: i32,
    is_alert: bool,
    alert_summary: &str,
    _timezone: Option<&str>,
) -> String {
    let headers = headers_of(rows);
    let header_cells: String = headers
        .iter()
        .map(|h| format!(
            r#"<th style="text-align:left;padding:9px 14px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#8a938f;white-space:nowrap;border-bottom:1px solid #262b29;">{}</th>"#,
            html_escape(h)
        ))
        .collect();

    let body_rows: String = rows
        .iter()
        .take(EMAIL_PREVIEW_ROWS)
        .enumerate()
        .map(|(i, r)| {
            let bg = if i % 2 == 1 { "#1a1e1f" } else { "#15181a" };
            let cells: String = headers
                .iter()
                .map(|h| format!(
                    r#"<td style="padding:9px 14px;font-size:13px;color:#d7dcd9;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid #20251f;">{}</td>"#,
                    html_escape(&truncate(&cell_text(r.get(h)), EMAIL_CELL_MAX))
                ))
                .collect();
            format!(r#"<tr style="background:{bg};">{cells}</tr>"#)
        })
        .collect();

    let table = if rows.is_empty() {
        r#"<p style="color:#8a938f;font-style:italic;margin:0;">Query returned no rows.</p>"#.to_string()
    } else {
        format!(
            r#"<div style="overflow:hidden;border:1px solid #262b29;border-radius:10px;">
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
<thead><tr style="background:#191d1c;">{header_cells}</tr></thead><tbody>{body_rows}</tbody></table></div>"#
        )
    };

    let mut notes: Vec<String> = Vec::new();
    if rows.len() > EMAIL_PREVIEW_ROWS {
        notes.push(format!(
            "Showing first {EMAIL_PREVIEW_ROWS} of {} rows — full results in the attached CSV.",
            rows.len()
        ));
    }
    if rows
        .first()
        .and_then(Value::as_object)
        .map(|m| m.len() > EMAIL_PREVIEW_COLS)
        .unwrap_or(false)
    {
        notes.push("Some columns are hidden in this preview; the CSV has them all.".into());
    }
    let note_html = if notes.is_empty() {
        String::new()
    } else {
        format!(
            r#"<p style="font-size:12px;color:#8a938f;margin-top:12px;">{}</p>"#,
            html_escape(&notes.join(" "))
        )
    };

    let meta = format!(
        "{}{} row{} · {duration_ms}ms",
        if is_alert { format!("🔔 Alert fired — {} · ", html_escape(alert_summary)) } else { String::new() },
        rows.len(),
        if rows.len() == 1 { "" } else { "s" }
    );

    format!(
        r#"<!doctype html><html><body style="margin:0;padding:24px;background:#0b0f14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:760px;background:#111820;border:1px solid #1e2733;border-radius:14px;padding:28px">
<tr><td style="color:#3ECF8E;font-weight:700;font-size:15px;padding-bottom:18px">Query Schema</td></tr>
<tr><td style="color:#e6e9ef;font-size:20px;font-weight:700;padding-bottom:6px">{}</td></tr>
<tr><td style="color:#8a938f;font-size:13px;padding-bottom:16px">{meta}</td></tr>
<tr><td>{table}{note_html}</td></tr>
<tr><td style="color:#5c6875;font-size:12px;line-height:19px;padding-top:24px">Sent by Query Schema · scheduled query</td></tr>
</table></td></tr></table></body></html>"#,
        html_escape(name)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(n: usize) -> Vec<Value> {
        (0..n).map(|i| json!({ "n": i, "label": format!("r{i}") })).collect()
    }

    #[test]
    fn row_count_conditions_ignore_the_column() {
        let c = json!({ "op": "rows_gt", "value": 0 });
        assert!(evaluate_alert(Some(&c), &rows(1)).triggered);
        assert!(!evaluate_alert(Some(&c), &rows(0)).triggered);
        let empty = json!({ "op": "rows_eq", "value": 0 });
        assert!(evaluate_alert(Some(&empty), &rows(0)).triggered);
        assert_eq!(evaluate_alert(Some(&empty), &rows(0)).summary, "rows=0 == 0");
    }

    #[test]
    fn column_conditions_read_the_first_row_and_accept_numeric_strings() {
        let c = json!({ "column": "count", "op": "gte", "value": 5 });
        let numeric = vec![json!({ "count": 7 })];
        assert!(evaluate_alert(Some(&c), &numeric).triggered);
        // pg hands back bigint/numeric as a string.
        let as_string = vec![json!({ "count": "7" })];
        assert!(evaluate_alert(Some(&c), &as_string).triggered);
        let under = vec![json!({ "count": 4 })];
        assert!(!evaluate_alert(Some(&c), &under).triggered);
        assert_eq!(evaluate_alert(Some(&c), &under).summary, "count=4 >= 5");
    }

    #[test]
    fn non_numeric_or_missing_data_never_triggers() {
        let c = json!({ "column": "count", "op": "gt", "value": 1 });
        assert!(!evaluate_alert(Some(&c), &[]).triggered);
        let text = vec![json!({ "count": "many" })];
        let out = evaluate_alert(Some(&c), &text);
        assert!(!out.triggered);
        assert!(out.summary.contains("not numeric"));
        // No condition at all is the plain "mail me the result" schedule.
        assert!(!evaluate_alert(None, &rows(3)).triggered);
    }

    #[test]
    fn csv_quotes_only_what_needs_it() {
        let rows = vec![json!({ "a": "plain", "b": "has,comma" }), json!({ "a": "q\"uote", "b": null })];
        let csv = to_csv(&rows);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "a,b");
        assert_eq!(lines[1], "plain,\"has,comma\"");
        assert_eq!(lines[2], "\"q\"\"uote\",");
        assert_eq!(to_csv(&[]), "");
    }
}
