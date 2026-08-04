//! AI assistant â€” Rust port of the v1 NestJS `src/ai/` module (controllers,
//! services and the three provider adapters), plus the per-user daily AI quota
//! from `src/operator/ai-quota.service.ts` (which is a *billing* control, so it
//! is reproduced here rather than left to v1).
//!
//! Wire-compatible with v1: same paths, methods, status codes, error messages
//! and JSON field names.
//!
//! v1 sources of truth:
//!   backend/src/ai/ai.controller.ts            -> POST /api/connections/:id/ai/generate-sql
//!   backend/src/ai/ai.service.ts               -> one-shot SQL generation
//!   backend/src/ai/ai-chat.controller.ts       -> /api/ai/chats*
//!   backend/src/ai/ai-chat.service.ts          -> persistent chat + schema context
//!   backend/src/ai/providers/*.ts              -> Anthropic / Gemini / OpenAI-compat
//!   backend/src/operator/ai-quota.service.ts   -> AiUsageDay daily cap (402)
//!   backend/src/billing/plan.service.ts + plans.ts -> effective plan for a user
//!
//! The Prisma schema has no `@map`, so every table/column below is the quoted
//! PascalCase / camelCase identifier Prisma created (`"AiChat"."connectionId"`,
//! â€¦) and `DateTime` columns are `TIMESTAMP(3)` *without* time zone â†’ they
//! decode as `chrono::NaiveDateTime`, never `DateTime<Utc>`.
//!
//! NOT PORTED HERE â€” `src/federated/` (`POST /api/federated/query`,
//! `POST /api/federated/explain`). That service runs the whole query inside an
//! in-process **DuckDB** instance (`@duckdb/node-api`), `ATTACH`-ing every
//! source through DuckDB's postgres/mysql/sqlite scanner extensions, and parses
//! DuckDB's `EXPLAIN` output for the pushdown plan. v2 has no DuckDB dependency
//! (and Cargo.toml is out of scope for this port), so there is nothing to run
//! the federation on. Both routes therefore fall through to `main.rs`'s
//! strangler `.fallback(proxy)` and are served by v1 exactly as before â€”
//! including its column-mask enforcement over federated results.
//!
//! The AI calls reach the provider over HTTPS with `state.http` (reqwest has
//! `rustls-tls`). reqwest is built without the `json` feature, so bodies are
//! `serde_json::to_vec`'d and `content-type` is set by hand. v1's provider
//! interface is explicitly non-streaming ("If we add streaming later, do it as
//! a second method"), and the frontend awaits a single JSON object, so there is
//! no SSE to reproduce.

use std::collections::{HashMap, HashSet};

use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::{Connection, PgConnection, Row};

use crate::{conn_role, connect_target, gen_id, iso, ApiError, ApiResult, AppState, AuthUser};

/// Every AI route at its full v1 path (the Nest app sets a global `api`
/// prefix, so `@Controller('ai/chats')` serves `/api/ai/chats`).
pub fn routes() -> Router<AppState> {
    Router::new()
        // --- AiChatController (JwtAuthGuard on the whole controller) ---
        // `quota` and `messages` are static segments, so axum's router matches
        // them ahead of `:id` regardless of registration order â€” same effective
        // precedence as Nest's declaration order.
        .route("/api/ai/chats/quota", get(quota_status))
        .route("/api/ai/chats/messages", post(send_message))
        .route("/api/ai/chats", get(chat_list))
        .route("/api/ai/chats/:id", get(chat_get).delete(chat_remove))
        // --- AiController (RbacGuard + @RequireRole('VIEWER')) ---
        .route("/api/connections/:id/ai/generate-sql", post(generate_sql))
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

fn text(r: &PgRow, col: &str) -> String {
    r.try_get::<String, _>(col).unwrap_or_default()
}

fn opt_text(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<Option<String>, _>(col).ok().flatten()
}

/// JS `s.slice(0, max)`. Rust slices by chars where JS slices by UTF-16 code
/// units; identical for everything short of astral-plane text, and never panics
/// mid-codepoint the way byte slicing would.
fn take_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// v1's `RbacService.require`, including its exact 404/403 messages and the
/// `RANK[role] < RANK[min]` comparison. Connection owner > direct
/// ConnectionMember grant > workspace membership (see `conn_role`).
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    let Some(role) = conn_role(&state.pool, conn_id, user_id).await? else {
        let exists: Option<String> =
            sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                .bind(conn_id)
                .fetch_optional(&state.pool)
                .await?
                .flatten();
        if exists.is_none() {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found"));
        }
        return Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"));
    };
    if rank(&role) < rank(min) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {min} role (have {role})"),
        ));
    }
    Ok(role)
}

