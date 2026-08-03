//! 2FA / TOTP — Rust port of v1's `/api/auth/2fa/*`
//! (`backend/src/auth/auth.{controller,service}.ts`: `startTotpEnrollment`,
//! `confirmTotp`, `disableTotp`) and of the `otplib` `authenticator` preset it
//! runs on.
//!
//! Wire contract (unchanged from v1, the frontend renders `message` verbatim):
//!   * `POST /api/auth/2fa/enable`  → **201** `{ otpauthUrl, qrDataUrl }`
//!   * `POST /api/auth/2fa/verify`  → **204**, body `{ code }`
//!   * `POST /api/auth/2fa/disable` → **204**, body `{ password, code }`
//!
//! ## Reproducing otplib exactly
//!
//! v1 calls `authenticator.{generateSecret,keyuri,check}` from otplib 12.0.1
//! with **no options overridden**, so the parameters below are otplib's
//! `authenticatorDefaultOptions()` — SHA1, 6 digits, 30s step and, importantly,
//! `window: 0`. A window of 0 means only the *current* 30s step is accepted:
//! no ±1 step grace. Widening it here would silently loosen a security control
//! relative to v1, so it stays 0.
//!
//! Two otplib quirks are reproduced deliberately:
//!   * `keyuri` emits `&period=&digits=&algorithm=&issuer=` in that exact order
//!     and uses the *issuer* as the label prefix (falling back to the account
//!     name when the issuer is empty).
//!   * `totpPadSecret` compares the length of the *hex string* against the
//!     digest's byte length (20 for SHA1), i.e. a secret shorter than 10 bytes
//!     gets its bytes repeated up to 20 bytes instead of being used as-is. v1's
//!     own secrets are always 10 bytes (so the branch is a no-op), but a secret
//!     imported by hand could hit it — see `hmac_key`.
//!
//! ## Secret storage
//!
//! The base32 secret is stored encrypted in `TotpSecret.secretCt` under purpose
//! `totp:{userId}`. `crypto::Crypto::decrypt` already accepts **both** the
//! legacy v1 blob (bare base64 `iv|tag|ct` encrypted directly under the master
//! key) and the `v2:local:{wrappedDek}:{payload}` envelope, so rows written by
//! either backend keep working; new rows are written in the v2 envelope, which
//! v1's `CryptoService` can also read.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::Engine;
use serde_json::{json, Map, Value};
use sqlx::Row;

use crate::{
    audit, ct_eq, gen_id, req_meta, verify_argon2, ApiError, ApiResult, AppState, AuthUser,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/2fa/enable", post(enable))
        .route("/api/auth/2fa/verify", post(verify))
        .route("/api/auth/2fa/disable", post(disable))
}

// ---------------------------------------------------------------------------
// otplib `authenticator` defaults
// ---------------------------------------------------------------------------

/// `step` — seconds per code.
const STEP_SECS: i64 = 30;
/// `digits`.
const DIGITS: u32 = 6;
/// `window: 0` — only the current step is accepted (see module docs).
const WINDOW: i64 = 0;
/// SHA1 digest length; otplib's `totpPadSecret` minimum for `HashAlgorithms.SHA1`.
const SHA1_KEY_LEN: usize = 20;
/// `generateSecret(numberOfBytes = 10)`.
const SECRET_BYTES: usize = 10;

/// v1: `TOTP_ISSUER: z.string().default('Dbdash')`. An explicitly empty value is
/// treated as absent — an empty issuer produces an `otpauth://totp/:email` URI
/// that no authenticator app renders sensibly.
fn totp_issuer() -> String {
    std::env::var("TOTP_ISSUER")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Dbdash".to_string())
}

/// AAD purpose for a user's TOTP secret — mirrors `crypto::Crypto::conn_purpose`
/// and v1's `` `totp:${userId}` ``.
fn totp_purpose(user_id: &str) -> String {
    format!("totp:{user_id}")
}

// ---------------------------------------------------------------------------
// TOTP core
// ---------------------------------------------------------------------------

/// `authenticator.generateSecret()` — 10 random bytes, base32 (RFC 4648,
/// uppercase, unpadded).
///
/// Note: otplib routes the bytes through `Buffer#toString('ascii')`, which
/// masks every byte to 7 bits and quietly costs 10 bits of entropy. Not
/// reproduced — it is a generation-side wart with no compatibility impact
/// (verification just decodes whatever base32 is stored).
fn generate_secret() -> String {
    use rand::RngCore;
    let mut b = [0u8; SECRET_BYTES];
    rand::rngs::OsRng.fill_bytes(&mut b);
    base32::encode(base32::Alphabet::Rfc4648 { padding: false }, &b)
}

