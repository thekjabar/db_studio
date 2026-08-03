//! Connection **create** + **update** — Rust port of v1's
//! `backend/src/connections/connections.service.ts` (`create`, `update`,
//! `assertOwnedAgent`, `assertDialableTarget`, `isInstanceAdmin`), its
//! controller/DTOs, `common/quota.service.ts` and `common/ssrf-guard.service.ts`.
//!
//! These were the last two connection routes still hard-proxied to Node. They
//! stayed behind because they are the only user-facing way to tell this server
//! *what to dial*, so three controls have to come across intact:
//!
//!  1. **SSRF guard** — the DB host (and the SSH bastion, which we always dial
//!     ourselves) must resolve to a public address. Validated on the RESOLVED
//!     IPs, never the name: `db.evil.com` can simply carry an A record of
//!     127.0.0.1. Re-run on update, because two things can repoint a live
//!     connection at our internals — new credentials, or switching agent
//!     routing OFF, which makes US dial a host previously reached from the
//!     user's own network.
//!  2. **`assertOwnedAgent`** — a `viaAgent` connection may only reference an
//!     `Agent` row owned by the caller. Agent-routed connections legitimately
//!     skip the dialability check (the agent dials from inside the user's own
//!     network, where private addresses are the entire point), so letting a
//!     user point at *someone else's* agent would be a way around the guard.
//!  3. **Plan quota** — per-workspace connection cap from the effective plan
//!     tier, floored by the env host ceiling.
//!
//! Credentials are encrypted with `crypto::Crypto::encrypt` under purpose
//! `conn:{id}` — v1's envelope, so v1 and v2 read each other's rows.
//!
//! One deliberate simplification: v1 inserts with purpose `conn:new` and then
//! immediately re-encrypts under `conn:{id}` because Prisma mints the id. We
//! mint the id up front, so a single INSERT reaches the identical end state.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::{conn_role, crypto, gen_id, req_meta, ApiError, ApiResult, AppState, AuthUser, ReqMeta};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/connections", post(conn_create))
        .route("/api/connections/:id", patch(conn_update))
}

// ---------------------------------------------------------------------------
// SSRF guard — v1 `common/ssrf-guard.service.ts`
// ---------------------------------------------------------------------------
//
// KEEP IN SYNC with the copy in `collab.rs` (same v1 source file, ported there
// for webhook URLs). Both are deliberately verbatim; if either is ever hoisted
// into a shared module, hoist the other with it.

fn allow_private_hosts() -> bool {
    std::env::var("ALLOW_PRIVATE_HOSTS").map(|v| v == "true").unwrap_or(false)
}

fn is_blocked_v4(a: Ipv4Addr) -> bool {
    let [x, y, ..] = a.octets();
    x == 0                              // 0.0.0.0/8 "this network"
        || x == 10                      // private
        || x == 127                     // loopback
        || (x == 169 && y == 254)       // link-local — cloud metadata (169.254.169.254)
        || (x == 172 && (16..=31).contains(&y)) // private — Docker bridges live here
        || (x == 192 && y == 168)       // private
        || (x == 100 && (64..=127).contains(&y)) // CGNAT 100.64/10
        || (x == 192 && y == 0)         // 192.0.0/24 + 192.0.2/24 test nets
        || (x == 198 && (y == 18 || y == 19)) // benchmarking
        || x >= 224 // multicast + reserved + broadcast
}

fn is_blocked_v6(a: Ipv6Addr) -> bool {
    if a.is_unspecified() || a.is_loopback() {
        return true;
    }
    // IPv4-mapped (::ffff:127.0.0.1) — re-check the embedded v4 address.
    if let Some(v4) = a.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    let s = a.to_string();
    s.starts_with("fe80")                              // link-local
        || s.starts_with("fc") || s.starts_with("fd")  // unique-local fc00::/7
        || s.starts_with("ff") // multicast
}

fn is_blocked(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(a) => is_blocked_v4(a),
        IpAddr::V6(a) => is_blocked_v6(a),
    }
}