fn rank(role: &str) -> i32 {
    match role {
        "OWNER" => 3,
        "EDITOR" => 2,
        "VIEWER" => 1,
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// Provider selection â€” port of `providers/ai-provider.factory.ts`
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Anthropic,
    Gemini,
    /// Any `/v1/chat/completions` host: OpenAI, Groq, OpenRouter, Ollama.
    OpenAiCompat,
}

struct Provider {
    id: &'static str,
    kind: Kind,
    base_url: String,
    api_key: Option<String>,
    model: String,
    /// Some hosts (Ollama local) don't require a key.
    key_required: bool,
}

impl Provider {
    /// v1's `get enabled()` on each provider class.
    fn enabled(&self) -> bool {
        if self.key_required {
            self.api_key.is_some()
        } else {
            !self.base_url.is_empty()
        }
    }
}

/// v1's config schema normalizes `''` (from `docker compose ${FOO:-}`) to
/// undefined via `z.string().transform((v) => v || undefined)`, so an empty
/// env var must read as "not configured", not as an empty key.
fn env_opt(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// The primary provider, or `None` when `AI_PROVIDER` pins an id we don't know.
///
/// Resolution order for `AI_PROVIDER=auto` (v1's `resolvePrimary`):
///   Anthropic â†’ Gemini â†’ OpenAI â†’ Groq â†’ OpenRouter â†’ Ollama
/// When `AI_PROVIDER` is pinned we return that provider whether or not it is
/// configured, so the failure is a clear "not configured" rather than a silent
/// fallback to Anthropic.
fn primary_provider() -> Option<Provider> {
    // Default model per provider â€” chosen for cheap-but-capable SQL work. Each
    // can be overridden globally via AI_MODEL.
    let ai_model = env_opt("AI_MODEL");
    let model_for = |fallback: String| ai_model.clone().unwrap_or(fallback);

    // ANTHROPIC_MODEL uses `z.string().default(...)`, which (unlike the keys)
    // does NOT map '' to undefined â€” an explicitly empty value stays empty.
    let anthropic_model =
        std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-haiku-4-5-20251001".to_string());

    let providers = vec![
        Provider {
            id: "anthropic",
            kind: Kind::Anthropic,
            // `new Anthropic({ apiKey })` defaults its baseURL to
            // process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'.
            base_url: env_opt("ANTHROPIC_BASE_URL").unwrap_or_else(|| "https://api.anthropic.com".into()),
            api_key: env_opt("ANTHROPIC_API_KEY"),
            model: model_for(anthropic_model),
            key_required: true,
        },
        Provider {
            id: "gemini",
            kind: Kind::Gemini,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            api_key: env_opt("GEMINI_API_KEY"),
            model: model_for("gemini-2.0-flash".into()),
            key_required: true,
        },
        Provider {
            id: "openai",
            kind: Kind::OpenAiCompat,
            base_url: "https://api.openai.com/v1".into(),
            api_key: env_opt("OPENAI_API_KEY"),
            model: model_for("gpt-4o-mini".into()),
            key_required: true,
        },
        Provider {
            id: "groq",
            kind: Kind::OpenAiCompat,
            base_url: "https://api.groq.com/openai/v1".into(),
            api_key: env_opt("GROQ_API_KEY"),
            model: model_for("llama-3.3-70b-versatile".into()),
            key_required: true,
        },
        Provider {
            id: "openrouter",
            kind: Kind::OpenAiCompat,
            base_url: "https://openrouter.ai/api/v1".into(),
            api_key: env_opt("OPENROUTER_API_KEY"),
            model: model_for("meta-llama/llama-3.3-70b-instruct".into()),
            key_required: true,
        },
        Provider {
            id: "ollama",
            kind: Kind::OpenAiCompat,
            base_url: env_opt("OLLAMA_BASE_URL").unwrap_or_else(|| "http://localhost:11434/v1".into()),
            api_key: None,
            model: model_for("llama3.2".into()),
            key_required: false,
        },
    ];

    let choice = std::env::var("AI_PROVIDER").unwrap_or_else(|_| "auto".into());
    if choice != "auto" {
        return providers.into_iter().find(|p| p.id == choice);
    }
    providers.into_iter().find(|p| p.enabled())
}

// ---------------------------------------------------------------------------
// Provider calls â€” ports of anthropic-provider.ts / gemini-provider.ts /
// openai-compat-provider.ts.
// ---------------------------------------------------------------------------

/// v1 lets a provider throw a plain `Error` for transport/shape failures. Nest's
/// global filter turns any non-`HttpException` into
/// `500 {"message":"Internal server error"}` â€” so that (not the raw cause) is
/// what the client sees. The real reason is logged instead, exactly as v1's
/// filter logs it.
fn unhandled(context: &str) -> ApiError {
    tracing::error!("ai provider error: {context}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

/// JS `str.slice(0, 200)` on a provider error body.
fn err_snippet(s: &str) -> String {
    take_chars(s, 200)
}

/// One turn of conversation, in v1's universal `AiGenerateInput` shape.
struct Turn {
    role: &'static str,
    content: String,
}

/// `IAiProvider.generate` â€” returns the assistant's text reply.
async fn provider_generate(
    state: &AppState,
    p: &Provider,
    system: &str,
    messages: &[Turn],
    max_tokens: u32,
) -> ApiResult<String> {
    match p.kind {
        Kind::Anthropic => anthropic_generate(state, p, system, messages, max_tokens).await,
        Kind::Gemini => gemini_generate(state, p, system, messages, max_tokens).await,
        Kind::OpenAiCompat => openai_generate(state, p, system, messages, max_tokens).await,
    }
}

async fn anthropic_generate(
    state: &AppState,
    p: &Provider,
    system: &str,
    messages: &[Turn],
    max_tokens: u32,
) -> ApiResult<String> {
    let Some(key) = p.api_key.as_ref() else {
        return Err(unhandled("Anthropic provider is not configured"));
    };
    let payload = json!({
        "model": p.model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages.iter().map(|m| json!({ "role": m.role, "content": m.content })).collect::<Vec<_>>(),
    });
    // reqwest is built without the `json` feature â€” serialize by hand.
    let body = serde_json::to_vec(&payload).map_err(|e| unhandled(&format!("anthropic encode: {e}")))?;
    let url = format!("{}/v1/messages", p.base_url.trim_end_matches('/'));
    let res = state
        .http
        .post(&url)
        .header("x-api-key", key.as_str())
        .header("anthropic-version", "2023-06-01")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| unhandled(&format!("anthropic request failed: {e}")))?;

    // The official SDK throws an `APIError` on a non-2xx, which is NOT an
    // HttpException â†’ v1 answers 500. Reproduced by `unhandled`.
    let status = res.status();
    let raw = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(unhandled(&format!("anthropic {}: {}", status.as_u16(), err_snippet(&raw))));
    }
    let data: Value =
        serde_json::from_str(&raw).map_err(|e| unhandled(&format!("anthropic bad json: {e}")))?;
    // `resp.content.find((b) => b.type === 'text')`
    let block = data
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|a| a.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str());
    match block {
        Some(t) => Ok(t.trim().to_string()),
        None => Err(unhandled("Anthropic returned no text content")),
    }
}

async fn gemini_generate(
    state: &AppState,
    p: &Provider,
    system: &str,
    messages: &[Turn],
    max_tokens: u32,
) -> ApiResult<String> {
    let Some(key) = p.api_key.as_ref() else {
        return Err(unhandled("Gemini provider is not configured"));
    };
    // v1beta `:generateContent` â€” the sync-text method.
    let url = format!(
        "{}/models/{}:generateContent?key={}",
        p.base_url.trim_end_matches('/'),
        url_encode(&p.model),
        url_encode(key),
    );
    // Gemini's shape differs: systemInstruction is top-level, messages are
    // `contents: [{ role, parts: [{ text }] }]`, and role is "user" | "model".
    let payload = json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": messages.iter().map(|m| json!({
            "role": if m.role == "assistant" { "model" } else { "user" },
            "parts": [{ "text": m.content }],
        })).collect::<Vec<_>>(),
        "generationConfig": { "maxOutputTokens": max_tokens },
    });
    let body = serde_json::to_vec(&payload).map_err(|e| unhandled(&format!("gemini encode: {e}")))?;
    let res = state
        .http
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| unhandled(&format!("gemini request failed: {e}")))?;

    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        if status == 429 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Gemini quota exceeded â€” check your plan at aistudio.google.com/apikey, or switch to another provider (AI_PROVIDER=groq/openai/anthropic).",
            ));
        }
        if status == 401 || status == 403 {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "Gemini API key rejected. Rotate the key at aistudio.google.com/apikey and update GEMINI_API_KEY.",
            ));
        }
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Gemini {status}: {}", err_snippet(&raw)),
        ));
    }

    let data: Value = serde_json::from_str(&raw).map_err(|e| unhandled(&format!("gemini bad json: {e}")))?;
    let candidates = data.get("candidates").and_then(|c| c.as_array());
    // Safety / block responses don't include candidates.
    let Some(candidates) = candidates.filter(|a| !a.is_empty()) else {
        let blocked = data
            .get("promptFeedback")
            .and_then(|f| f.get("blockReason"))
            .and_then(|b| b.as_str());
        return Err(unhandled(&match blocked {
            Some(r) => format!("Gemini blocked the request ({r})"),
            None => "Gemini returned no candidates".to_string(),
        }));
    };
    let t: String = candidates[0]
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .map(|p| p.get("text").and_then(|t| t.as_str()).unwrap_or(""))
                .collect::<String>()
        })
        .unwrap_or_default();
    if t.trim().is_empty() {
        return Err(unhandled("Gemini returned empty text"));
    }
    Ok(t.trim().to_string())
}