/// `encodeURIComponent` — unreserved set is `A-Za-z0-9 -_.!~*'()`, everything
/// else percent-encoded from the UTF-8 bytes with uppercase hex.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let c = b as char;
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            out.push(c);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `authenticator.keyuri(accountName, issuer, secret)` — otplib's template is
/// `otpauth://totp/{labelPrefix}:{accountName}?secret={secret}{query}` where the
/// label prefix is the issuer (or the account name when there is no issuer) and
/// the query params are appended in the order period, digits, algorithm, issuer.
fn keyuri(account_name: &str, issuer: &str, secret: &str) -> String {
    let label_prefix = if issuer.is_empty() { account_name } else { issuer };
    let mut uri = format!(
        "otpauth://totp/{}:{}?secret={}",
        encode_uri_component(label_prefix),
        encode_uri_component(account_name),
        secret,
    );
    uri.push_str(&format!("&period={STEP_SECS}"));
    uri.push_str(&format!("&digits={DIGITS}"));
    uri.push_str("&algorithm=SHA1");
    if !issuer.is_empty() {
        uri.push_str(&format!("&issuer={}", encode_uri_component(issuer)));
    }
    uri
}

/// Decode a stored base32 secret to raw bytes. Tolerant of padding, lowercase
/// and stray whitespace so a hand-entered/legacy secret still resolves —
/// `thirty-two` (otplib's decoder) accepts the same shapes.
fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    let cleaned: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=' && *c != '-')
        .flat_map(|c| c.to_uppercase())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    base32::decode(base32::Alphabet::Rfc4648 { padding: false }, &cleaned).filter(|b| !b.is_empty())
}

/// otplib's `totpPadSecret(secret, 'hex', 20)`.
///
/// `currentLength` there is the length of the **hex string** (2 bytes/char),
/// compared against `minLength` = the digest byte length. For the 10-byte
/// secrets v1 mints, `20 >= 20` → the key is the raw bytes, i.e. plain RFC 6238.
/// Shorter secrets get their bytes repeated and truncated to 20 bytes.
fn hmac_key(raw: &[u8]) -> Vec<u8> {
    let hex_len = raw.len() * 2;
    if hex_len >= SHA1_KEY_LEN {
        return raw.to_vec();
    }
    let repeats = SHA1_KEY_LEN - hex_len;
    let mut out = Vec::with_capacity(raw.len() * repeats);
    for _ in 0..repeats {
        out.extend_from_slice(raw);
    }
    out.truncate(SHA1_KEY_LEN);
    out
}

/// RFC 4226 HOTP over HMAC-SHA1 with dynamic truncation, zero-padded to
/// `DIGITS`.
fn hotp(key: &[u8], counter: u64) -> Option<String> {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;

    let mut mac = Hmac::<Sha1>::new_from_slice(key).ok()?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32 & 0xff) << 16)
        | ((digest[offset + 2] as u32 & 0xff) << 8)
        | (digest[offset + 3] as u32 & 0xff);
    let token = binary % 10u32.pow(DIGITS);
    Some(format!("{token:0width$}", width = DIGITS as usize))
}