/// v1 `SsrfGuardService.assertPublicHost`.
async fn assert_public_host(host: &str, label: &str) -> ApiResult<()> {
    if allow_private_hosts() {
        return Ok(());
    }
    let cleaned = host.trim().trim_start_matches('[').trim_end_matches(']');
    if cleaned.is_empty() {
        return Err(ApiError::bad(format!("{label} is required")));
    }
    let addrs: Vec<IpAddr> = match cleaned.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => {
            // Unresolvable names are refused rather than passed through: a name
            // that resolves only inside our network (e.g. a sibling compose
            // service) would otherwise slip past when lookup fails here but
            // succeeds at dial time.
            let resolved = tokio::net::lookup_host((cleaned, 80u16))
                .await
                .map(|it| it.map(|s| s.ip()).collect::<Vec<_>>())
                .unwrap_or_default();
            if resolved.is_empty() {
                return Err(ApiError::bad(format!(
                    "{label} \"{cleaned}\" could not be resolved to a public address"
                )));
            }
            resolved
        }
    };
    for addr in addrs {
        if is_blocked(addr) {
            return Err(ApiError::bad(format!(
                "{label} \"{cleaned}\" resolves to a private or internal address ({addr}), which isn't allowed. \
                 To reach a database on your own network, route the connection through a local agent instead."
            )));
        }
    }
    Ok(())
}

/// v1 `ConnectionsService.isInstanceAdmin`. Instance admins are the operators
/// of this deployment — they already have server access, and on a self-hosted
/// box pointing at an internal database is the normal case. Everyone else
/// (i.e. anyone who can sign up) is held to public destinations only.
///
/// Read with `?`, never `.ok().flatten()`: a swallowed error here would read as
/// "not an admin", which is the safe direction, but a swallowed *decode* error
/// on a security column is exactly the bug class we don't want to normalise.
async fn is_instance_admin(state: &AppState, user_id: &str) -> ApiResult<bool> {
    let is_admin: Option<bool> = sqlx::query_scalar(r#"SELECT "isAdmin" FROM "User" WHERE "id" = $1"#)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(is_admin.unwrap_or(false))
}

/// v1 `ConnectionsService.assertDialableTarget`.
///
/// SECURITY: refuse to let the SERVER dial an internal address. Applied to the
/// database host and, when configured, the SSH bastion. Skipped for
/// agent-routed connections.
async fn assert_dialable_target(
    state: &AppState,
    creds: Option<&Map<String, Value>>,
    via_agent: bool,
    user_id: &str,
) -> ApiResult<()> {
    let Some(creds) = creds else { return Ok(()) };
    if is_instance_admin(state, user_id).await? {
        return Ok(());
    }
    // An SSH bastion is always dialed by us, even when the DB host itself is
    // only reachable from the far side of the tunnel.
    let ssh = creds.get("ssh").filter(|v| v.is_object());
    if let Some(h) = ssh.and_then(|s| s.get("host")).and_then(|v| v.as_str()) {
        // JS truthiness: an empty string is not a host.
        if !h.is_empty() {
            assert_public_host(h, "SSH host").await?;
        }
    }
    // With an agent (or an SSH tunnel) the DB host is resolved on the far side,
    // not by us, so it may legitimately be private.
    if via_agent || ssh.is_some() {
        return Ok(());
    }
    if let Some(h) = creds.get("host").and_then(|v| v.as_str()) {
        if !h.is_empty() {
            assert_public_host(h, "Database host").await?;
        }
    }
    Ok(())
}

/// v1 `ConnectionsService.assertOwnedAgent` — the agent must exist AND be owned
/// by the requesting user. Both failures share one message so the endpoint
/// can't be used to probe which agent ids exist.
async fn assert_owned_agent(
    state: &AppState,
    agent_id: Option<&str>,
    user_id: &str,
) -> ApiResult<String> {
    let Some(agent_id) = agent_id.filter(|s| !s.is_empty()) else {
        return Err(ApiError::bad("Select a local agent to route this connection through."));
    };
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Agent" WHERE "id" = $1"#)
        .bind(agent_id)
        .fetch_optional(&state.pool)
        .await?;
    match owner {
        Some(o) if o == user_id => Ok(agent_id.to_string()),
        _ => Err(ApiError::bad("Unknown or inaccessible local agent.")),
    }
}

// ---------------------------------------------------------------------------
// RBAC — v1 `rbac.service.ts` (`RbacGuard` + `@RequireRole('OWNER')` on PATCH)
// ---------------------------------------------------------------------------

/// v1 `RANK`: VIEWER=1, EDITOR=2, OWNER=3. Unknown roles sort below VIEWER so a
/// future enum value can never silently satisfy a check.
fn rank(role: &str) -> i32 {
    match role {
        "VIEWER" => 1,
        "EDITOR" => 2,
        "OWNER" => 3,
        _ => 0,
    }
}

/// v1 `RbacService.require`. Guards run before pipes in Nest, so this fires
/// ahead of any body validation.
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    match conn_role(&state.pool, conn_id, user_id).await? {
        None => {
            // v1 re-checks existence so a bad id reads as 404, not 403.
            let exists: Option<String> =
                sqlx::query_scalar(r#"SELECT "id" FROM "Connection" WHERE "id" = $1"#)
                    .bind(conn_id)
                    .fetch_optional(&state.pool)
                    .await?;
            if exists.is_none() {
                Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found"))
            } else {
                Err(ApiError::new(StatusCode::FORBIDDEN, "No access to this connection"))
            }
        }
        Some(role) if rank(&role) < rank(min) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {min} role (have {role})"),
        )),
        Some(role) => Ok(role),
    }
}

