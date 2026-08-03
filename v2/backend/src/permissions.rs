//! Connection permissions — members, pending invites and per-table grants.
//!
//! Rust port of v1's `connections/permissions.controller.ts` +
//! `permissions.service.ts` (with the role resolution from `rbac/rbac.service.ts`
//! and the seat cap from `billing/plan.service.ts`).
//!
//! Wire contract is byte-for-byte with v1 — same paths, same JSON field names,
//! same status codes, same human error strings — because the existing frontend
//! (`frontend/src/lib/api.ts`, `AddMemberResult` / `ConnectionMember` /
//! `ConnectionInvite` / `TableGrant`) is shared by both stacks.
//!
//! Two v1 details that are easy to get wrong and are reproduced deliberately:
//!
//!  1. **Two-stage authorization.** Nest runs `RbacGuard` (a guard) before the
//!     service body (which calls `assertOwner`). The guard's minimum role is
//!     `OWNER` only on the three GETs; every write route falls back to the
//!     guard's `VIEWER` default and is then owner-gated *inside* the service.
//!     The observable consequence is two different 403 messages:
//!       * no access at all      → "No access to this connection"   (guard)
//!       * member but not owner  → "Only the connection owner can manage permissions"
//!     A single owner check would collapse those and change the UI copy.
//!
//!  2. **The GETs are not strictly owner-only.** `RbacGuard` compares the
//!     *effective* role, and a `ConnectionMember`/`WorkspaceMember` row may
//!     itself carry `role = OWNER`. Such a user passes the GET guard but is
//!     still rejected by `assertOwner` on the writes. Looks inconsistent; it is
//!     v1's actual behaviour, so it is preserved.
//!
//! No `@HttpCode` decorator appears on this controller, so Nest's defaults
//! apply: POST → 201, everything else → 200. In particular the DELETE handlers
//! return **200 with an empty body**, not 204 (unlike row-filters/column-masks,
//! which do carry `@HttpCode(204)` — that is why the sibling handlers in
//! main.rs answer 204 and these do not).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, patch, post},
    Json, Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{audit, conn_role, gen_id, ident_ok, req_meta, send_mail, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/connections/:id/permissions/members",
            get(list_members).post(add_member),
        )
        .route(
            "/api/connections/:id/permissions/members/:memberId",
            patch(update_member).delete(remove_member),
        )
        .route("/api/connections/:id/permissions/invites", get(list_invites))
        .route(
            "/api/connections/:id/permissions/invites/:inviteId",
            delete(revoke_invite),
        )
        .route(
            "/api/connections/:id/permissions/table-grants",
            get(list_grants).post(upsert_grant),
        )
        .route(
            "/api/connections/:id/permissions/table-grants/:grantId",
            delete(remove_grant),
        )
}

// ---------------------------------------------------------------------------
// Authorization (port of RbacGuard + RbacService.require + assertOwner)
// ---------------------------------------------------------------------------

/// `RANK` from rbac.service.ts. Unknown strings sort below VIEWER so a future
/// enum value can never accidentally satisfy an OWNER requirement.
fn rank(role: &str) -> i32 {
    match role {
        "VIEWER" => 1,
        "EDITOR" => 2,
        "OWNER" => 3,
        _ => 0,
    }
}

/// `RbacService.require` — resolves the effective role and enforces a minimum.
/// The extra "does the connection exist?" probe only runs on the failure path,
/// exactly as in v1, so the happy path stays a single query.
async fn require_role(state: &AppState, conn_id: &str, user_id: &str, min: &str) -> ApiResult<String> {
    let role = conn_role(&state.pool, conn_id, user_id).await?;
    let Some(role) = role else {
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

/// `PermissionsService.assertOwner`. Returns the owner id so callers that need
/// it (add-member, upsert-grant) don't re-query "Connection".
///
/// NOTE the message differs from main.rs's `require_conn_owner`
/// ("No access to this connection") — this controller has its own wording and
/// the frontend surfaces it verbatim.
async fn assert_owner(state: &AppState, conn_id: &str, actor_user_id: &str) -> ApiResult<String> {
    let owner: Option<String> = sqlx::query_scalar(r#"SELECT "ownerId" FROM "Connection" WHERE "id" = $1"#)
        .bind(conn_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    match owner {
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "Connection not found")),
        Some(o) if o == actor_user_id => Ok(o),
        Some(_) => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the connection owner can manage permissions",
        )),
    }
}