/// `authenticator.check(token, secret)`.
///
/// otplib rejects a non-numeric token outright (`/^(\d+)$/`) and then compares
/// the token string against the generated one, so a 7- or 8-digit code can
/// never match a 6-digit token — that is v1's behaviour, kept as-is.
fn check(code: &str, secret: &str) -> bool {
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let Some(raw) = decode_secret(secret) else {
        return false;
    };
    let key = hmac_key(&raw);

    // otplib: `totpCounter = Math.floor(epoch_ms / step / 1000)`.
    let counter = chrono::Utc::now().timestamp_millis() / (STEP_SECS * 1000);
    for delta in -WINDOW..=WINDOW {
        let c = counter + delta;
        if c < 0 {
            continue;
        }
        if let Some(expected) = hotp(&key, c as u64) {
            if ct_eq(code.as_bytes(), expected.as_bytes()) {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------

/// The enrolment QR as a `data:` URL, mirroring the `qrcode` npm defaults v1
/// gets from `QRCode.toDataURL(otpauth)`: error-correction level M, a 4-module
/// quiet zone and 4px per module.
///
/// v1 emits a PNG; this emits an SVG (`data:image/svg+xml;base64,...`) because
/// the `qrcode` crate is pulled in with `default-features = false`, which
/// compiles out both its `image` (PNG) and `svg` renderers — so the matrix is
/// rendered here directly. Both are `data:` URLs that drop straight into an
/// `<img src>`, and the payload/quiet zone/EC level are identical, so any
/// authenticator scans it the same. `otpauthUrl` is returned alongside for
/// manual entry either way.
fn qr_data_url(text: &str) -> ApiResult<String> {
    use qrcode::{Color, QrCode};

    const SCALE: usize = 4;
    const MARGIN: usize = 4;

    let code = QrCode::new(text.as_bytes())
        .map_err(|e| ApiError::internal(format!("Could not render the enrolment QR: {e}")))?;
    let width = code.width();
    let colors = code.to_colors();
    let side = (width + MARGIN * 2) * SCALE;

    // One path with a run-length rect per horizontal run of dark modules —
    // a fraction of the size of one <rect> per module.
    let mut path = String::new();
    for y in 0..width {
        let mut x = 0;
        while x < width {
            if colors[y * width + x] != Color::Dark {
                x += 1;
                continue;
            }
            let start = x;
            while x < width && colors[y * width + x] == Color::Dark {
                x += 1;
            }
            let run = (x - start) * SCALE;
            path.push_str(&format!(
                "M{} {}h{}v{}h-{}z",
                (MARGIN + start) * SCALE,
                (MARGIN + y) * SCALE,
                run,
                SCALE,
                run
            ));
        }
    }

    // `r##"…"##`: the SVG contains `"#ffffff"`, and `"#` would close an `r#"…"#`.
    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}" viewBox="0 0 {side} {side}" shape-rendering="crispEdges"><rect width="{side}" height="{side}" fill="#ffffff"/><path d="{path}" fill="#000000"/></svg>"##
    );
    Ok(format!(
        "data:image/svg+xml;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(svg)
    ))
}

// ---------------------------------------------------------------------------
// Shared helper for the login handler
// ---------------------------------------------------------------------------

/// Verify `code` against the user's **enabled** TOTP secret.
///
/// Returns `Ok(false)` for a wrong code, and `Ok(false)` when there is no
/// enabled enrolment at all (callers only reach this after the login query
/// already told them 2FA is on; a row that vanished in between must not become
/// a bypass). Errors are reserved for infrastructure failures — a missing
/// `ENCRYPTION_KEY` or an undecryptable blob — which v1 also surfaces as a 500
/// rather than as "invalid code".
pub async fn check_user_code(state: &AppState, user_id: &str, code: &str) -> ApiResult<bool> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let row = sqlx::query(r#"SELECT "secretCt", "enabled" FROM "TotpSecret" WHERE "userId" = $1"#)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };

    // No `.ok().flatten()` / `unwrap_or` on either column: a decode error here
    // must fail loudly, not degrade into "not enabled" (a 2FA bypass) or into
    // "wrong code".
    let enabled: bool = row
        .try_get("enabled")
        .map_err(|e| ApiError::internal(format!("TotpSecret.enabled: {e}")))?;
    if !enabled {
        return Ok(false);
    }
    let ct: String = row
        .try_get("secretCt")
        .map_err(|e| ApiError::internal(format!("TotpSecret.secretCt: {e}")))?;

    let secret = crypto
        .decrypt(&ct, &totp_purpose(user_id))
        .map_err(|e| ApiError::internal(format!("Could not read the stored TOTP secret: {e}")))?;
    Ok(check(code, &secret))
}

// ---------------------------------------------------------------------------
// Request-body validation (v1's global ValidationPipe + class-validator DTOs)
// ---------------------------------------------------------------------------

fn validation_error(msgs: Vec<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        message: msgs.join(", "),
        // v1's filter emits `code`; v2's envelope emits `error`. Send both.
        body: Some(json!({
            "statusCode": 400,
            "code": "Bad Request",
            "error": "Bad Request",
            "message": msgs,
        })),
    }
}

fn body_object(bytes: &Bytes) -> ApiResult<Map<String, Value>> {
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(Value::Null) => Ok(Map::new()),
        Ok(_) => Err(ApiError::bad("Request body must be a JSON object")),
        Err(e) => Err(ApiError::bad(format!("Invalid request body: {e}"))),
    }
}

/// `forbidNonWhitelisted: true` → "property X should not exist".
fn deny_unknown(m: &Map<String, Value>, allowed: &[&str], errs: &mut Vec<String>) {
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            errs.push(format!("property {k} should not exist"));
        }
    }
}

