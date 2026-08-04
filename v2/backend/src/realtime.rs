//! Realtime table updates — the `/realtime` socket.io namespace.
//!
//! The frontend speaks socket.io (`io(`${origin}/realtime`)`), so this serves
//! the real protocol rather than a plain WebSocket. Contract reproduced from
//! v1's `realtime.gateway.ts`:
//!
//!   1. connect with `auth: { token }` (or an `Authorization: Bearer` header)
//!   2. emit `subscribe` { connectionId, schema, table }  → ack `{ok}` / `{ok:false,error}`
//!   3. receive `change` { schema, table, payload }
//!
//! v1 has three change-detection modes and falls back down the list: logical
//! replication (best), LISTEN/NOTIFY (needs a user-installed trigger), then 5s
//! COUNT(*) polling. This implements the polling mode — the one v1 always ends
//! up on for a table with no trigger and no `wal_level=logical` — so the
//! observable payload matches v1's fallback exactly. Logical replication is a
//! follow-up; it needs the streaming replication protocol, which sqlx has no
//! support for.
//!
//! SECURITY: subscribing re-checks the caller's role on the connection, so a
//! socket cannot watch a table the user has no access to. The polling payload
//! carries only a row COUNT — never row values — so it cannot leak masked
//! columns. Any future mode that streams real row images MUST apply this
//! subscriber's column masks first, exactly as v1 does with `maskDeep`.

use crate::AppState;
use serde::Deserialize;
use socketioxide::extract::{AckSender, Data, SocketRef};
use socketioxide::SocketIo;
use std::time::Duration;

#[derive(Deserialize)]
struct SubscribeBody {
    #[serde(rename = "connectionId")]
    connection_id: String,
    schema: String,
    table: String,
}

/// Identifier guard — the table name is interpolated into the COUNT query, so
/// anything that is not a plain identifier is refused rather than quoted-and-hoped.
fn ident_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 63
        && s.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Builds the socket.io layer plus the `/realtime` namespace.
pub fn layer(state: AppState) -> socketioxide::layer::SocketIoLayer {
    let (sio_layer, io) = SocketIo::new_layer();

    // State is captured by clone rather than pulled from an extractor — the
    // socketioxide state API differs across versions and this is version-proof.
    let ns_state = state.clone();
    io.ns("/realtime", move |socket: SocketRef| {
        let state = ns_state.clone();
        // Handshake auth. v1 accepts `auth.token` or the Authorization header
        // and disconnects when neither yields a valid JWT.
        let token = socket
            .req_parts()
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|s| s.to_string())
            .or_else(|| {
                socket
                    .req_parts()
                    .uri
                    .query()
                    .and_then(|q| {
                        q.split('&').find_map(|kv| kv.strip_prefix("token=").map(|t| t.to_string()))
                    })
            });

        let user_id = token
            .as_deref()
            .and_then(|t| crate::jwt_decode(t, &state.jwt_secret).ok())
            .map(|c| c.sub);

        let Some(user_id) = user_id else {
            tracing::warn!("realtime: WS auth failed — disconnecting");
            let _ = socket.disconnect();
            return;
        };

        let sub_state = state.clone();
        socket.on(
            "subscribe",
            move |socket: SocketRef, Data::<SubscribeBody>(body), ack: AckSender| {
                let user_id = user_id.clone();
                let state = sub_state.clone();
                async move {
                    if !ident_ok(&body.schema) || !ident_ok(&body.table) {
                        ack.send(&serde_json::json!({ "ok": false, "error": "bad_identifier" })).ok();
                        return;
                    }
                    // Same access rule as the grid: any effective role may watch.
                    match crate::conn_role(&state.pool, &body.connection_id, &user_id).await {
                        Ok(Some(_)) => {}
                        Ok(None) => {
                            ack.send(&serde_json::json!({ "ok": false, "error": "forbidden" })).ok();
                            return;
                        }
                        Err(_) => {
                            ack.send(&serde_json::json!({ "ok": false, "error": "not_found" })).ok();
                            return;
                        }
                    }
                    ack.send(&serde_json::json!({ "ok": true })).ok();

                    // 5s COUNT(*) poll; emit only on change, like v1.
                    let (cid, schema, table) = (body.connection_id.clone(), body.schema.clone(), body.table.clone());
                    let sock = socket.clone();
                    tokio::spawn(async move {
                        let mut last: i64 = -1;
                        loop {
                            tokio::time::sleep(Duration::from_secs(5)).await;
                            if !sock.connected() {
                                break;
                            }
                            let Ok(mut conn) = crate::connect_target(&state, &cid, &user_id).await else {
                                continue;
                            };
                            let sql = format!(
                                r#"SELECT count(*)::bigint FROM "{}"."{}""#,
                                schema.replace('"', ""),
                                table.replace('"', "")
                            );
                            if let Ok(c) = sqlx::query_scalar::<_, i64>(&sql).fetch_one(&mut conn).await {
                                if c != last {
                                    last = c;
                                    let _ = sock.emit(
                                        "change",
                                        &serde_json::json!({
                                            "schema": schema,
                                            "table": table,
                                            "payload": { "rowCount": c }
                                        }),
                                    );
                                }
                            }
                        }
                    });
                }
            },
        );
    });

    sio_layer
}