/// The write routes' full gate: `RbacGuard` at its VIEWER default first, then
/// the service's `assertOwner`. Order is load-bearing — see the module docs.
/// (`min = VIEWER` is the lowest rank, so the guard's "Requires X role" branch
/// can never fire here; only the 404 / no-access branches can.)
async fn guard_then_assert_owner(state: &AppState, conn_id: &str, actor_user_id: &str) -> ApiResult<String> {
    require_role(state, conn_id, actor_user_id, "VIEWER").await?;
    assert_owner(state, conn_id, actor_user_id).await
}

// ---------------------------------------------------------------------------
// Seat cap (port of PlanService.seatLimitForUser + assertSeatAvailable)
// ---------------------------------------------------------------------------

/// `PlanService.seatLimitForUser`. `Ok(None)` = unlimited (TEAM).
///
/// `isEntitled` is inlined into the WHERE clause: a subscription counts only
/// while it isn't SUSPENDED *and* its period is still open, which is what makes
/// access lapse exactly at `periodEnd` with no scheduler involved.
async fn seat_limit_for_user(state: &AppState, user_id: &str) -> ApiResult<Option<i64>> {
    let rows = sqlx::query(
        r#"SELECT s."plan"::text AS "plan", s."seats"
             FROM "Subscription" s
             JOIN "Workspace" w ON w."id" = s."workspaceId"
            WHERE w."ownerId" = $1
              AND s."status"::text <> 'SUSPENDED'
              AND s."periodEnd" > now()"#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;

    // No entitled subscription on any workspace they own → trial/locked = 1 seat.
    if rows.is_empty() {
        return Ok(Some(1));
    }
    let plans: Vec<(String, i32)> = rows
        .iter()
        .map(|r| {
            (
                r.try_get::<String, _>("plan").unwrap_or_default(),
                r.try_get::<i32, _>("seats").unwrap_or(1),
            )
        })
        .collect();
    if plans.iter().any(|(p, _)| p == "TEAM") {
        return Ok(None); // unlimited — grandfathered manual overrides
    }
    let pro_max = plans
        .iter()
        .filter(|(p, _)| p == "PRO")
        .map(|(_, seats)| *seats as i64)
        .max();
    // Math.max(1, ...proSeats) — a PRO row with seats < 1 still yields 1.
    Ok(Some(pro_max.map(|s| s.max(1)).unwrap_or(1)))
}

/// `PermissionsService.assertSeatAvailable`. "Seats used" = current members +
/// still-pending invites; the owner is implicit and never counted.
async fn assert_seat_available(state: &AppState, conn_id: &str, owner_id: &str) -> ApiResult<()> {
    let Some(limit) = seat_limit_for_user(state, owner_id).await? else {
        return Ok(()); // null maxSeats (TEAM) = unlimited
    };
    let members: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "ConnectionMember" WHERE "connectionId" = $1"#)
        .bind(conn_id)
        .fetch_one(&state.pool)
        .await?;
    let invites: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM "ConnectionInvite" WHERE "connectionId" = $1 AND "status" = 'PENDING'"#,
    )
    .bind(conn_id)
    .fetch_one(&state.pool)
    .await?;
    if members + invites >= limit {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!(
                "You've used all {limit} of your seat(s). Add more seats on the Billing page to invite more members."
            ),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// DTO validation (port of the class-validator decorators + global ValidationPipe)
// ---------------------------------------------------------------------------

/// v1's global `ValidationPipe` throws a `BadRequestException` whose `message`
/// is an **array** of strings; `frontend/src/lib/api.ts` joins arrays with ", ".
/// Building the body by hand keeps that shape (a plain `ApiError::bad` would
/// emit a bare string and change what the user reads).
fn validation_error(messages: Vec<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: messages.join(", "),
        body: Some(json!({
            "statusCode": 400,
            // v1's HttpExceptionFilter emits `code`; v2's envelope emits `error`.
            // Send both so either reader works.
            "code": "Bad Request",
            "error": "Bad Request",
            "message": messages,
        })),
    }
}

/// Approximation of class-validator's `@IsEmail()` (validator.js `isEmail`).
/// Deliberately loose — the field is only ever used to look a user up or to
/// address an invite, so the exact RFC edge cases don't change behaviour; this
/// just rejects the obvious garbage that v1 also rejects.
fn is_email(s: &str) -> bool {
    let mut parts = s.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !s.chars().any(|c| c.is_whitespace())
}

const ROLES: [&str; 3] = ["OWNER", "EDITOR", "VIEWER"];
/// class-validator's `@IsEnum(Role)` message, with the enum members in the
/// order Prisma declares them (prisma/enums/role.prisma).
const ROLE_MSG: &str = "role must be one of the following values: OWNER, EDITOR, VIEWER";

fn str_field(body: &Value, key: &str) -> Option<String> {
    body.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// `@IsString() @Length(1, 64) @Matches(IDENT)` on schemaName / tableName.
/// `ident_ok` (main.rs) implements the exact `^[A-Za-z_][A-Za-z0-9_]{0,63}$`
/// shape used by the controller's IDENT regex and by drivers/quote.util.ts.
fn check_ident(field: &str, value: &Option<String>, errs: &mut Vec<String>) {
    match value {
        None => errs.push(format!("{field} must be a string")),
        Some(v) if !ident_ok(v) => errs.push(format!(
            "{field} must match /^[A-Za-z_][A-Za-z0-9_]{{0,63}}$/ regular expression"
        )),
        Some(_) => {}
    }
}

// ---------------------------------------------------------------------------
// Row → JSON
// ---------------------------------------------------------------------------

/// Prisma maps `DateTime` to `timestamp(3)` **without** time zone, so these
/// columns decode as `NaiveDateTime` (a `DateTime<Utc>` decode would fail and
/// silently yield null). v1 ships them through `JSON.stringify(Date)`, i.e.
/// millisecond precision with a trailing `Z` — reproduced here exactly.
fn iso_ms(r: &PgRow, col: &str) -> Option<String> {
    r.try_get::<chrono::NaiveDateTime, _>(col)
        .ok()
        .map(|d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// `MemberView`
fn member_json(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "email": r.try_get::<String, _>("email").unwrap_or_default(),
        "displayName": r.try_get::<Option<String>, _>("displayName").ok().flatten(),
        "role": r.try_get::<String, _>("role").unwrap_or_default(),
        "createdAt": iso_ms(r, "createdAt"),
    })
}

/// `InviteView`
fn invite_json(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "email": r.try_get::<String, _>("email").unwrap_or_default(),
        "role": r.try_get::<String, _>("role").unwrap_or_default(),
        "status": r.try_get::<String, _>("status").unwrap_or_default(),
        "createdAt": iso_ms(r, "createdAt"),
    })
}