// ---------------------------------------------------------------------------
// Quota — v1 `common/quota.service.ts` + `billing/plan.service.ts`
// ---------------------------------------------------------------------------

struct PlanLimits {
    name: String,
    max_connections: i32,
}

/// v1 `DEFAULT_PLANS` — used when the operator-editable PlanConfig row is absent.
fn default_plan(tier: &str) -> PlanLimits {
    let (name, max) = match tier {
        "PRO" => ("Pro", 25),
        "TEAM" => ("Team", 100),
        _ => ("Trial", 1),
    };
    PlanLimits { name: name.into(), max_connections: max }
}

/// v1 `LOCKED_LIMITS` — no active entitlement means nothing is free.
fn locked_plan() -> PlanLimits {
    PlanLimits { name: "No plan".into(), max_connections: 0 }
}

async fn plan_config(state: &AppState, tier: &str) -> ApiResult<PlanLimits> {
    let row = sqlx::query(r#"SELECT "name","maxConnections" FROM "PlanConfig" WHERE "tier" = $1::"PlanTier""#)
        .bind(tier)
        .fetch_optional(&state.pool)
        .await?;
    Ok(match row {
        Some(r) => PlanLimits {
            name: r.try_get::<String, _>("name").unwrap_or_default(),
            max_connections: r.try_get::<i32, _>("maxConnections").unwrap_or(0),
        },
        None => default_plan(tier),
    })
}

/// v1 `QuotaService.assertCanCreateConnection`. The plan cap comes from the
/// workspace's effective tier; the env cap is an absolute host ceiling an
/// oversized plan row can never exceed.
async fn assert_can_create_connection(state: &AppState, workspace_id: Option<&str>) -> ApiResult<()> {
    // Personal-workspace-less users can still create.
    let Some(ws) = workspace_id else { return Ok(()) };

    let count: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "Connection" WHERE "workspaceId" = $1"#)
        .bind(ws)
        .fetch_one(&state.pool)
        .await?;

    let sub = sqlx::query(
        r#"SELECT "plan"::text AS "plan","status"::text AS "status","periodEnd"
           FROM "Subscription" WHERE "workspaceId" = $1"#,
    )
    .bind(ws)
    .fetch_optional(&state.pool)
    .await?;
    // v1 `isEntitled`: not SUSPENDED and the period is still open. Both a lapsed
    // trial and a lapsed paid plan drop to LOCKED.
    let entitled = sub.as_ref().and_then(|r| {
        let status = r.try_get::<String, _>("status").ok()?;
        let period_end = r.try_get::<chrono::NaiveDateTime, _>("periodEnd").ok()?;
        let plan = r.try_get::<String, _>("plan").ok()?;
        (status != "SUSPENDED" && period_end > chrono::Utc::now().naive_utc()).then_some(plan)
    });
    let cfg = match entitled {
        Some(plan) => plan_config(state, &plan).await?,
        None => locked_plan(),
    };

    let env_cap = std::env::var("MAX_CONNECTIONS_PER_WORKSPACE")
        .ok()
        .and_then(|v| v.parse::<i32>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(50);
    let cap = cfg.max_connections.min(env_cap);
    if count >= cap as i64 {
        // A zero cap means "no plan / no subscription" — steer to Billing to
        // subscribe rather than "upgrade".
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            if cap == 0 {
                "You need an active subscription to add connections. Open Billing to choose a plan.".to_string()
            } else {
                format!(
                    "Your {} plan allows {} connection(s). Upgrade your plan to add more.",
                    cfg.name, cfg.max_connections
                )
            },
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// DTO validation — v1 `connections.dto.ts` under the global `ValidationPipe`
// (`whitelist: true, forbidNonWhitelisted: true, enableImplicitConversion: true`)
// ---------------------------------------------------------------------------

const CREATE_KEYS: [&str; 8] = [
    "name", "dialect", "credentials", "readOnly", "statementTimeoutMs", "workspaceId", "viaAgent", "agentId",
];
const UPDATE_KEYS: [&str; 10] = [
    "name", "credentials", "readOnly", "statementTimeoutMs", "workspaceId", "slowQueryAlertMs",
    "slowQueryAlertEmail", "requireReview", "viaAgent", "agentId",
];
/// v1 `CredentialsDto`. Anything outside this list is rejected, so no
/// attacker-chosen key ever reaches the driver via the ciphertext.
const CRED_KEYS: [&str; 8] = ["host", "port", "user", "password", "database", "filename", "sslMode", "ssh"];
/// v1 `SshTunnelDto`.
const SSH_KEYS: [&str; 7] = ["host", "port", "user", "authType", "password", "privateKey", "passphrase"];
const DIALECTS: [&str; 4] = ["POSTGRES", "MYSQL", "SQLITE", "MSSQL"];

/// v1's `ValidationPipe` 400: `{ statusCode, code: 'Bad Request', message: [...] }`.
fn validation_error(msgs: Vec<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: msgs.join(", "),
        body: Some(json!({ "statusCode": 400, "code": "Bad Request", "message": msgs })),
    }
}

fn body_object(bytes: &Bytes) -> ApiResult<Map<String, Value>> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(ApiError::bad("Request body must be a JSON object")),
        Err(e) => Err(ApiError::bad(format!("Invalid request body: {e}"))),
    }
}

/// `forbidNonWhitelisted: true`.
fn deny_unknown(m: &Map<String, Value>, allowed: &[&str], errs: &mut Vec<String>) {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            errs.push(format!("property {k} should not exist"));
        }
    }
}