async fn openai_generate(
    state: &AppState,
    p: &Provider,
    system: &str,
    messages: &[Turn],
    max_tokens: u32,
) -> ApiResult<String> {
    if p.key_required && p.api_key.is_none() {
        return Err(unhandled(&format!("{} provider is not configured (missing API key)", p.id)));
    }
    // The system prompt is just the first message for OpenAI-compatible hosts.
    let mut msgs = vec![json!({ "role": "system", "content": system })];
    msgs.extend(messages.iter().map(|m| json!({ "role": m.role, "content": m.content })));
    let payload = json!({
        "model": p.model,
        "messages": msgs,
        "max_tokens": max_tokens,
        "temperature": 0.2,
    });
    let body =
        serde_json::to_vec(&payload).map_err(|e| unhandled(&format!("{} encode: {e}", p.id)))?;

    let url = format!("{}/chat/completions", p.base_url.trim_end_matches('/'));
    let mut rb = state
        .http
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    if let Some(key) = p.api_key.as_ref() {
        rb = rb.header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"));
    }
    let res = rb
        .body(body)
        .send()
        .await
        .map_err(|e| unhandled(&format!("{} request failed: {e}", p.id)))?;

    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let id = p.id;
        if status == 429 || status == 413 {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                format!("{id} rate limit hit â€” try again in a minute, ask a more specific question (smaller schema context), or switch provider."),
            ));
        }
        if status == 401 || status == 403 {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                format!("{id} API key rejected. Check the key in your .env file."),
            ));
        }
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("{id} {status}: {}", err_snippet(&raw)),
        ));
    }

    let data: Value = serde_json::from_str(&raw).map_err(|e| unhandled(&format!("{} bad json: {e}", p.id)))?;
    let t = data
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim())
        .unwrap_or("");
    if t.is_empty() {
        return Err(unhandled(&format!("{} returned empty content", p.id)));
    }
    Ok(t.to_string())
}

/// `encodeURIComponent` for the pieces v1 interpolates into the Gemini URL.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// AI quota â€” port of operator/ai-quota.service.ts (+ billing/plan.service.ts)
//
// A billing control: without it every user gets unlimited paid-provider calls.
// Rules:
//   - Suspended users: 0 calls. Hard block.
//   - No AI-enabled plan across their workspaces: 0 calls.
//   - Otherwise allowance = plan.dailyAiCalls + (top-up packs across the user's
//     ACTIVE/TRIALING/PAST_DUE workspace subs) * BillingSettings.aiTopUpCallsPerPack.
// Day boundary is UTC; the (userId, day) unique index makes the upsert race-free.
// ---------------------------------------------------------------------------

/// The slice of `PlanConfig` the AI gate needs.
struct PlanAi {
    tier: String,
    ai_enabled: bool,
    daily_ai_calls: i32,
}

/// v1 `DEFAULT_PLANS` â€” used when the operator-editable PlanConfig row is absent.
fn default_plan(tier: &str) -> PlanAi {
    let (ai, calls) = match tier {
        "PRO" => (true, 50),
        "TEAM" => (true, 200),
        _ => (false, 0),
    };
    PlanAi { tier: tier.to_string(), ai_enabled: ai, daily_ai_calls: calls }
}

/// v1 `LOCKED_LIMITS` â€” no active entitlement means no AI at all.
fn locked_plan() -> PlanAi {
    PlanAi { tier: "FREE".into(), ai_enabled: false, daily_ai_calls: 0 }
}

/// `TIER_ORDER.indexOf(tier)` â€” JS returns -1 for an unknown tier.
fn tier_index(tier: &str) -> i32 {
    match tier {
        "FREE" => 0,
        "PRO" => 1,
        "TEAM" => 2,
        _ => -1,
    }
}

/// `PlanService.config(tier)`: the DB row, else the coded default.
async fn plan_config(state: &AppState, tier: &str) -> ApiResult<PlanAi> {
    let row = sqlx::query(
        r#"SELECT "aiEnabled","dailyAiCalls" FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#,
    )
    .bind(tier)
    .fetch_optional(&state.pool)
    .await?;
    Ok(match row {
        Some(r) => PlanAi {
            tier: tier.to_string(),
            ai_enabled: r.try_get::<bool, _>("aiEnabled").unwrap_or(false),
            daily_ai_calls: r.try_get::<i32, _>("dailyAiCalls").unwrap_or(0),
        },
        None => default_plan(tier),
    })
}