/// `@IsString() @Length(min, max)` with class-validator's exact messages.
fn v_str(m: &Map<String, Value>, field: &str, min: usize, max: usize, errs: &mut Vec<String>) -> Option<String> {
    match m.get(field).and_then(|v| v.as_str()) {
        Some(s) => {
            let n = s.chars().count();
            if n < min {
                errs.push(format!("{field} must be longer than or equal to {min} characters"));
            }
            if n > max {
                errs.push(format!("{field} must be shorter than or equal to {max} characters"));
            }
            Some(s.to_string())
        }
        None => {
            errs.push(format!("{field} must be a string"));
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/auth/2fa/enable` — v1 `startTotpEnrollment`. Nest's `@Post`
/// default status applies: **201**.
///
/// Re-enrolling overwrites any existing row and resets `enabled` to false, so a
/// half-finished enrolment can never leave 2FA on with an unknown secret.
async fn enable(State(state): State<AppState>, user: AuthUser) -> ApiResult<Response> {
    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let row = sqlx::query(r#"SELECT "email" FROM "User" WHERE "id" = $1"#)
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await?
        // v1 throws a bare `UnauthorizedException()` here — Nest renders it as
        // the generic message.
        .ok_or_else(|| ApiError::unauthorized("Unauthorized"))?;
    let email: String = row
        .try_get("email")
        .map_err(|e| ApiError::internal(format!("User.email: {e}")))?;

    let secret = generate_secret();
    let otpauth = keyuri(&email, &totp_issuer(), &secret);
    let ct = crypto
        .encrypt(&secret, &totp_purpose(&user.id))
        .map_err(|e| ApiError::internal(format!("Could not store the TOTP secret: {e}")))?;

    // Prisma's `upsert` on the `userId` unique. `updatedAt` has no DB default
    // (Prisma's `@updatedAt` is client-side), so it must be written explicitly.
    sqlx::query(
        r#"INSERT INTO "TotpSecret" ("id","userId","secretCt","enabled","createdAt","updatedAt")
           VALUES ($1,$2,$3,false,now(),now())
           ON CONFLICT ("userId") DO UPDATE
             SET "secretCt" = EXCLUDED."secretCt", "enabled" = false, "updatedAt" = now()"#,
    )
    .bind(gen_id())
    .bind(&user.id)
    .bind(&ct)
    .execute(&state.pool)
    .await?;

    let qr = qr_data_url(&otpauth)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "otpauthUrl": otpauth, "qrDataUrl": qr })),
    )
        .into_response())
}

/// `POST /api/auth/2fa/verify` — v1 `confirmTotp`. **204**.
async fn verify(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let m = body_object(&body)?;
    let mut errs: Vec<String> = Vec::new();
    deny_unknown(&m, &["code"], &mut errs);
    let code = v_str(&m, "code", 6, 8, &mut errs);
    if !errs.is_empty() {
        return Err(validation_error(errs));
    }
    let code = code.unwrap_or_default();
    let meta = req_meta(&headers);

    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let row = sqlx::query(r#"SELECT "secretCt" FROM "TotpSecret" WHERE "userId" = $1"#)
        .bind(&user.id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::bad("No pending TOTP enrollment"))?;
    let ct: String = row
        .try_get("secretCt")
        .map_err(|e| ApiError::internal(format!("TotpSecret.secretCt: {e}")))?;

    let secret = crypto
        .decrypt(&ct, &totp_purpose(&user.id))
        .map_err(|e| ApiError::internal(format!("Could not read the stored TOTP secret: {e}")))?;
    if !check(&code, &secret) {
        return Err(ApiError::unauthorized("Invalid TOTP code"));
    }

    // v1 doesn't gate on the current `enabled` value — confirming again is a
    // no-op re-enable of the same secret.
    sqlx::query(r#"UPDATE "TotpSecret" SET "enabled" = true, "updatedAt" = now() WHERE "userId" = $1"#)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;
    audit(&state, Some(&user.id), "TOTP_ENABLED", &meta, None).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/auth/2fa/disable` — v1 `disableTotp`. **204**.
///
/// Order matters and is v1's: not-enabled → no-password → wrong password →
/// wrong code.
async fn disable(
    State(state): State<AppState>,
    user: AuthUser,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let m = body_object(&body)?;
    let mut errs: Vec<String> = Vec::new();
    deny_unknown(&m, &["password", "code"], &mut errs);
    let password = v_str(&m, "password", 1, 128, &mut errs);
    let code = v_str(&m, "code", 6, 8, &mut errs);
    if !errs.is_empty() {
        return Err(validation_error(errs));
    }
    let (password, code) = (password.unwrap_or_default(), code.unwrap_or_default());
    let meta = req_meta(&headers);

    let crypto = state
        .crypto
        .as_ref()
        .ok_or_else(|| ApiError::internal("ENCRYPTION_KEY not configured"))?;

    let row = sqlx::query(
        r#"SELECT u."passwordHash", t."secretCt", COALESCE(t."enabled", false) AS "enabled"
           FROM "User" u
           LEFT JOIN "TotpSecret" t ON t."userId" = u."id"
           WHERE u."id" = $1 LIMIT 1"#,
    )
    .bind(&user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::bad("TOTP not enabled"))?;

    // Security columns: propagate decode errors instead of `.ok().flatten()`,
    // which would turn a type mistake into a silently skipped check.
    let enabled: bool = row
        .try_get("enabled")
        .map_err(|e| ApiError::internal(format!("TotpSecret.enabled: {e}")))?;
    if !enabled {
        return Err(ApiError::bad("TOTP not enabled"));
    }
    let hash: Option<String> = row
        .try_get("passwordHash")
        .map_err(|e| ApiError::internal(format!("User.passwordHash: {e}")))?;
    let Some(hash) = hash else {
        return Err(ApiError::bad("Account has no password (OAuth-only)"));
    };
    if verify_argon2(&password, &hash).is_err() {
        return Err(ApiError::unauthorized("Invalid password"));
    }

    let ct: Option<String> = row
        .try_get("secretCt")
        .map_err(|e| ApiError::internal(format!("TotpSecret.secretCt: {e}")))?;
    // `enabled` was true, so the row (and its ciphertext) exists.
    let ct = ct.ok_or_else(|| ApiError::bad("TOTP not enabled"))?;
    let secret = crypto
        .decrypt(&ct, &totp_purpose(&user.id))
        .map_err(|e| ApiError::internal(format!("Could not read the stored TOTP secret: {e}")))?;
    if !check(&code, &secret) {
        return Err(ApiError::unauthorized("Invalid TOTP code"));
    }

    sqlx::query(r#"DELETE FROM "TotpSecret" WHERE "userId" = $1"#)
        .bind(&user.id)
        .execute(&state.pool)
        .await?;
    audit(&state, Some(&user.id), "TOTP_DISABLED", &meta, None).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4226 test vector: ASCII secret "12345678901234567890" (20 bytes,
    /// so `hmac_key` passes it through untouched), counters 0..9.
    #[test]
    fn hotp_matches_rfc4226() {
        let key = b"12345678901234567890";
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ];
        for (counter, want) in expected.iter().enumerate() {
            assert_eq!(hotp(key, counter as u64).unwrap(), *want, "counter {counter}");
        }
    }

    #[test]
    fn keyuri_matches_otplib() {
        assert_eq!(
            keyuri("a+b@example.com", "Dbdash", "JBSWY3DPEHPK3PXP"),
            "otpauth://totp/Dbdash:a%2Bb%40example.com?secret=JBSWY3DPEHPK3PXP\
             &period=30&digits=6&algorithm=SHA1&issuer=Dbdash"
        );
    }

    #[test]
    fn generated_secret_round_trips() {
        let s = generate_secret();
        assert_eq!(s.len(), 16, "10 bytes → 16 unpadded base32 chars");
        assert_eq!(decode_secret(&s).unwrap().len(), SECRET_BYTES);
        // A freshly generated secret validates its own current code.
        let raw = decode_secret(&s).unwrap();
        let counter = chrono::Utc::now().timestamp_millis() / (STEP_SECS * 1000);
        let code = hotp(&hmac_key(&raw), counter as u64).unwrap();
        assert!(check(&code, &s));
        assert!(!check("000000000", &s));
        assert!(!check("abcdef", &s));
    }

    /// otplib pads *short* secrets by repeating their bytes to 20; 10-byte
    /// secrets (everything v1 mints) are used verbatim.
    #[test]
    fn hmac_key_reproduces_otplib_padding() {
        let ten = [1u8; 10];
        assert_eq!(hmac_key(&ten), ten.to_vec());
        let four = [0xAB, 0xCD, 0xEF, 0x01];
        let padded = hmac_key(&four);
        assert_eq!(padded.len(), 20);
        assert_eq!(&padded[0..4], &four);
        assert_eq!(&padded[16..20], &four);
    }
}