/// `@IsString() @Length(min, max)`. Absent/null yields `None` (the caller
/// decides whether that is allowed) — matching `@IsOptional`, which skips
/// validation for both.
fn v_str(m: &Map<String, Value>, key: &str, min: usize, max: usize, errs: &mut Vec<String>) -> Option<String> {
    match m.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let n = s.chars().count();
            if n < min {
                errs.push(format!("{key} must be longer than or equal to {min} characters"));
                return None;
            }
            if n > max {
                errs.push(format!("{key} must be shorter than or equal to {max} characters"));
                return None;
            }
            Some(s.clone())
        }
        Some(_) => {
            errs.push(format!("{key} must be a string"));
            None
        }
    }
}

/// `@IsInt() @Min(min) @Max(max)`. Numeric strings are accepted because v1 runs
/// with `enableImplicitConversion: true`.
fn v_int(m: &Map<String, Value>, key: &str, min: i64, max: i64, errs: &mut Vec<String>) -> Option<i64> {
    let raw = match m.get(key) {
        None | Some(Value::Null) => return None,
        Some(v) => v,
    };
    let n = match raw {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    };
    match n {
        None => {
            errs.push(format!("{key} must be an integer number"));
            None
        }
        Some(v) if v < min => {
            errs.push(format!("{key} must not be less than {min}"));
            None
        }
        Some(v) if v > max => {
            errs.push(format!("{key} must not be greater than {max}"));
            None
        }
        Some(v) => Some(v),
    }
}

/// `@IsBoolean()`.
fn v_bool(m: &Map<String, Value>, key: &str, errs: &mut Vec<String>) -> Option<bool> {
    match m.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            errs.push(format!("{key} must be a boolean value"));
            None
        }
    }
}

/// Copy `key` from `src` into `dst` when it is present, validating as a string.
/// A present-but-null value is copied through as null: class-validator's
/// `@IsOptional` skips it, and class-transformer keeps the key because it was
/// in the source object.
fn take_str(
    src: &Map<String, Value>,
    dst: &mut Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
    errs: &mut Vec<String>,
) {
    match src.get(key) {
        None => {}
        Some(Value::Null) => {
            dst.insert(key.to_string(), Value::Null);
        }
        Some(_) => {
            if let Some(s) = v_str(src, key, min, max, errs) {
                dst.insert(key.to_string(), Value::String(s));
            }
        }
    }
}

fn take_int(
    src: &Map<String, Value>,
    dst: &mut Map<String, Value>,
    key: &str,
    min: i64,
    max: i64,
    errs: &mut Vec<String>,
) {
    match src.get(key) {
        None => {}
        Some(Value::Null) => {
            dst.insert(key.to_string(), Value::Null);
        }
        Some(_) => {
            if let Some(n) = v_int(src, key, min, max, errs) {
                dst.insert(key.to_string(), json!(n));
            }
        }
    }
}