/// `TableGrantView`
fn grant_json(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "email": r.try_get::<String, _>("email").unwrap_or_default(),
        "displayName": r.try_get::<Option<String>, _>("displayName").ok().flatten(),
        "schemaName": r.try_get::<String, _>("schemaName").unwrap_or_default(),
        "tableName": r.try_get::<String, _>("tableName").unwrap_or_default(),
        "role": r.try_get::<String, _>("role").unwrap_or_default(),
        "createdAt": iso_ms(r, "createdAt"),
    })
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/// GET /api/connections/:id/permissions/members — `@RequireRole('OWNER')`.
async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let rows = sqlx::query(
        r#"SELECT m."id", m."userId", m."role"::text AS "role", m."createdAt",
                  u."email", u."displayName"
             FROM "ConnectionMember" m
             JOIN "User" u ON u."id" = m."userId"
            WHERE m."connectionId" = $1
            ORDER BY m."createdAt" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(rows.iter().map(member_json).collect())))
}

/// POST /api/connections/:id/permissions/members
///
/// Adds a registered user immediately, or creates/refreshes a pending invite
/// for an email with no account yet. Returns `{ kind: 'member' | 'invite', … }`.
async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // Nest order: guards → pipes (validation) → handler. Keep it — a stranger
    // poking at someone else's connection must get 403/404, never a 400 that
    // would confirm the body shape.
    require_role(&state, &id, &user.id, "VIEWER").await?;

    // AddMemberDto: @IsEmail() email, @IsEnum(Role) role — declaration order
    // is the order class-validator reports the messages in.
    let email = str_field(&body, "email");
    let role = str_field(&body, "role");
    let mut errs: Vec<String> = Vec::new();
    if !email.as_deref().map(is_email).unwrap_or(false) {
        errs.push("email must be an email".into());
    }
    if !role.as_deref().map(|r| ROLES.contains(&r)).unwrap_or(false) {
        errs.push(ROLE_MSG.into());
    }
    if !errs.is_empty() {
        return Err(validation_error(errs));
    }
    let email = email.unwrap();
    let role = role.unwrap();

    let owner_id = assert_owner(&state, &id, &user.id).await?;
    let norm_email = email.trim().to_lowercase();

    let target = sqlx::query(r#"SELECT "id", "email", "displayName" FROM "User" WHERE "email" = $1"#)
        .bind(&norm_email)
        .fetch_optional(&state.pool)
        .await?;

    // Unregistered → create/refresh a pending invitation and email it.
    let Some(target) = target else {
        return invite_unregistered(&state, &id, &user.id, &norm_email, &role).await;
    };

    let target_id: String = target.try_get("id").unwrap_or_default();
    let target_email: String = target.try_get("email").unwrap_or_default();
    let target_name: Option<String> = target.try_get::<Option<String>, _>("displayName").ok().flatten();

    if owner_id == target_id {
        return Err(ApiError::bad("Owner is already an implicit member"));
    }

    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT "id" FROM "ConnectionMember" WHERE "connectionId" = $1 AND "userId" = $2"#,
    )
    .bind(&id)
    .bind(&target_id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    if existing.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "User already a member"));
    }

    // A new member consumes a seat. v1 charges it to the connection OWNER's
    // plan (not the actor's) — identical here because assertOwner already
    // proved actor == owner, but keep the owner id so the intent stays clear.
    assert_seat_available(&state, &id, &owner_id).await?;

    let row = sqlx::query(
        r#"INSERT INTO "ConnectionMember" ("id","connectionId","userId","role","createdAt")
           VALUES ($1,$2,$3,$4::"Role",now())
           RETURNING "id","role"::text AS "role","createdAt""#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&target_id)
    .bind(&role)
    .fetch_one(&state.pool)
    .await?;

    // A stale pending invite for this address is now moot. Best-effort in v1
    // too (`.catch(() => undefined)`) — never fail the add over it.
    let _ = sqlx::query(r#"DELETE FROM "ConnectionInvite" WHERE "connectionId" = $1 AND "email" = $2"#)
        .bind(&id)
        .bind(&norm_email)
        .execute(&state.pool)
        .await;

    // v1 never writes this row even though MEMBER_ADDED exists in the
    // AuditAction enum. Additive and best-effort (see `audit`): it cannot
    // change the response, so the wire contract is untouched.
    audit(
        &state,
        Some(&user.id),
        "MEMBER_ADDED",
        &req_meta(&headers),
        Some(json!({ "connectionId": id, "userId": target_id, "role": role })),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "kind": "member",
            "member": {
                "id": row.try_get::<String, _>("id").unwrap_or_default(),
                "userId": target_id,
                "email": target_email,
                "displayName": target_name,
                "role": row.try_get::<String, _>("role").unwrap_or_default(),
                "createdAt": iso_ms(&row, "createdAt"),
            }
        })),
    ))
}

