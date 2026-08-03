//! Workspaces — Rust port of v1's `WorkspacesController` + `WorkspacesService`
//! (`backend/src/workspaces/workspaces.{controller,service}.ts`).
//!
//! Behaviour is a 1:1 translation: same paths, same guards, same HTTP status
//! codes and the same literal error strings, because the v1 frontend renders
//! `data.message` verbatim and existing clients branch on the statuses.
//!
//! Two v1-isms are reproduced here that are easy to miss:
//!   * Nest's `@Post` defaults to **201** and the two `@HttpCode(204)` deletes
//!     return an empty **204** — not 200.
//!   * The global `ValidationPipe({ whitelist, forbidNonWhitelisted })` runs
//!     BEFORE the handler, so DTO validation always precedes the role check.
//!     Hence `rename` validates `name` first and only then asserts OWNER.
//!
//! `GET /api/workspaces` is deliberately absent — main.rs already serves it as
//! `v1_workspaces_list`, and this router is `merge`d into that one.
//!
//! No table/column here is `@map`ped in Prisma, so every identifier is the
//! quoted PascalCase/camelCase name (`"Workspace"."isPersonal"` etc.).

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::postgres::PgRow;
use sqlx::Row;

use crate::{gen_id, iso, slugify, ApiError, ApiResult, AppState, AuthUser};

pub fn routes() -> Router<AppState> {
    Router::new()
        // GET /api/workspaces stays in main.rs (`v1_workspaces_list`); axum
        // merges method routers for the same path, so registering only POST
        // here is safe.
        .route("/api/workspaces", post(create))
        .route("/api/workspaces/:id", get(get_one).patch(rename).delete(remove))
        .route("/api/workspaces/:id/members", post(add_member))
        .route(
            "/api/workspaces/:id/members/:memberId",
            patch(update_member).delete(remove_member),
        )
}

// ---------------------------------------------------------------------------
// Row → JSON
// ---------------------------------------------------------------------------

/// Every scalar Prisma returns for a `Workspace` (relations are opt-in via
/// `include`, scalars never are) — including `organizationId`, which v1 does
/// ship on create/update responses.
const WS_COLS: &str =
    r#""id","name","slug","isPersonal","ownerId","organizationId","createdAt","updatedAt""#;

/// `role` is a Postgres enum, so cast it to text for decoding; the alias keeps
/// the JSON key identical to Prisma's.
const MEMBER_COLS: &str = r#""id","workspaceId","userId","role"::text AS "role","createdAt""#;

fn ws_json(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "name": r.try_get::<String, _>("name").unwrap_or_default(),
        "slug": r.try_get::<String, _>("slug").unwrap_or_default(),
        "isPersonal": r.try_get::<bool, _>("isPersonal").unwrap_or(false),
        "ownerId": r.try_get::<String, _>("ownerId").unwrap_or_default(),
        "organizationId": r.try_get::<Option<String>, _>("organizationId").ok().flatten(),
        // Columns are TIMESTAMP(3) without tz — `iso` decodes NaiveDateTime,
        // matching `v1_workspaces_list`'s rendering of the same table.
        "createdAt": iso(r, "createdAt"),
        "updatedAt": iso(r, "updatedAt"),
    })
}

fn member_json(r: &PgRow) -> Value {
    json!({
        "id": r.try_get::<String, _>("id").unwrap_or_default(),
        "workspaceId": r.try_get::<String, _>("workspaceId").unwrap_or_default(),
        "userId": r.try_get::<String, _>("userId").unwrap_or_default(),
        "role": r.try_get::<String, _>("role").unwrap_or_default(),
        "createdAt": iso(r, "createdAt"),
    })
}

// ---------------------------------------------------------------------------
// DTO validation — stands in for v1's global ValidationPipe
// ---------------------------------------------------------------------------

const ROLES: [&str; 3] = ["OWNER", "EDITOR", "VIEWER"];