/// v1 `CredentialsDto` (+ nested `SshTunnelDto`).
///
/// Returns only the keys the client actually sent. That is not an optimisation:
/// `plainToInstance` leaves unset optional fields off the instance, which is
/// precisely what makes v1's update-time `{ ...current, ...dto.credentials }`
/// an additive merge rather than a wipe.
fn validate_credentials(raw: &Value, errs: &mut Vec<String>) -> Option<Map<String, Value>> {
    let Value::Object(m) = raw else {
        errs.push("credentials must be an object".to_string());
        return None;
    };
    deny_unknown(m, &CRED_KEYS, errs);

    let mut out = Map::new();
    take_str(m, &mut out, "host", 1, 253, errs);
    take_int(m, &mut out, "port", 1, 65_535, errs);
    take_str(m, &mut out, "user", 1, 128, errs);
    take_str(m, &mut out, "password", 0, 256, errs);
    take_str(m, &mut out, "database", 1, 128, errs);
    take_str(m, &mut out, "filename", 1, 1024, errs);
    // v1 types sslMode as a union but only validates `@IsString()`.
    take_str(m, &mut out, "sslMode", 0, usize::MAX, errs);

    // `ssh: null` means "remove the tunnel" on an update; v1 skips nested
    // validation in that case (`@ValidateIf(v => v !== null && v !== undefined)`).
    match m.get("ssh") {
        None => {}
        Some(Value::Null) => {
            out.insert("ssh".to_string(), Value::Null);
        }
        Some(Value::Object(s)) => {
            deny_unknown(s, &SSH_KEYS, errs);
            let mut ssh = Map::new();
            // host/port/user/authType are required on SshTunnelDto.
            match v_str(s, "host", 1, 253, errs) {
                Some(v) => {
                    ssh.insert("host".into(), Value::String(v));
                }
                None if !s.contains_key("host") || s["host"].is_null() => {
                    errs.push("host must be a string".to_string())
                }
                None => {}
            }
            match v_int(s, "port", 1, 65_535, errs) {
                Some(v) => {
                    ssh.insert("port".into(), json!(v));
                }
                None if !s.contains_key("port") || s["port"].is_null() => {
                    errs.push("port must be an integer number".to_string())
                }
                None => {}
            }
            match v_str(s, "user", 1, 128, errs) {
                Some(v) => {
                    ssh.insert("user".into(), Value::String(v));
                }
                None if !s.contains_key("user") || s["user"].is_null() => {
                    errs.push("user must be a string".to_string())
                }
                None => {}
            }
            match s.get("authType").and_then(|v| v.as_str()) {
                Some(a) if a == "password" || a == "privateKey" => {
                    ssh.insert("authType".into(), Value::String(a.to_string()));
                }
                _ => errs.push("authType must be one of the following values: password, privateKey".to_string()),
            }
            take_str(s, &mut ssh, "password", 0, 1024, errs);
            take_str(s, &mut ssh, "privateKey", 0, 32_000, errs);
            take_str(s, &mut ssh, "passphrase", 0, 1024, errs);
            out.insert("ssh".to_string(), Value::Object(ssh));
        }
        Some(_) => errs.push("ssh must be an object".to_string()),
    }

    Some(out)
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Best-effort audit row (v1 `AuditService.log` — never fails the request).
async fn audit(state: &AppState, user_id: &str, connection_id: &str, action: &str, meta: &ReqMeta) {
    let _ = sqlx::query(
        r#"INSERT INTO "AuditLog" ("id","userId","connectionId","action","ip","userAgent","createdAt")
           VALUES ($1,$2,$3,$4::"AuditAction",$5,$6,now())"#,
    )
    .bind(gen_id())
    .bind(user_id)
    .bind(connection_id)
    .bind(action)
    .bind(meta.ip.as_deref())
    .bind(meta.user_agent.as_deref())
    .execute(&state.pool)
    .await;
}

/// v1 `sanitize()` returns `ownerId` but nothing decrypted; v2's `GET
/// /connections[/:id]` returns the decrypted host/port/user/database instead.
/// Emitting the union keeps both callers happy — no field either shape carries
/// today disappears. The password is never included.
async fn conn_response(state: &AppState, id: &str, crypto: &crypto::Crypto) -> ApiResult<Json<Value>> {
    let row = sqlx::query(&format!(
        r#"SELECT {}, "ownerId" FROM "Connection" WHERE "id" = $1 LIMIT 1"#,
        crate::CONN_COLS
    ))
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    let mut dto = crate::conn_dto(&row, crypto);
    dto["ownerId"] = json!(row.try_get::<String, _>("ownerId").unwrap_or_default());
    Ok(Json(dto))
}

enum B {
    Text(String),
    OptText(Option<String>),
    Bool(bool),
    Int(i32),
    OptInt(Option<i32>),
}

fn bind_all<'q>(
    sql: &'q str,
    binds: Vec<B>,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = match b {
            B::Text(v) => q.bind(v),
            B::OptText(v) => q.bind(v),
            B::Bool(v) => q.bind(v),
            B::Int(v) => q.bind(v),
            B::OptInt(v) => q.bind(v),
        };
    }
    q
}