/// `PlanService.forUser`: the strongest plan the user is entitled to across
/// every workspace they belong to *or own*. "Strongest" = AI-enabled with the
/// highest daily allowance; ties break by tier order.
///
/// v1 runs two queries (member workspaces, then owned workspaces) and
/// concatenates them; the reduce below is order-independent (two distinct tiers
/// can never tie on all three keys), so one query with the same predicate is
/// equivalent.
async fn plan_for_user(state: &AppState, user_id: &str) -> ApiResult<PlanAi> {
    let rows = sqlx::query(
        r#"SELECT s."plan"::text AS "plan", s."status"::text AS "status", s."periodEnd"
             FROM "Subscription" s
             JOIN "Workspace" w ON w."id" = s."workspaceId"
            WHERE w."ownerId" = $1
               OR EXISTS (SELECT 1 FROM "WorkspaceMember" wm
                           WHERE wm."workspaceId" = s."workspaceId" AND wm."userId" = $1)"#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;

    // v1 `isEntitled`: not SUSPENDED and the period is still open. Both a lapsed
    // trial and a lapsed paid plan drop to LOCKED. Compared in Rust (not `now()`
    // in SQL) because `periodEnd` is `timestamp WITHOUT time zone` holding UTC â€”
    // letting Postgres coerce `now()` would apply the session TimeZone.
    let now = chrono::Utc::now().naive_utc();
    let mut tiers: Vec<String> = Vec::new();
    for r in &rows {
        // Security-relevant: a decode failure must not silently grant access.
        let status: String = r.try_get("status").map_err(|e| ApiError::internal(e.to_string()))?;
        let period_end: chrono::NaiveDateTime =
            r.try_get("periodEnd").map_err(|e| ApiError::internal(e.to_string()))?;
        let plan: String = r.try_get("plan").map_err(|e| ApiError::internal(e.to_string()))?;
        if status != "SUSPENDED" && period_end > now && !tiers.contains(&plan) {
            tiers.push(plan);
        }
    }
    if tiers.is_empty() {
        return Ok(locked_plan());
    }

    let mut best: Option<PlanAi> = None;
    for t in tiers {
        let c = plan_config(state, &t).await?;
        best = Some(match best {
            None => c,
            Some(b) => {
                // v1: `Number(c.aiEnabled) - Number(best.aiEnabled)
                //      || c.dailyAiCalls - best.dailyAiCalls
                //      || TIER_ORDER.indexOf(c.tier) - TIER_ORDER.indexOf(best.tier)`
                let better = if c.ai_enabled != b.ai_enabled {
                    i32::from(c.ai_enabled) - i32::from(b.ai_enabled)
                } else if c.daily_ai_calls != b.daily_ai_calls {
                    c.daily_ai_calls - b.daily_ai_calls
                } else {
                    tier_index(&c.tier) - tier_index(&b.tier)
                };
                if better > 0 {
                    c
                } else {
                    b
                }
            }
        });
    }
    Ok(best.unwrap_or_else(locked_plan))
}

/// `AiQuotaService.computeAllowance`. Returns `(allowance, reason)`; `reason` is
/// only meaningful when the allowance is 0 and selects the 402 message.
async fn compute_allowance(state: &AppState, user_id: &str) -> ApiResult<(i64, &'static str)> {
    let user = sqlx::query(r#"SELECT "suspendedAt" FROM "User" WHERE "id" = $1"#)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(user) = user else {
        return Ok((0, "user-not-found"));
    };
    // Security-relevant column: never `.ok().flatten()` â€” a decode error must
    // not read as "not suspended".
    let suspended_at: Option<chrono::NaiveDateTime> = user
        .try_get("suspendedAt")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if suspended_at.is_some() {
        return Ok((0, "suspended"));
    }

    let plan = plan_for_user(state, user_id).await?;
    if !plan.ai_enabled || plan.daily_ai_calls <= 0 {
        return Ok((0, "plan-no-ai"));
    }

    let per_pack: i32 = sqlx::query_scalar(
        r#"SELECT "aiTopUpCallsPerPack" FROM "BillingSettings" WHERE "id" = 'singleton'"#,
    )
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(10);

    // Top-up packs stack across every workspace they're a member of that has an
    // active subscription.
    let packs_total: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(s."aiTopUpPacks"), 0)::bigint
             FROM "Subscription" s
            WHERE s."status"::text IN ('ACTIVE','TRIALING','PAST_DUE')
              AND EXISTS (SELECT 1 FROM "WorkspaceMember" wm
                           WHERE wm."workspaceId" = s."workspaceId" AND wm."userId" = $1)"#,
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;

    Ok((plan.daily_ai_calls as i64 + packs_total * per_pack as i64, ""))
}

fn today_utc() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

const DAILY_LIMIT_MSG: &str =
    "Daily limit reached â€” ask the workspace owner to buy a top-up, or wait until tomorrow.";