/// `PermissionsService.inviteUnregistered`.
async fn invite_unregistered(
    state: &AppState,
    conn_id: &str,
    actor_user_id: &str,
    email: &str,
    role: &str,
) -> ApiResult<(StatusCode, Json<Value>)> {
    // A brand-new invite consumes a seat; re-inviting an address that already
    // has a pending row (a role/token refresh) does not.
    let existing: Option<String> = sqlx::query_scalar(
        r#"SELECT "id" FROM "ConnectionInvite" WHERE "connectionId" = $1 AND "email" = $2"#,
    )
    .bind(conn_id)
    .bind(email)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    if existing.is_none() {
        assert_seat_available(state, conn_id, actor_user_id).await?;
    }

    // Node: randomBytes(24).toString('base64url') → 32 unpadded base64url chars.
    let token = {
        use rand::RngCore;
        let mut b = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut b);
        URL_SAFE_NO_PAD.encode(b)
    };

    // Prisma upsert on the @@unique([connectionId, email]) pair. `updatedAt` is
    // an `@updatedAt` field — Prisma sets it client-side, so there is no DB
    // default and Rust must write it on both the insert and the update.
    let invite = sqlx::query(
        r#"INSERT INTO "ConnectionInvite"
             ("id","connectionId","email","role","invitedById","token","status","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4::"Role",$5,$6,'PENDING',now(),now())
           ON CONFLICT ("connectionId","email") DO UPDATE
             SET "role" = EXCLUDED."role",
                 "status" = 'PENDING',
                 "token" = EXCLUDED."token",
                 "invitedById" = EXCLUDED."invitedById",
                 "updatedAt" = now()
           RETURNING "id","email","role"::text AS "role","status","createdAt""#,
    )
    .bind(gen_id())
    .bind(conn_id)
    .bind(email)
    .bind(role)
    .bind(actor_user_id)
    .bind(&token)
    .fetch_one(&state.pool)
    .await?;

    let conn_name: Option<String> = sqlx::query_scalar(r#"SELECT "name" FROM "Connection" WHERE "id" = $1"#)
        .bind(conn_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let conn_name = conn_name.unwrap_or_else(|| "a database connection".into());
    let emailed = send_invite_email(state, email, &conn_name, &token).await;

    Ok((
        StatusCode::CREATED,
        Json(json!({ "kind": "invite", "invite": invite_json(&invite), "emailed": emailed })),
    ))
}

/// JS `encodeURIComponent` — same unreserved set, so a token/email round-trips
/// through the invite link identically to v1's.
fn enc_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')') {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `PermissionsService.sendInviteEmail`. Returns whether the mail actually went
/// out; a failure is reported to the caller as `emailed: false`, never as an
/// error — the invite row is already committed and the owner can resend.
/// `send_mail` also returns false when mail isn't configured, matching v1's
/// `if (!this.email.enabled) return false`.
async fn send_invite_email(state: &AppState, email: &str, conn_name: &str, token: &str) -> bool {
    let link = format!(
        "{}/signup?invite={}&email={}",
        state.app_base_url,
        enc_uri_component(token),
        enc_uri_component(email)
    );
    // v1 interpolates the connection name into the HTML unescaped; kept as-is
    // so the two stacks render identical mail.
    let text = format!(
        "You've been invited to access the \"{conn_name}\" database connection on Query Schema.\n\n\
         Create your account with this email to get access:\n{link}\n\n\
         If you didn't expect this, you can ignore this email."
    );
    let html = format!(
        "<p>You've been invited to access the <b>{conn_name}</b> database connection on Query Schema.</p>\
         <p>Create your account with this email to get access:</p>\
         <p><a href=\"{link}\">Accept the invitation</a></p>\
         <p style=\"color:#888;font-size:12px\">If you didn't expect this, you can ignore this email.</p>"
    );
    send_mail(
        state,
        email,
        "You've been invited to collaborate on Query Schema",
        &text,
        &html,
    )
    .await
}

/// PATCH /api/connections/:id/permissions/members/:memberId
async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "VIEWER").await?;

    // UpdateMemberRoleDto: @IsEnum(Role) role
    let role = str_field(&body, "role");
    if !role.as_deref().map(|r| ROLES.contains(&r)).unwrap_or(false) {
        return Err(validation_error(vec![ROLE_MSG.into()]));
    }
    let role = role.unwrap();

    assert_owner(&state, &id, &user.id).await?;

    // v1 does findFirst-then-update; folded into one statement here. The join
    // on "User" can't lose a row (userId is a FK), so "no row updated" still
    // means exactly "no such member on this connection".
    let row = sqlx::query(
        r#"UPDATE "ConnectionMember" m
              SET "role" = $1::"Role"
             FROM "User" u
            WHERE m."id" = $2 AND m."connectionId" = $3 AND u."id" = m."userId"
        RETURNING m."id", m."userId", m."role"::text AS "role", m."createdAt",
                  u."email", u."displayName""#,
    )
    .bind(&role)
    .bind(&member_id)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Member not found"))?;

    Ok(Json(member_json(&row)))
}