// ---------------------------------------------------------------------------
// POST /api/connections — v1 `ConnectionsService.create`
// ---------------------------------------------------------------------------

async fn conn_create(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let m = body_object(&body)?;
    let mut errs: Vec<String> = Vec::new();
    deny_unknown(&m, &CREATE_KEYS, &mut errs);

    let name = v_str(&m, "name", 1, 80, &mut errs);
    if name.is_none() && (!m.contains_key("name") || m["name"].is_null()) {
        errs.push("name must be a string".to_string());
    }
    let dialect = match m.get("dialect").and_then(|v| v.as_str()) {
        Some(d) if DIALECTS.contains(&d) => Some(d.to_string()),
        _ => {
            errs.push(format!(
                "dialect must be one of the following values: {}",
                DIALECTS.join(", ")
            ));
            None
        }
    };
    let credentials = match m.get("credentials") {
        Some(c) => validate_credentials(c, &mut errs),
        None => {
            errs.push("credentials must be an object".to_string());
            None
        }
    };
    let read_only = v_bool(&m, "readOnly", &mut errs);
    let statement_timeout_ms = v_int(&m, "statementTimeoutMs", 1_000, 600_000, &mut errs);
    let workspace_in = v_str(&m, "workspaceId", 0, usize::MAX, &mut errs);
    let via_agent_in = v_bool(&m, "viaAgent", &mut errs);
    let agent_in = v_str(&m, "agentId", 0, usize::MAX, &mut errs);

    if !errs.is_empty() {
        return Err(validation_error(errs));
    }
    let (name, dialect, credentials) = (name.unwrap(), dialect.unwrap(), credentials.unwrap());

    // Pick a workspace: use the provided one if the user has rights, else
    // default to the user's personal workspace.
    //
    // v1 throws a bare `new Error(...)` here, which its global filter turns into
    // a 500 "Internal server error" — the operator message never reaches the
    // caller. Ported as the 400 it was clearly meant to be, message verbatim.
    let workspace_id: Option<String> = match workspace_in {
        Some(w) => {
            let member: Option<bool> = sqlx::query_scalar(
                r#"SELECT true FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2 LIMIT 1"#,
            )
            .bind(&w)
            .bind(&user.id)
            .fetch_optional(&state.pool)
            .await?;
            if member.is_none() {
                return Err(ApiError::bad("You are not a member of that workspace"));
            }
            Some(w)
        }
        None => sqlx::query_scalar::<_, String>(
            r#"SELECT "id" FROM "Workspace" WHERE "ownerId" = $1 AND "isPersonal" = true LIMIT 1"#,
        )
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await?,
    };

    // Enforce the per-workspace connection cap before creating.
    assert_can_create_connection(&state, workspace_id.as_deref()).await?;

    // If routing via a local agent, verify the agent exists and belongs to the user.
    let via_agent = via_agent_in.unwrap_or(false);
    let agent_id: Option<String> = if via_agent {
        Some(assert_owned_agent(&state, agent_in.as_deref(), &user.id).await?)
    } else {
        None
    };

    // SECURITY: when WE dial the database, the host must be a public address —
    // otherwise any user could point a connection at our own internal services
    // (redis, sibling containers, cloud metadata) and query them. Agent-routed
    // connections are exempt: those are dialed from the user's own machine.
    assert_dialable_target(&state, Some(&credentials), via_agent, &user.id).await?;

    let id = gen_id();
    let ct = crypto
        .encrypt(&Value::Object(credentials).to_string(), &crypto::Crypto::conn_purpose(&id))
        .map_err(|e| ApiError::internal(e.to_string()))?;

    sqlx::query(
        r#"INSERT INTO "Connection"
             ("id","name","dialect","credentialsCt","readOnly","statementTimeoutMs","ownerId",
              "workspaceId","viaAgent","agentId","requireReview","createdAt","updatedAt")
           VALUES ($1,$2,$3::"Dialect",$4,$5,$6,$7,$8,$9,$10,false,now(),now())"#,
    )
    .bind(&id)
    .bind(&name)
    .bind(&dialect)
    .bind(&ct)
    .bind(read_only.unwrap_or(false))
    .bind(statement_timeout_ms.unwrap_or(30_000) as i32)
    .bind(&user.id)
    .bind(&workspace_id)
    .bind(via_agent)
    .bind(&agent_id)
    .execute(&state.pool)
    .await?;

    audit(&state, &user.id, &id, "CONNECTION_CREATED", &req_meta(&headers)).await;
    conn_response(&state, &id, crypto).await
}