/// v1 boots with `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`,
/// so any property not on the DTO is a 400 before the handler runs. Reproduced
/// so clients get the identical rejection from v2.
fn reject_unknown(body: &Value, allowed: &[&str]) -> Result<(), ApiError> {
    if let Some(obj) = body.as_object() {
        for k in obj.keys() {
            if !allowed.contains(&k.as_str()) {
                return Err(ApiError::bad(format!("property {k} should not exist")));
            }
        }
    }
    Ok(())
}

/// `@IsString() @Length(1, 80) name` — messages are class-validator's verbatim
/// defaults. `transform.enableImplicitConversion` coerces JSON primitives to
/// the declared TS type, so v1 genuinely accepts `{"name": 5}` as `"5"`.
fn parse_name(body: &Value) -> Result<String, ApiError> {
    reject_unknown(body, &["name"])?;
    let name = match body.get("name") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        // Covers a missing property too: class-validator fires @IsString on
        // `undefined`.
        _ => return Err(ApiError::bad("name must be a string")),
    };
    // class-validator counts UTF-16 code units; `chars()` agrees for everything
    // outside the astral planes and is far closer than a byte length.
    let len = name.chars().count();
    if len < 1 {
        return Err(ApiError::bad("name must be longer than or equal to 1 characters"));
    }
    if len > 80 {
        return Err(ApiError::bad("name must be shorter than or equal to 80 characters"));
    }
    Ok(name)
}

/// `@IsEnum(Role)` — the message lists the enum members in declaration order,
/// exactly as class-validator builds it.
fn parse_role(body: &Value) -> Result<String, ApiError> {
    let role = body.get("role").and_then(|v| v.as_str()).unwrap_or("");
    if !ROLES.contains(&role) {
        return Err(ApiError::bad(
            "role must be one of the following values: OWNER, EDITOR, VIEWER",
        ));
    }
    Ok(role.to_string())
}

/// `@IsEmail()`. Approximates validator.js closely enough for real client input:
/// exactly one `@`, a non-empty local part, a dotted domain, no whitespace.
///
/// NOTE the ordering consequence — v1 validates BEFORE the service trims, so
/// `" a@b.com "` is a 400 here just as in v1, and the service's later `.trim()`
/// is unreachable on that input.
fn parse_email(body: &Value) -> Result<String, ApiError> {
    let raw = body.get("email").and_then(|v| v.as_str()).unwrap_or("");
    let mut parts = raw.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    let ok = parts.next().is_none()
        && !local.is_empty()
        && local.len() <= 64
        && domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !raw.chars().any(|c| c.is_whitespace());
    if !ok {
        return Err(ApiError::bad("email must be an email"));
    }
    Ok(raw.to_string())
}

// ---------------------------------------------------------------------------
// Shared service helpers
// ---------------------------------------------------------------------------

fn role_rank(role: &str) -> i32 {
    match role {
        "OWNER" => 2,
        "EDITOR" => 1,
        _ => 0,
    }
}

/// v1's private `assertRole`: the caller must be a member, and their role must
/// rank at or above `required` (VIEWER < EDITOR < OWNER).
///
/// A workspace that does not exist has no members, so callers guarded by this
/// get 403 "Not a member of this workspace" rather than a 404 — that is v1's
/// behaviour and it also avoids leaking which workspace ids exist.
async fn assert_role(
    state: &AppState,
    workspace_id: &str,
    user_id: &str,
    required: &str,
) -> Result<(), ApiError> {
    let role: Option<String> = sqlx::query_scalar(
        r#"SELECT "role"::text FROM "WorkspaceMember" WHERE "workspaceId" = $1 AND "userId" = $2"#,
    )
    .bind(workspace_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();
    let role = role
        .ok_or_else(|| ApiError::new(StatusCode::FORBIDDEN, "Not a member of this workspace"))?;
    if role_rank(&role) < role_rank(required) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("Requires {required} role"),
        ));
    }
    Ok(())
}

/// `crate::slugify` is v1's `slugify` minus its trailing `.slice(0, 40) || 'ws'`.
/// Workspace slugs depend on both, so re-apply them here.
///
/// The truncation is deliberately NOT re-trimmed: v1 slices *after* trimming
/// dashes, so a 40-char cut can legitimately land on a `-`.
fn base_slug(raw: &str) -> String {
    let s = slugify(raw);
    // slugify emits only ASCII, so a byte slice is always a char boundary.
    let s = if s.len() > 40 { s[..40].to_string() } else { s };
    if s.is_empty() {
        "ws".to_string()
    } else {
        s
    }
}