/// `AiQuotaService.consume` â€” consume one AI call or throw 402. Call BEFORE any
/// expensive work so we never pay a provider for a request we'll refuse.
async fn quota_consume(state: &AppState, user_id: &str) -> ApiResult<()> {
    let (allowance, reason) = compute_allowance(state, user_id).await?;
    if allowance == 0 {
        let msg = match reason {
            "suspended" => "Your account is suspended. Contact support to restore access.",
            "plan-no-ai" => {
                "The AI assistant is available on the Pro and Team plans. Upgrade your plan to use it."
            }
            _ => "AI is not available for this account.",
        };
        return Err(ApiError::new(StatusCode::PAYMENT_REQUIRED, msg));
    }

    let day = today_utc();
    let used: i32 = sqlx::query_scalar(
        r#"SELECT "callsUsed" FROM "AiUsageDay" WHERE "userId" = $1 AND "day" = $2"#,
    )
    .bind(user_id)
    .bind(&day)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(0);
    if used as i64 >= allowance {
        return Err(ApiError::new(StatusCode::PAYMENT_REQUIRED, DAILY_LIMIT_MSG));
    }

    // Atomic increment: the (userId, day) unique index means two concurrent
    // calls can't both squeeze past allowance-1.
    let after: i32 = sqlx::query_scalar(
        r#"INSERT INTO "AiUsageDay" ("id","userId","day","callsUsed","createdAt","updatedAt")
           VALUES ($1, $2, $3, 1, now(), now())
           ON CONFLICT ("userId","day")
           DO UPDATE SET "callsUsed" = "AiUsageDay"."callsUsed" + 1, "updatedAt" = now()
           RETURNING "callsUsed""#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(&day)
    .fetch_one(&state.pool)
    .await?;

    // Re-check post-increment in case the pre-check was stale under heavy
    // concurrency. Roll back the bump if we went over.
    if after as i64 > allowance {
        let _ = sqlx::query(
            r#"UPDATE "AiUsageDay" SET "callsUsed" = "callsUsed" - 1, "updatedAt" = now()
                WHERE "userId" = $1 AND "day" = $2"#,
        )
        .bind(user_id)
        .bind(&day)
        .execute(&state.pool)
        .await?;
        return Err(ApiError::new(StatusCode::PAYMENT_REQUIRED, DAILY_LIMIT_MSG));
    }
    Ok(())
}

/// `GET /api/ai/chats/quota` â€” read-only view for showing quota in the UI.
/// Never throws on a zero allowance; the UI renders "0 of 0".
async fn quota_status(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    let (allowance, _) = compute_allowance(&state, &user.id).await?;
    let day = today_utc();
    let used: i32 = sqlx::query_scalar(
        r#"SELECT "callsUsed" FROM "AiUsageDay" WHERE "userId" = $1 AND "day" = $2"#,
    )
    .bind(&user.id)
    .bind(&day)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(0);
    Ok(Json(json!({ "used": used, "allowance": allowance, "day": day })))
}

// ---------------------------------------------------------------------------
// Schema context â€” port of `introspectForER` (postgres.driver.ts) plus
// `renderSchemaContext` / `pickRelevantTables` (ai-chat.service.ts).
// ---------------------------------------------------------------------------

struct ErColumn {
    name: String,
    data_type: String,
    is_primary_key: bool,
    nullable: bool,
}

struct ErTable {
    schema: String,
    name: String,
    columns: Vec<ErColumn>,
}

struct ErFk {
    schema: String,
    table: String,
    columns: Vec<String>,
    ref_schema: String,
    ref_table: String,
    ref_columns: Vec<String>,
}

struct ErDiagram {
    tables: Vec<ErTable>,
    foreign_keys: Vec<ErFk>,
}

/// The subset of `PostgresDriver.introspectForER` the prompt renderer consumes
/// (name / dataType / isPrimaryKey / nullable, plus FK endpoints). Same
/// pg_catalog queries, same relkinds, same ordering â€” so the table order and
/// the "N other table(s) â€¦ omitted" count match v1 exactly.
async fn introspect_for_er(c: &mut PgConnection, schema: Option<&str>) -> ApiResult<ErDiagram> {
    let cols = sqlx::query(
        "SELECT n.nspname::text AS schema, cls.relname::text AS tbl, a.attname::text AS name, \
                format_type(a.atttypid, a.atttypmod) AS data_type, NOT a.attnotnull AS nullable, \
                COALESCE(pk.is_pk, false) AS is_pk \
           FROM pg_class cls JOIN pg_namespace n ON n.oid = cls.relnamespace \
           JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum > 0 AND NOT a.attisdropped \
           LEFT JOIN LATERAL (SELECT true AS is_pk FROM pg_index i WHERE i.indrelid = cls.oid \
                 AND i.indisprimary AND a.attnum = ANY(i.indkey) LIMIT 1) pk ON true \
          WHERE cls.relkind IN ('r','v','m','p') AND n.nspname NOT IN ('pg_catalog','information_schema') \
            AND ($1::text IS NULL OR n.nspname = $1) \
          ORDER BY n.nspname, cls.relname, a.attnum",
    )
    .bind(schema)
    .fetch_all(&mut *c)
    .await?;

    let mut tables: Vec<ErTable> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for r in &cols {
        let sch = text(r, "schema");
        let tbl = text(r, "tbl");
        let key = format!("{sch}.{tbl}");
        let pos = *index.entry(key).or_insert_with(|| {
            tables.push(ErTable { schema: sch.clone(), name: tbl.clone(), columns: Vec::new() });
            tables.len() - 1
        });
        tables[pos].columns.push(ErColumn {
            name: text(r, "name"),
            data_type: text(r, "data_type"),
            is_primary_key: r.try_get::<bool, _>("is_pk").unwrap_or(false),
            nullable: r.try_get::<bool, _>("nullable").unwrap_or(true),
        });
    }

    let fks = sqlx::query(
        "SELECT n.nspname::text AS schema, cls.relname::text AS tbl, \
           (SELECT array_agg(att.attname::text ORDER BY ord.pos) FROM unnest(con.conkey) WITH ORDINALITY AS ord(col,pos) \
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ord.col)::text[] AS columns, \
           rn.nspname::text AS ref_schema, rcls.relname::text AS ref_table, \
           (SELECT array_agg(att.attname::text ORDER BY ord.pos) FROM unnest(con.confkey) WITH ORDINALITY AS ord(col,pos) \
              JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = ord.col)::text[] AS ref_columns \
           FROM pg_constraint con JOIN pg_class cls ON cls.oid = con.conrelid \
           JOIN pg_namespace n ON n.oid = cls.relnamespace \
           JOIN pg_class rcls ON rcls.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rcls.relnamespace \
          WHERE con.contype = 'f' AND n.nspname NOT IN ('pg_catalog','information_schema') \
            AND ($1::text IS NULL OR n.nspname = $1)",
    )
    .bind(schema)
    .fetch_all(&mut *c)
    .await?;
    let foreign_keys: Vec<ErFk> = fks
        .iter()
        .map(|r| ErFk {
            schema: text(r, "schema"),
            table: text(r, "tbl"),
            columns: r.try_get::<Vec<String>, _>("columns").unwrap_or_default(),
            ref_schema: text(r, "ref_schema"),
            ref_table: text(r, "ref_table"),
            ref_columns: r.try_get::<Vec<String>, _>("ref_columns").unwrap_or_default(),
        })
        .collect();

    Ok(ErDiagram { tables, foreign_keys })
}

const MAX_TABLES: usize = 60;
const MAX_COLS_PER_TABLE: usize = 60;

/// `pickRelevantTables` â€” rank tables by relevance to the conversation text so
/// big schemas stay under provider TPM limits.
///   1. Tokenize the hint into stems (>=3 chars, lowercased).
///   2. Score: exact table-name hit (100) > substring match (20) > column-name
///      match (2).
///   3. Expand one FK hop from any seeded table (5).
///   4. Nothing matched (generic question) â†’ first-N slice.
fn pick_relevant_tables<'a>(er: &'a ErDiagram, hint: &str, max: usize) -> Vec<&'a ErTable> {
    if er.tables.len() <= max {
        return er.tables.iter().collect();
    }
    let lowered = hint.to_lowercase();
    let tokens: HashSet<&str> = lowered
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| t.len() >= 3)
        .collect();

    let key = |t: &ErTable| format!("{}.{}", t.schema, t.name);
    let mut scores: HashMap<String, i64> = HashMap::new();
    for t in &er.tables {
        let nm = t.name.to_lowercase();
        let mut score = 0i64;
        if tokens.contains(nm.as_str()) {
            score += 100;
        }
        for tok in &tokens {
            if *tok == nm.as_str() {
                continue;
            }
            if nm.contains(tok) || tok.contains(nm.as_str()) {
                score += 20;
            }
        }
        for c in &t.columns {
            if tokens.contains(c.name.to_lowercase().as_str()) {
                score += 2;
            }
        }
        if score > 0 {
            scores.insert(key(t), score);
        }
    }

    // FK expansion: 1 hop from any seeded table.
    if !scores.is_empty() {
        let seeded: HashSet<String> = scores.keys().cloned().collect();
        for fk in &er.foreign_keys {
            let a = format!("{}.{}", fk.schema, fk.table);
            let b = format!("{}.{}", fk.ref_schema, fk.ref_table);
            if seeded.contains(&a) && !scores.contains_key(&b) {
                scores.insert(b.clone(), 5);
            }
            if seeded.contains(&b) && !scores.contains_key(&a) {
                scores.insert(a, 5);
            }
        }
    }

    let mut picked: Vec<&ErTable> = Vec::new();
    if !scores.is_empty() {
        let mut ranked: Vec<&ErTable> =
            er.tables.iter().filter(|t| scores.contains_key(&key(t))).collect();
        // JS `Array.sort` is stable, so ties keep catalog order; `sort_by` is too.
        ranked.sort_by(|a, b| scores[&key(b)].cmp(&scores[&key(a)]));
        picked.extend(ranked.into_iter().take(max));
    }
    // Fall back to first-N when nothing matched, so generic questions still get
    // a schema overview instead of an empty prompt.
    if picked.is_empty() {
        return er.tables.iter().take(max).collect();
    }
    picked
}