// ---------------------------------------------------------------------------
// PATCH /api/connections/:id — v1 `ConnectionsService.update`
// ---------------------------------------------------------------------------

async fn conn_update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    // `@UseGuards(RbacGuard) @RequireRole('OWNER')` — before body validation.
    require_role(&state, &id, &user.id, "OWNER").await?;

    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let existing = sqlx::query(
        r#"SELECT "credentialsCt","viaAgent","agentId" FROM "Connection" WHERE "id" = $1 LIMIT 1"#,
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let existing_ct: String = existing.try_get("credentialsCt")?;
    let existing_via_agent: bool = existing.try_get("viaAgent")?;
    let existing_agent_id: Option<String> = existing.try_get("agentId")?;

    let m = body_object(&body)?;
    let mut errs: Vec<String> = Vec::new();
    deny_unknown(&m, &UPDATE_KEYS, &mut errs);

    let name = v_str(&m, "name", 1, 80, &mut errs);
    // `credentials: null` is falsy in v1's `if (dto.credentials)`, i.e. absent.
    let credentials = match m.get("credentials") {
        Some(Value::Null) | None => None,
        Some(c) => validate_credentials(c, &mut errs),
    };
    let read_only = v_bool(&m, "readOnly", &mut errs);
    let statement_timeout_ms = v_int(&m, "statementTimeoutMs", 1_000, 600_000, &mut errs);
    let require_review = v_bool(&m, "requireReview", &mut errs);
    let slow_ms = v_int(&m, "slowQueryAlertMs", 100, 600_000, &mut errs);
    let slow_email = v_str(&m, "slowQueryAlertEmail", 0, usize::MAX, &mut errs);
    let workspace_in = v_str(&m, "workspaceId", 0, usize::MAX, &mut errs);
    let via_agent_in = v_bool(&m, "viaAgent", &mut errs);
    let agent_in = v_str(&m, "agentId", 0, usize::MAX, &mut errs);

    if !errs.is_empty() {
        return Err(validation_error(errs));
    }

    let mut sets: Vec<String> = Vec::new();
    let mut binds: Vec<B> = Vec::new();

    if let Some(v) = name {
        binds.push(B::Text(v));
        sets.push(format!(r#""name" = ${}"#, binds.len()));
    }
    if let Some(v) = read_only {
        binds.push(B::Bool(v));
        sets.push(format!(r#""readOnly" = ${}"#, binds.len()));
    }
    if let Some(v) = statement_timeout_ms {
        binds.push(B::Int(v as i32));
        sets.push(format!(r#""statementTimeoutMs" = ${}"#, binds.len()));
    }
    if let Some(v) = require_review {
        binds.push(B::Bool(v));
        sets.push(format!(r#""requireReview" = ${}"#, binds.len()));
    }
    // Slow-query alert config: absent = keep, null = clear.
    if m.contains_key("slowQueryAlertMs") {
        binds.push(B::OptInt(slow_ms.map(|v| v as i32)));
        sets.push(format!(r#""slowQueryAlertMs" = ${}"#, binds.len()));
    }
    if m.contains_key("slowQueryAlertEmail") {
        binds.push(B::OptText(slow_email));
        sets.push(format!(r#""slowQueryAlertEmail" = ${}"#, binds.len()));
    }

    if m.contains_key("workspaceId") {
        // Verify the caller is a member of the destination workspace. (v1 passes
        // a null workspaceId straight into a compound-unique lookup and 500s;
        // treated as "not a member" here.) Same 500-vs-400 note as create.
        let ws = workspace_in;
        let member: Option<bool> = match ws.as_deref() {
            Some(w) => {
                sqlx::query_scalar(
                    r#"SELECT true FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2 LIMIT 1"#,
                )
                .bind(w)
                .bind(&user.id)
                .fetch_optional(&state.pool)
                .await?
            }
            None => None,
        };
        if member.is_none() {
            return Err(ApiError::bad("You are not a member of the destination workspace"));
        }
        binds.push(B::OptText(ws));
        sets.push(format!(r#""workspaceId" = ${}"#, binds.len()));
    }

    // Local-agent routing: absent = keep as-is; false = disable + unlink;
    // true = enable with a validated, user-owned agent.
    //
    // SECURITY: `viaAgent` is what exempts a connection from the dialability
    // check, and `agentId` is what binds it to a machine the caller controls.
    // Every path that can set either goes through assert_owned_agent.
    let mut new_via_agent: Option<bool> = None;
    let mut new_agent_id: Option<Option<String>> = None;
    if m.contains_key("viaAgent") {
        // A present-but-null `viaAgent` is falsy in v1 → disable.
        if via_agent_in.unwrap_or(false) {
            let chosen = agent_in.clone().or_else(|| existing_agent_id.clone());
            new_agent_id = Some(Some(assert_owned_agent(&state, chosen.as_deref(), &user.id).await?));
            new_via_agent = Some(true);
        } else {
            new_via_agent = Some(false);
            new_agent_id = Some(None);
        }
    } else if m.contains_key("agentId") && existing_via_agent {
        // Switching which agent an already-agent-routed connection uses.
        new_agent_id = Some(Some(assert_owned_agent(&state, agent_in.as_deref(), &user.id).await?));
    }
    if let Some(v) = new_via_agent {
        binds.push(B::Bool(v));
        sets.push(format!(r#""viaAgent" = ${}"#, binds.len()));
    }
    if let Some(v) = new_agent_id {
        binds.push(B::OptText(v));
        sets.push(format!(r#""agentId" = ${}"#, binds.len()));
    }

    // SECURITY: re-validate the effective dial target. Two things can repoint a
    // connection at our internals: new credentials, or switching agent routing
    // OFF — which makes US dial a host that was previously reached from the
    // user's own network. Both are covered here.
    let effective_via_agent = new_via_agent.unwrap_or(existing_via_agent);
    if let Some(provided) = credentials {
        let current = decrypt_creds(crypto, &existing_ct, &id)?;
        // Start from current, apply provided fields, then strip the tunnel if
        // the client sent `ssh: null`.
        let mut merged = current;
        let sent_null_ssh = matches!(provided.get("ssh"), Some(Value::Null));
        for (k, v) in provided {
            merged.insert(k, v);
        }
        if sent_null_ssh {
            merged.remove("ssh");
        }
        assert_dialable_target(&state, Some(&merged), effective_via_agent, &user.id).await?;
        let ct = crypto
            .encrypt(&Value::Object(merged).to_string(), &crypto::Crypto::conn_purpose(&id))
            .map_err(|e| ApiError::internal(e.to_string()))?;
        binds.push(B::Text(ct));
        sets.push(format!(r#""credentialsCt" = ${}"#, binds.len()));
    } else if new_via_agent == Some(false) && existing_via_agent {
        let current = decrypt_creds(crypto, &existing_ct, &id)?;
        assert_dialable_target(&state, Some(&current), false, &user.id).await?;
    }

    // Prisma's `@updatedAt` always fires, even when `data` is otherwise empty.
    sets.push(r#""updatedAt" = now()"#.to_string());
    binds.push(B::Text(id.clone()));
    let sql = format!(
        r#"UPDATE "Connection" SET {} WHERE "id" = ${}"#,
        sets.join(", "),
        binds.len()
    );
    bind_all(&sql, binds).execute(&state.pool).await?;

    audit(&state, &user.id, &id, "CONNECTION_UPDATED", &req_meta(&headers)).await;
    conn_response(&state, &id, crypto).await
}

/// Decrypt the stored credentials blob. Errors here are genuinely exceptional
/// (wrong key, or a `clientHeldKey` connection the server cannot read) and v1
/// lets them surface as a 500 too.
fn decrypt_creds(crypto: &crypto::Crypto, ct: &str, id: &str) -> ApiResult<Map<String, Value>> {
    let plain = crypto
        .decrypt(ct, &crypto::Crypto::conn_purpose(id))
        .map_err(|e| ApiError::internal(format!("Could not read stored credentials: {e}")))?;
    match serde_json::from_str::<Value>(&plain) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(ApiError::internal("Stored credentials are not a JSON object")),
    }
}