/// DELETE /api/connections/:id/permissions/members/:memberId
/// Returns 200 with an empty body (no `@HttpCode(204)` on this controller).
async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    Path((id, member_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    guard_then_assert_owner(&state, &id, &user.id).await?;

    let target_user_id: Option<String> = sqlx::query_scalar(
        r#"SELECT "userId" FROM "ConnectionMember" WHERE "id" = $1 AND "connectionId" = $2"#,
    )
    .bind(&member_id)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    let target_user_id =
        target_user_id.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Member not found"))?;

    // v1's `$transaction([...])`: the member's table grants must not outlive
    // the membership, or a later re-add would silently resurrect old overrides.
    let mut tx = state.pool.begin().await?;
    sqlx::query(r#"DELETE FROM "TableGrant" WHERE "connectionId" = $1 AND "userId" = $2"#)
        .bind(&id)
        .bind(&target_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"DELETE FROM "ConnectionMember" WHERE "id" = $1"#)
        .bind(&member_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Additive, like MEMBER_ADDED above — v1 emits no audit row here.
    audit(
        &state,
        Some(&user.id),
        "MEMBER_REMOVED",
        &req_meta(&headers),
        Some(json!({ "connectionId": id, "userId": target_user_id })),
    )
    .await;

    Ok(StatusCode::OK)
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

/// GET /api/connections/:id/permissions/invites — `@RequireRole('OWNER')`.
/// Only PENDING rows; ACCEPTED/REVOKED ones stay in the table as history.
async fn list_invites(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let rows = sqlx::query(
        r#"SELECT "id","email","role"::text AS "role","status","createdAt"
             FROM "ConnectionInvite"
            WHERE "connectionId" = $1 AND "status" = 'PENDING'
            ORDER BY "createdAt" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(rows.iter().map(invite_json).collect())))
}

/// DELETE /api/connections/:id/permissions/invites/:inviteId → 200, empty body.
async fn revoke_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, invite_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    guard_then_assert_owner(&state, &id, &user.id).await?;
    // Scoped by connectionId so an id from another connection 404s rather than
    // being deleted (v1 does the same findFirst-then-delete).
    let r = sqlx::query(r#"DELETE FROM "ConnectionInvite" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&invite_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Invitation not found"));
    }
    Ok(StatusCode::OK)
}

// ---------------------------------------------------------------------------
// Per-table grants
// ---------------------------------------------------------------------------

/// GET /api/connections/:id/permissions/table-grants — `@RequireRole('OWNER')`.
async fn list_grants(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_role(&state, &id, &user.id, "OWNER").await?;
    let rows = sqlx::query(
        r#"SELECT g."id", g."userId", g."schemaName", g."tableName",
                  g."role"::text AS "role", g."createdAt",
                  u."email", u."displayName"
             FROM "TableGrant" g
             JOIN "User" u ON u."id" = g."userId"
            WHERE g."connectionId" = $1
            ORDER BY g."schemaName" ASC, g."tableName" ASC, g."createdAt" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(Value::Array(rows.iter().map(grant_json).collect())))
}

/// POST /api/connections/:id/permissions/table-grants (create or update).
async fn upsert_grant(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    require_role(&state, &id, &user.id, "VIEWER").await?;

    // UpsertTableGrantDto: email, schemaName, tableName, role — reported in
    // property-declaration order.
    let email = str_field(&body, "email");
    let schema_name = str_field(&body, "schemaName");
    let table_name = str_field(&body, "tableName");
    let role = str_field(&body, "role");
    let mut errs: Vec<String> = Vec::new();
    if !email.as_deref().map(is_email).unwrap_or(false) {
        errs.push("email must be an email".into());
    }
    check_ident("schemaName", &schema_name, &mut errs);
    check_ident("tableName", &table_name, &mut errs);
    if !role.as_deref().map(|r| ROLES.contains(&r)).unwrap_or(false) {
        errs.push(ROLE_MSG.into());
    }
    if !errs.is_empty() {
        return Err(validation_error(errs));
    }
    let email = email.unwrap();
    let schema_name = schema_name.unwrap();
    let table_name = table_name.unwrap();
    let role = role.unwrap();

    let owner_id = assert_owner(&state, &id, &user.id).await?;

    let target = sqlx::query(r#"SELECT "id", "email", "displayName" FROM "User" WHERE "email" = $1"#)
        .bind(email.trim().to_lowercase())
        .fetch_optional(&state.pool)
        .await?;
    // v1 interpolates the RAW submitted email here, not the normalized one.
    let target = target.ok_or_else(|| {
        ApiError::new(StatusCode::NOT_FOUND, format!("No user with email {email}"))
    })?;
    let target_id: String = target.try_get("id").unwrap_or_default();
    let target_email: String = target.try_get("email").unwrap_or_default();
    let target_name: Option<String> = target.try_get::<Option<String>, _>("displayName").ok().flatten();

    // Table grants must never be able to lock the connection owner out of a
    // table (rbac.effectiveTableRole short-circuits to OWNER for them anyway,
    // so such a row would be dead weight).
    if owner_id == target_id {
        return Err(ApiError::bad("Cannot override role for the connection owner"));
    }

    let row = sqlx::query(
        r#"INSERT INTO "TableGrant"
             ("id","connectionId","userId","schemaName","tableName","role","createdAt")
           VALUES ($1,$2,$3,$4,$5,$6::"Role",now())
           ON CONFLICT ("connectionId","userId","schemaName","tableName") DO UPDATE
             SET "role" = EXCLUDED."role"
           RETURNING "id","userId","schemaName","tableName","role"::text AS "role","createdAt""#,
    )
    .bind(gen_id())
    .bind(&id)
    .bind(&target_id)
    .bind(&schema_name)
    .bind(&table_name)
    .bind(&role)
    .fetch_one(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": row.try_get::<String, _>("id").unwrap_or_default(),
            "userId": target_id,
            "email": target_email,
            "displayName": target_name,
            "schemaName": row.try_get::<String, _>("schemaName").unwrap_or_default(),
            "tableName": row.try_get::<String, _>("tableName").unwrap_or_default(),
            "role": row.try_get::<String, _>("role").unwrap_or_default(),
            "createdAt": iso_ms(&row, "createdAt"),
        })),
    ))
}

/// DELETE /api/connections/:id/permissions/table-grants/:grantId → 200, empty body.
async fn remove_grant(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, grant_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    guard_then_assert_owner(&state, &id, &user.id).await?;
    let r = sqlx::query(r#"DELETE FROM "TableGrant" WHERE "id" = $1 AND "connectionId" = $2"#)
        .bind(&grant_id)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    if r.rows_affected() == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Grant not found"));
    }
    Ok(StatusCode::OK)
}