/// `renderSchemaContext`. The one-shot (`ai.service.ts`) and chat
/// (`ai-chat.service.ts`) renderers are identical except for two strings, which
/// `chat` selects â€” they go into the prompt verbatim, so both are reproduced.
fn render_schema_context(er: &ErDiagram, hint: &str, chat: bool) -> String {
    let tables = pick_relevant_tables(er, hint, MAX_TABLES);
    let included: HashSet<String> =
        tables.iter().map(|t| format!("{}.{}", t.schema, t.name)).collect();

    let mut lines: Vec<String> = Vec::new();
    for t in &tables {
        let mut cols: Vec<String> = t
            .columns
            .iter()
            .take(MAX_COLS_PER_TABLE)
            .map(|c| {
                let pk = if c.is_primary_key { " PK" } else { "" };
                let nn = if c.nullable { "" } else { " NOT NULL" };
                format!("  {} {}{}{}", c.name, c.data_type, pk, nn)
            })
            .collect();
        if t.columns.len() > MAX_COLS_PER_TABLE {
            let more = t.columns.len() - MAX_COLS_PER_TABLE;
            cols.push(if chat {
                format!("  ... ({more} more)")
            } else {
                format!("  ... ({more} more columns omitted)")
            });
        }
        lines.push(format!("TABLE {}.{}:\n{}", t.schema, t.name, cols.join("\n")));
    }

    let omitted = er.tables.len() - tables.len();
    if omitted > 0 {
        lines.push(if chat {
            format!("-- {omitted} other table(s) exist in this database but were omitted to stay under token limits. Ask about them by name to include them.")
        } else {
            format!("-- {omitted} other table(s) in this database were omitted to stay under token limits.")
        });
    }

    // Only FKs where both endpoints are in the included set â€” dangling
    // references would just confuse the model.
    let relevant: Vec<&ErFk> = er
        .foreign_keys
        .iter()
        .filter(|fk| {
            included.contains(&format!("{}.{}", fk.schema, fk.table))
                && included.contains(&format!("{}.{}", fk.ref_schema, fk.ref_table))
        })
        .collect();
    if !relevant.is_empty() {
        lines.push(String::new());
        lines.push("FOREIGN KEYS:".into());
        for fk in relevant.into_iter().take(300) {
            lines.push(format!(
                "  {}.{}({}) -> {}.{}({})",
                fk.schema,
                fk.table,
                fk.columns.join(","),
                fk.ref_schema,
                fk.ref_table,
                fk.ref_columns.join(",")
            ));
        }
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Target-database access
// ---------------------------------------------------------------------------

/// What we need before deciding whether Rust can serve this connection at all.
struct ConnInfo {
    owner_id: String,
    dialect: String,
    via_agent: bool,
    statement_timeout_ms: i32,
}

async fn load_conn(state: &AppState, conn_id: &str) -> ApiResult<Option<ConnInfo>> {
    let row = sqlx::query(
        r#"SELECT "ownerId", "dialect"::text AS dialect, "viaAgent", "statementTimeoutMs"
             FROM "Connection" WHERE "id" = $1"#,
    )
    .bind(conn_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|r| ConnInfo {
        owner_id: text(&r, "ownerId"),
        dialect: text(&r, "dialect"),
        via_agent: r.try_get::<bool, _>("viaAgent").unwrap_or(false),
        statement_timeout_ms: r.try_get::<i32, _>("statementTimeoutMs").unwrap_or(30_000),
    }))
}

/// Anything Rust can't introspect faithfully â€” the agent tunnel (which lives
/// only in the Node backend), a non-Postgres dialect (v2 has no MySQL/MSSQL/
/// SQLite driver), or a missing ENCRYPTION_KEY â€” is handed to v1 instead of
/// erroring. Mirrors `main.rs::agent_guard` and `docs.rs::run_saved_query`.
fn must_proxy(state: &AppState, c: &ConnInfo) -> bool {
    // NOTE: no viaAgent check here. `agent_guard` in main.rs already forwards
    // to v1 when the agent is attached to the OTHER backend; if we get this far
    // the agent is on this process and `connect_target` tunnels through it.
    !c.dialect.to_lowercase().contains("postgres") || state.crypto.is_none()
}

/// v1 introspects with `buildDriverForRole(id, Role.VIEWER)` â€” "Viewer â†’ always
/// read-only", so the assistant can never trigger a side-effecting statement
/// while reading the schema. Reproduced with a read-only session plus the
/// connection's statement timeout, exactly as the Node Postgres driver sets
/// them per checkout.
///
/// The caller has already passed `require_role(..., "VIEWER")`, which honours
/// workspace membership; `connect_target`'s own access check is narrower (owner
/// or direct ConnectionMember only), so we hand it the connection's ownerId â€”
/// it is fetching *credentials*, not authorizing the request.
async fn viewer_connection(state: &AppState, conn_id: &str, c: &ConnInfo) -> ApiResult<crate::TargetConn> {
    let mut conn = connect_target(state, conn_id, &c.owner_id).await?;
    let _ = sqlx::query(&format!("SET statement_timeout = {}", c.statement_timeout_ms))
        .execute(&mut *conn)
        .await;
    let _ = sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
        .execute(&mut *conn)
        .await;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// POST /api/connections/:id/ai/generate-sql  (AiController.generate)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GenerateSqlDto {
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    schema: Option<String>,
}

async fn generate_sql(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    req: Request,
) -> Result<Response, ApiError> {
    // Decide the proxy fallback first: v1 re-runs RBAC and re-charges the quota,
    // so we must not consume a call before handing the request over.
    let info = load_conn(&state, &id).await?;
    if info.as_ref().is_some_and(|i| must_proxy(&state, i)) {
        return Ok(crate::proxy(State(state), req).await);
    }

    // RbacGuard @RequireRole('VIEWER') â€” runs before the body pipe in Nest, and
    // is what turns an unknown id into 404 "Connection not found".
    require_role(&state, &id, &user.id, "VIEWER").await?;

    // ValidationPipe: `@IsString() @Length(1, 4_000) prompt`.
    let bytes = to_bytes(req.into_body(), 1_048_576)
        .await
        .map_err(|_| ApiError::bad("Invalid request body"))?;
    let dto: GenerateSqlDto =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("prompt must be a string"))?;
    let Some(prompt) = dto.prompt else {
        return Err(ApiError::bad("prompt must be a string"));
    };
    let plen = prompt.chars().count();
    if plen < 1 {
        return Err(ApiError::bad("prompt must be longer than or equal to 1 characters"));
    }
    if plen > 4_000 {
        return Err(ApiError::bad("prompt must be shorter than or equal to 4000 characters"));
    }

    // --- AiService.generateSql ---
    let provider = primary_provider();
    let provider = match provider {
        Some(p) if p.enabled() => p,
        _ => {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "AI is disabled on this server â€” configure at least one provider (ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, â€¦).",
            ))
        }
    };
    // Billing gate: 402 if over the daily cap / suspended / no AI plan. Called
    // BEFORE any expensive work so we don't pay a provider for a request we'll
    // refuse to deliver.
    quota_consume(&state, &user.id).await?;

    let clean = prompt.trim().to_string();
    if clean.is_empty() {
        return Err(ApiError::bad("Prompt is required"));
    }
    if clean.chars().count() > 4_000 {
        return Err(ApiError::bad("Prompt too long"));
    }

    let info = info.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let schema_ctx = {
        let mut c = viewer_connection(&state, &id, &info).await?;
        let er = introspect_for_er(&mut c, dto.schema.as_deref()).await?;
        let ctx = render_schema_context(&er, &clean, false);
        let _ = c.close().await;
        ctx
    };
    let dialect = info.dialect;

    let system = format!(
        r#"You are a careful SQL assistant for a {dialect} database.
Rules:
- Generate ONE single SQL statement that satisfies the user's request.
- Use ONLY the tables and columns listed below. Never invent identifiers.
- Prefer SELECT over DDL/DML unless the user explicitly asks for a change.
- For row-limiting SELECTs, include a LIMIT of 100 unless the user asked for more.
- Use dialect-appropriate syntax (e.g. Postgres `ILIKE`, MySQL backticks, etc.).
- Quote identifiers only if they contain uppercase/spaces/reserved words.
- When uncertain, pick the simplest correct query and note assumptions in the explanation.

Return ONLY a JSON object of shape:
{{ "sql": "<the SQL>", "explanation": "<1-2 sentences about what it does>", "tables": ["<table names referenced>"] }}
No markdown fences, no prose before/after."#
    );
    let user_msg = format!("Schema:\n{schema_ctx}\n\nUser request:\n{clean}");

    let raw = provider_generate(
        &state,
        &provider,
        &system,
        &[Turn { role: "user", content: user_msg }],
        1024,
    )
    .await?;
    let raw = raw.trim();
    let parsed = parse_response(raw);
    if parsed.0.is_empty() {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "AI returned no SQL"));
    }
    Ok(Json(json!({ "sql": parsed.0, "explanation": parsed.1, "tables": parsed.2 })).into_response())
}