/// v1's private `uniqueSlug`: probe `base`, then `base-2` … `base-18`, and if
/// all 18 are taken fall back to a millisecond timestamp suffix.
///
/// `Workspace.slug` is UNIQUE, so this is advisory only — two concurrent
/// creates can still both pick the same free slug and one INSERT loses with a
/// 23505. That race exists identically in v1.
async fn unique_slug(state: &AppState, base: &str) -> Result<String, ApiError> {
    let mut slug = base.to_string();
    for i in 2..20 {
        let taken: Option<String> =
            sqlx::query_scalar(r#"SELECT "id" FROM "Workspace" WHERE "slug" = $1"#)
                .bind(&slug)
                .fetch_optional(&state.pool)
                .await?
                .flatten();
        if taken.is_none() {
            return Ok(slug);
        }
        slug = format!("{base}-{i}");
    }
    // v1: `${base}-${Date.now()}` — milliseconds since the epoch.
    Ok(format!("{base}-{}", chrono::Utc::now().timestamp_millis()))
}

/// Both member routes need the target membership resolved and proved to belong
/// to THIS workspace.
///
/// SECURITY (v1's own comment, kept because the reasoning is not obvious):
/// `memberId` is globally unique, so without the workspace check an OWNER of
/// *any* workspace — and everyone owns a personal one — could pass some other
/// workspace's memberId and promote/remove people inside it, which also hands
/// them every connection in that workspace and voids its column masks and row
/// filters.
async fn load_member_in_workspace(
    state: &AppState,
    workspace_id: &str,
    member_id: &str,
) -> Result<String, ApiError> {
    let m = sqlx::query(r#"SELECT "workspaceId","userId" FROM "WorkspaceMember" WHERE "id" = $1"#)
        .bind(member_id)
        .fetch_optional(&state.pool)
        .await?
        // v1 throws a bare NotFoundException → Nest's default 404 body.
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let m_ws: String = m
        .try_get("workspaceId")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let m_user: String = m
        .try_get("userId")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    if m_ws != workspace_id {
        // Bare ForbiddenException → Nest's default 403 body.
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Forbidden"));
    }
    Ok(m_user)
}

async fn workspace_owner(state: &AppState, workspace_id: &str) -> Result<Option<String>, ApiError> {
    Ok(
        sqlx::query_scalar(r#"SELECT "ownerId" FROM "Workspace" WHERE "id" = $1"#)
            .bind(workspace_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten(),
    )
}

// ---------------------------------------------------------------------------
// POST /api/workspaces
// ---------------------------------------------------------------------------

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let name = parse_name(&body)?;
    // v1's service rejects whitespace-only names *after* @Length(1,80) has
    // already accepted them ("   " is 3 chars).
    if name.trim().is_empty() {
        return Err(ApiError::bad("Name is required"));
    }
    let slug = unique_slug(&state, &base_slug(&name)).await?;

    // v1 does this as ONE nested Prisma create, which Prisma runs in a
    // transaction. Splitting it without a transaction could leave a workspace
    // with no OWNER membership — invisible to its own creator, since every read
    // path joins through "WorkspaceMember".
    let mut tx = state.pool.begin().await?;
    let row = sqlx::query(&format!(
        r#"INSERT INTO "Workspace" ("id","name","slug","isPersonal","ownerId","createdAt","updatedAt")
           VALUES ($1,$2,$3,false,$4,now(),now()) RETURNING {WS_COLS}"#
    ))
    // Prisma's @default(cuid()) is generated client-side, so the id must be
    // supplied explicitly — the column has no DB default.
    .bind(gen_id())
    .bind(&name)
    .bind(&slug)
    .bind(&user.id)
    .fetch_one(&mut *tx)
    .await?;
    let ws_id: String = row
        .try_get("id")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    sqlx::query(
        r#"INSERT INTO "WorkspaceMember" ("id","workspaceId","userId","role","createdAt")
           VALUES ($1,$2,$3,'OWNER',now())"#,
    )
    .bind(gen_id())
    .bind(&ws_id)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // Prisma's create returns scalars only (no `members`); Nest's @Post → 201.
    Ok((StatusCode::CREATED, Json(ws_json(&row))))
}

// ---------------------------------------------------------------------------
// GET /api/workspaces/:id
// ---------------------------------------------------------------------------

async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let ws = sqlx::query(&format!(
        r#"SELECT {WS_COLS} FROM "Workspace" WHERE "id" = $1"#
    ))
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;

    // Prisma resolves `include: { members: { include: { user } } }` with a
    // second query and stitches in memory; a JOIN is equivalent because
    // WorkspaceMember.user is a required relation.
    //
    // Prisma emits no ORDER BY here, so v1's member order is whatever Postgres
    // hands back. Ordering by creation keeps the same set but makes the list
    // stable for the UI.
    let rows = sqlx::query(
        r#"SELECT m."id", m."workspaceId", m."userId", m."role"::text AS "role", m."createdAt",
                  u."id" AS "u_id", u."email" AS "u_email", u."displayName" AS "u_displayName"
           FROM "WorkspaceMember" m
           JOIN "User" u ON u."id" = m."userId"
           WHERE m."workspaceId" = $1
           ORDER BY m."createdAt" ASC, m."id" ASC"#,
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;

    let members: Vec<Value> = rows
        .iter()
        .map(|r| {
            let mut m = member_json(r);
            // Only the three fields v1 `select`s — never the password hash.
            m["user"] = json!({
                "id": r.try_get::<String, _>("u_id").unwrap_or_default(),
                "email": r.try_get::<String, _>("u_email").unwrap_or_default(),
                "displayName": r.try_get::<Option<String>, _>("u_displayName").ok().flatten(),
            });
            m
        })
        .collect();

    // v1 derives access from the already-loaded member list rather than a
    // separate assertRole, so a non-member gets 403 only AFTER the 404 check.
    let my_role = rows
        .iter()
        .find_map(|r| {
            let uid: String = r.try_get("userId").ok()?;
            (uid == user.id).then(|| r.try_get::<String, _>("role").unwrap_or_default())
        })
        .ok_or_else(|| {
            ApiError::new(StatusCode::FORBIDDEN, "Not a member of this workspace")
        })?;

    let mut out = ws_json(&ws);
    out["members"] = Value::Array(members);
    out["myRole"] = json!(my_role);
    Ok(Json(out))
}

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:id
// ---------------------------------------------------------------------------

async fn rename(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    // The ValidationPipe runs before the handler in v1, so DTO errors win over
    // the role check even though the service calls assertRole on line 1.
    let name = parse_name(&body)?;
    assert_role(&state, &id, &user.id, "OWNER").await?;
    if name.trim().is_empty() {
        return Err(ApiError::bad("Name is required"));
    }
    // NOTE: v1 does NOT block renaming a personal workspace — only `remove`
    // special-cases `isPersonal`. Left permissive on purpose to stay faithful.
    //
    // Prisma's @updatedAt is applied client-side, so bump it explicitly.
    let row = sqlx::query(&format!(
        r#"UPDATE "Workspace" SET "name" = $1, "updatedAt" = now() WHERE "id" = $2
           RETURNING {WS_COLS}"#
    ))
    .bind(&name)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?
    // Unreachable: assert_role proved a membership row exists and its FK
    // guarantees the workspace does. (v1 would surface Prisma P2025 as a 500.)
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    Ok(Json(ws_json(&row)))
}

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id
// ---------------------------------------------------------------------------

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = sqlx::query(r#"SELECT "ownerId","isPersonal" FROM "Workspace" WHERE "id" = $1"#)
        .bind(&id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    let owner: String = row
        .try_get("ownerId")
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let is_personal: bool = row.try_get("isPersonal").unwrap_or(false);

    // v1 compares ownerId directly here instead of calling assertRole, so an
    // OWNER-role member who is not the workspace owner is refused too.
    if owner != user.id {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the owner can delete a workspace",
        ));
    }
    // A personal workspace is auto-created per user and is where unassigned
    // connections live, so it must never disappear.
    if is_personal {
        return Err(ApiError::bad("Cannot delete a personal workspace"));
    }

    // Members / SSO / subscription / billing rows are ON DELETE CASCADE and
    // Connection.workspaceId is ON DELETE SET NULL, so one statement is enough
    // — Prisma leans on the same FK actions.
    sqlx::query(r#"DELETE FROM "Workspace" WHERE "id" = $1"#)
        .bind(&id)
        .execute(&state.pool)
        .await?;
    // @HttpCode(204): empty body.
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// POST /api/workspaces/:id/members
// ---------------------------------------------------------------------------

async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    reject_unknown(&body, &["email", "role"])?;
    // Property order matches the DTO so the first reported error matches v1's.
    let email = parse_email(&body)?;
    let role = parse_role(&body)?;
    assert_role(&state, &id, &user.id, "OWNER").await?;

    let target: Option<String> =
        sqlx::query_scalar(r#"SELECT "id" FROM "User" WHERE "email" = $1"#)
            .bind(email.trim().to_lowercase())
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    let target = target.ok_or_else(|| {
        ApiError::new(StatusCode::NOT_FOUND, "User with that email not found")
    })?;

    // v1 wraps the create in a bare `try { } catch { }` and reports EVERY
    // failure as "User is already a member" — realistically the
    // @@unique([workspaceId, userId]) violation. Mapping all errors keeps the
    // response identical rather than leaking a DB message the way v2's default
    // `From<sqlx::Error>` would.
    let row = sqlx::query(&format!(
        r#"INSERT INTO "WorkspaceMember" ("id","workspaceId","userId","role","createdAt")
           VALUES ($1,$2,$3,$4::"Role",now()) RETURNING {MEMBER_COLS}"#
    ))
    .bind(gen_id())
    .bind(&id)
    .bind(&target)
    .bind(&role)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| ApiError::bad("User is already a member"))?;

    // Nest's @Post default status.
    Ok((StatusCode::CREATED, Json(member_json(&row))))
}

// ---------------------------------------------------------------------------
// PATCH /api/workspaces/:id/members/:memberId
// ---------------------------------------------------------------------------

async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    reject_unknown(&body, &["role"])?;
    let role = parse_role(&body)?;
    assert_role(&state, &id, &user.id, "OWNER").await?;
    let m_user = load_member_in_workspace(&state, &id, &member_id).await?;

    // The workspace owner's own membership must stay OWNER, so a workspace can
    // never end up ownerless and one OWNER can't demote the real owner.
    // v1 uses `ws?.ownerId === m.userId`, i.e. a missing workspace row falls
    // through — the Option comparison below mirrors that.
    if workspace_owner(&state, &id).await?.as_deref() == Some(m_user.as_str()) && role != "OWNER" {
        return Err(ApiError::bad("Cannot change the workspace owner's role"));
    }

    // WorkspaceMember has no updatedAt column, so nothing else to touch.
    let row = sqlx::query(&format!(
        r#"UPDATE "WorkspaceMember" SET "role" = $1::"Role" WHERE "id" = $2
           RETURNING {MEMBER_COLS}"#
    ))
    .bind(&role)
    .bind(&member_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not Found"))?;
    Ok(Json(member_json(&row)))
}

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:id/members/:memberId
// ---------------------------------------------------------------------------

async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, member_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    assert_role(&state, &id, &user.id, "OWNER").await?;
    let m_user = load_member_in_workspace(&state, &id, &member_id).await?;

    // Same ownerless-workspace guard as update_member.
    if workspace_owner(&state, &id).await?.as_deref() == Some(m_user.as_str()) {
        return Err(ApiError::bad("Cannot remove the workspace owner"));
    }

    sqlx::query(r#"DELETE FROM "WorkspaceMember" WHERE "id" = $1"#)
        .bind(&member_id)
        .execute(&state.pool)
        .await?;
    // @HttpCode(204): empty body.
    Ok(StatusCode::NO_CONTENT)
}