/// `AiService.parseResponse` â†’ `(sql, explanation, tables)`.
fn parse_response(raw: &str) -> (String, String, Vec<String>) {
    // Strip code fences if the model ignored the instruction:
    //   raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    let mut txt: &str = raw;
    if let Some(rest) = raw.strip_prefix("```") {
        let is_json = rest.get(..4).is_some_and(|s| s.eq_ignore_ascii_case("json"));
        txt = if is_json { &rest[4..] } else { rest };
    }
    if txt.ends_with("```") {
        txt = &txt[..txt.len() - 3];
    }
    let mut txt = txt.trim();
    // If it returned prose + a JSON block, pick the JSON block:
    // /\{[\s\S]*\}/ is greedy â†’ first '{' through last '}'.
    if let (Some(a), Some(z)) = (txt.find('{'), txt.rfind('}')) {
        if z > a {
            txt = &txt[a..=z];
        }
    }

    match serde_json::from_str::<Value>(txt) {
        Ok(v) => {
            let sql = js_coalesce_string(v.get("sql")).trim().to_string();
            let explanation = js_coalesce_string(v.get("explanation"));
            let tables = match v.get("tables").and_then(|t| t.as_array()) {
                Some(a) => a.iter().map(js_to_string).collect(),
                None => Vec::new(),
            };
            (sql, explanation, tables)
        }
        // Last resort: return the whole thing as SQL, no explanation.
        Err(_) => (raw.trim().to_string(), String::new(), Vec::new()),
    }
}

/// JS `String(value)` for the shapes a model can realistically return.
fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        // Array.prototype.toString joins with ',' and renders null/undefined as ''.
        Value::Array(a) => a
            .iter()
            .map(|x| if x.is_null() { String::new() } else { js_to_string(x) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JS `String(value ?? '')` â€” null/undefined collapse to the empty string.
fn js_coalesce_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(x) => js_to_string(x),
    }
}

// ---------------------------------------------------------------------------
// AiChatController â€” /api/ai/chats
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    #[serde(default)]
    connection_id: Option<String>,
}

/// `GET /api/ai/chats?connectionId=â€¦` â€” `AiChatService.list`.
async fn chat_list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let connection_id = q.connection_id.unwrap_or_default();
    require_role(&state, &connection_id, &user.id, "VIEWER").await?;
    let rows = sqlx::query(
        r#"SELECT "id","title","updatedAt","createdAt" FROM "AiChat"
            WHERE "connectionId" = $1 AND "userId" = $2
            ORDER BY "updatedAt" DESC
            LIMIT 50"#,
    )
    .bind(&connection_id)
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": text(r, "id"),
                "title": text(r, "title"),
                "updatedAt": iso(r, "updatedAt"),
                "createdAt": iso(r, "createdAt"),
            })
        })
        .collect();
    Ok(Json(json!(out)))
}

fn message_json(r: &PgRow) -> Value {
    json!({
        "id": text(r, "id"),
        "chatId": text(r, "chatId"),
        "role": text(r, "role"),
        "content": text(r, "content"),
        "sqlBlock": opt_text(r, "sqlBlock"),
        "createdAt": iso(r, "createdAt"),
    })
}

/// `GET /api/ai/chats/:id` â€” `AiChatService.get` (chat + messages, oldest first).
async fn chat_get(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let chat = sqlx::query(
        r#"SELECT "id","connectionId","userId","title","createdAt","updatedAt"
             FROM "AiChat" WHERE "id" = $1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Chat not found"))?;
    // Ownership: a chat is private to the user who created it.
    if text(&chat, "userId") != user.id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden"));
    }

    let msgs = sqlx::query(
        r#"SELECT "id","chatId","role","content","sqlBlock","createdAt"
             FROM "AiMessage" WHERE "chatId" = $1 ORDER BY "createdAt" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({
        "id": text(&chat, "id"),
        "connectionId": text(&chat, "connectionId"),
        "userId": text(&chat, "userId"),
        "title": text(&chat, "title"),
        "createdAt": iso(&chat, "createdAt"),
        "updatedAt": iso(&chat, "updatedAt"),
        "messages": msgs.iter().map(message_json).collect::<Vec<_>>(),
    })))
}

/// `DELETE /api/ai/chats/:id` â€” `AiChatService.remove`. Messages go with it via
/// the `AiMessage_chatId_fkey ON DELETE CASCADE`.
async fn chat_remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "userId" FROM "AiChat" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?;
    // v1 throws a bare NotFoundException here (no message).
    let Some(owner) = owner else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Not Found"));
    };
    if owner != user.id {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden"));
    }
    sqlx::query(r#"DELETE FROM "AiChat" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageDto {
    #[serde(default)]
    chat_id: Option<String>,
    #[serde(default)]
    connection_id: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

/// `POST /api/ai/chats/messages` â€” `AiChatService.sendMessage`. Appends the user
/// turn, calls the model with the full history + schema context, persists the
/// assistant turn, and returns it. Auto-creates the chat on the first call.
async fn send_message(
    State(state): State<AppState>,
    user: AuthUser,
    req: Request,
) -> Result<Response, ApiError> {
    // Body is read up front because the connection id (which decides whether v2
    // can serve this at all) lives inside it; the bytes are put back verbatim if
    // we end up proxying.
    let (parts, body) = req.into_parts();
    let bytes = to_bytes(body, 1_048_576)
        .await
        .map_err(|_| ApiError::bad("Invalid request body"))?;
    let dto: SendMessageDto =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("content must be a string"))?;

    let Some(connection_id) = dto.connection_id.clone() else {
        return Err(ApiError::bad("connectionId must be a string"));
    };
    let Some(content_raw) = dto.content.clone() else {
        return Err(ApiError::bad("content must be a string"));
    };
    let clen = content_raw.chars().count();
    if clen < 1 {
        return Err(ApiError::bad("content must be longer than or equal to 1 characters"));
    }
    if clen > 4000 {
        return Err(ApiError::bad("content must be shorter than or equal to 4000 characters"));
    }

    // Same fallback rule as generate-sql, and for the same reason (v1 re-runs
    // RBAC + quota, so hand over before consuming anything).
    let info = load_conn(&state, &connection_id).await?;
    if info.as_ref().is_some_and(|i| must_proxy(&state, i)) {
        let req = Request::from_parts(parts, Body::from(bytes));
        return Ok(crate::proxy(State(state), req).await);
    }

    let provider = primary_provider().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "AI is disabled on this server â€” set an API key for one of: Anthropic, Gemini, OpenAI, Groq, OpenRouter, or Ollama.",
        )
    })?;

    let content = content_raw.trim().to_string();
    if content.is_empty() {
        return Err(ApiError::bad("Message required"));
    }
    if content.chars().count() > 4000 {
        return Err(ApiError::bad("Message too long"));
    }
    require_role(&state, &connection_id, &user.id, "VIEWER").await?;
    // Billing gate: runs after validation so malformed requests don't consume a
    // call, but before we persist anything or call the model.
    quota_consume(&state, &user.id).await?;

    // Get or create the chat. First message becomes the title.
    let chat_id = match dto.chat_id.clone() {
        None => {
            let id = gen_id();
            sqlx::query(
                r#"INSERT INTO "AiChat" ("id","connectionId","userId","title","createdAt","updatedAt")
                   VALUES ($1, $2, $3, $4, now(), now())"#,
            )
            .bind(&id)
            .bind(&connection_id)
            .bind(&user.id)
            .bind(take_chars(&content, 80))
            .execute(&state.pool)
            .await?;
            id
        }
        Some(id) => {
            let row = sqlx::query(r#"SELECT "userId","connectionId" FROM "AiChat" WHERE "id" = $1"#)
                .bind(&id)
                .fetch_optional(&state.pool)
                .await?
                .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
            if text(&row, "userId") != user.id {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden"));
            }
            if text(&row, "connectionId") != connection_id {
                return Err(ApiError::bad("Connection mismatch"));
            }
            id
        }
    };

    // Persist the user message.
    sqlx::query(
        r#"INSERT INTO "AiMessage" ("id","chatId","role","content","sqlBlock","createdAt")
           VALUES ($1, $2, 'user', $3, NULL, now())"#,
    )
    .bind(gen_id())
    .bind(&chat_id)
    .bind(&content)
    .execute(&state.pool)
    .await?;

    // Assemble history â€” v1 caps it at 60 rows to stay under context limits.
    let history = sqlx::query(
        r#"SELECT "role","content" FROM "AiMessage" WHERE "chatId" = $1
            ORDER BY "createdAt" ASC LIMIT 60"#,
    )
    .bind(&chat_id)
    .fetch_all(&state.pool)
    .await?;
    let messages: Vec<Turn> = history
        .iter()
        .map(|r| Turn {
            role: if text(r, "role") == "assistant" { "assistant" } else { "user" },
            content: text(r, "content"),
        })
        .collect();

    // Schema context â€” one-time per call, not persisted. The conversation text
    // is the relevance hint so only schema-relevant tables are sent.
    let info = info.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))?;
    let schema_ctx = {
        let mut c = viewer_connection(&state, &connection_id, &info).await?;
        let er = introspect_for_er(&mut c, None).await?;
        let hint = messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join(" ");
        let ctx = render_schema_context(&er, &hint, true);
        let _ = c.close().await;
        ctx
    };
    let dialect = info.dialect;

    let system = format!(
        r#"You are a careful SQL assistant for a {dialect} database.

Rules â€” follow these strictly:
- Use ONLY the exact table and column names listed under "Schema" below. Do NOT invent, pluralize, singularize, or guess identifiers. If a table the user asks about is not in the schema, say so explicitly and list the closest matches by name from the schema â€” do not fabricate a query.
- When appropriate, include exactly one executable SQL statement in a ```sql fenced block.
- Prefer SELECT. Only propose DDL/DML when the user explicitly asks for one.
- For row-limiting SELECTs, include a LIMIT of 100 unless the user asked otherwise.
- Use the FOREIGN KEYS section to choose JOIN conditions â€” prefer FK-backed joins over guessing column names.
- You may answer follow-up questions without generating SQL when the user is asking for explanation or clarification.

Schema:
{schema_ctx}"#
    );

    let resp = provider_generate(&state, &provider, &system, &messages, 2048).await?;
    let assistant_text = if resp.is_empty() { "(no response)".to_string() } else { resp };
    let sql_block = extract_last_sql_block(&assistant_text);

    let saved = sqlx::query(
        r#"INSERT INTO "AiMessage" ("id","chatId","role","content","sqlBlock","createdAt")
           VALUES ($1, $2, 'assistant', $3, $4, now())
           RETURNING "id","chatId","role","content","sqlBlock","createdAt""#,
    )
    .bind(gen_id())
    .bind(&chat_id)
    .bind(&assistant_text)
    .bind(sql_block.as_deref())
    .fetch_one(&state.pool)
    .await?;

    // Bump the chat's updatedAt so the list sorts correctly.
    sqlx::query(r#"UPDATE "AiChat" SET "updatedAt" = now() WHERE "id" = $1"#)
        .bind(&chat_id)
        .execute(&state.pool)
        .await?;

    Ok(Json(json!({ "chatId": chat_id, "message": message_json(&saved) })).into_response())
}

/// `extractLastSqlBlock` â€” /```sql\s*\n([\s\S]*?)```/gi, keeping the LAST match.
/// The capture is trimmed, so starting the content at the first newline of the
/// whitespace run is equivalent to the regex's backtracked last-newline split.
fn extract_last_sql_block(t: &str) -> Option<String> {
    let b = t.as_bytes();
    let mut last: Option<String> = None;
    let mut i = 0usize;
    while i + 6 <= b.len() {
        let fence = b[i] == b'`' && b[i + 1] == b'`' && b[i + 2] == b'`';
        if !fence || !b[i + 3..i + 6].eq_ignore_ascii_case(b"sql") {
            i += 1;
            continue;
        }
        // `\s*\n` â€” the whitespace run must contain a newline for the regex to
        // match at all.
        let mut j = i + 6;
        let mut start: Option<usize> = None;
        while j < b.len() && b[j].is_ascii_whitespace() {
            if b[j] == b'\n' {
                start = Some(j + 1);
            }
            j += 1;
        }
        let Some(start) = start else {
            i += 6;
            continue;
        };
        // Lazy `[\s\S]*?` up to the closing fence; no fence â†’ no match at all.
        match t[start..].find("```") {
            Some(rel) => {
                let end = start + rel;
                last = Some(t[start..end].trim().to_string());
                i = end + 3;
            }
            None => break,
        }
    }
    last
}
