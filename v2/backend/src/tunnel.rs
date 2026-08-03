//! Local-agent WebSocket tunnel — Rust port of v1's `backend/src/agent-tunnel/`
//! (`agent.gateway.ts`, `agent-registry.service.ts`, `agent-tunnel.service.ts`).
//!
//! # Why this exists
//!
//! A `viaAgent` connection points at a database that is only reachable from the
//! *user's* network. A paired `agent.exe` (Go, `agent/internal/tunnel/client.go`)
//! dials out to us over WSS and acts as a dumb raw-TCP byte pipe: we ask it to
//! open a TCP stream to `host:port`, and every byte is multiplexed over that one
//! socket. While the tunnel lived only in Node, `agent_guard` had to forward every
//! agent-backed request to v1 — this module is what removes that constraint.
//!
//! # Wire protocol (CONTRACT — `AGENT_TUNNEL_PROTOCOL.md`)
//!
//! **Deployed agents are already built against this and will NOT be updated**, so
//! every byte below is copied from the v1 gateway + the Go client, not invented.
//!
//! * Endpoint: `GET /agent-ws?token=<jwt>`, plain WebSocket (NOT socket.io).
//! * Auth: HS256 JWT signed with the access secret, carrying `{ sub, agentId }`
//!   (`kind` is `agent-pairing` on first pair, `agent-refresh` on reconnect — v1
//!   does not inspect `kind`, so neither do we). The `Agent` row must still exist
//!   and still be owned by `sub`, else the socket is closed with **4401**. The Go
//!   client special-cases close code 4401 to mean "re-pair through the browser",
//!   so authentication failures must be a *close frame after upgrade*, never an
//!   HTTP 401 — an HTTP failure would trap the agent in a reconnect loop.
//! * Control frames are **JSON text**:
//!   - server → agent: `{"t":"ready","agentId":..,"refreshSecret":..}`,
//!     `{"t":"open","streamId":"s1","host":..,"port":..}`,
//!     `{"t":"close","streamId":"s1"}`, `{"t":"pong"}`
//!   - agent → server: `{"t":"hello","hostname":..,"os":..,"version":..}`,
//!     `{"t":"opened","streamId":..}`, `{"t":"openerr","streamId":..,"error":..}`,
//!     `{"t":"close","streamId":..}`, `{"t":"ping"}`
//! * Data frames are **binary**: `[u32 BE streamId length N][N bytes streamId
//!   (utf8)][raw TCP payload]`, both directions.
//! * Keepalive: the server WS-pings every 30s and terminates a socket that missed
//!   the previous pong. The agent additionally sends `{"t":"ping"}` every 30s and
//!   **requires a `{"t":"pong"}` text frame back** — gorilla only refreshes its
//!   90s read deadline on a *data* message, so a silent server (WS pings alone)
//!   would be dropped by every agent after 90 seconds.
//! * `streamId` is server-assigned, `s1`, `s2`, … per WebSocket session.
//! * Open timeout 15s, 256 concurrent streams per agent, inbound binary frames
//!   over 8 MiB are dropped.
//!
//! # Public surface
//!
//! * [`routes`] — the `/agent-ws` upgrade endpoint.
//! * [`open_stream`] — a raw `AsyncRead + AsyncWrite` byte stream to
//!   `host:port` through a given agent.
//! * [`open_tunnel`] — v1's `AgentTunnelService.open()`: a loopback listener whose
//!   every accepted socket is bridged to a fresh agent stream, so a driver that
//!   can only speak `host:port` (sqlx included) connects to `127.0.0.1:<port>`
//!   and is unaware a tunnel exists.
//! * [`is_online`] / [`online_agents`] — the registry view v1 exposes to
//!   `AgentsService.view()` as the `online` flag.

// The stream/tunnel API is complete but not yet wired into `connect_target`
// (that switch also needs nginx to route /agent-ws here — see the module docs in
// the port notes), so parts of it are legitimately unreferenced for now.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::Response,
    routing::get,
    Router,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

use crate::{jwt_decode, ApiError, ApiResult, AppState};

// ---------------------------------------------------------------------------
// Protocol constants — every one of these mirrors a literal in v1 or the Go agent
// ---------------------------------------------------------------------------

/// `agent.gateway.ts` KEEPALIVE_INTERVAL_MS.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
/// `agent-registry.service.ts` MAX_STREAMS_PER_AGENT (the Go agent enforces the
/// same 256 and answers `openerr: too many streams` past it).
const MAX_STREAMS_PER_AGENT: usize = 256;
/// `agent-registry.service.ts` MAX_FRAME_BYTES.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// `AgentConnection.openStream`'s 15_000 ms open timer.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// `agent.gateway.ts` REFRESH_TTL = '365d'.
const REFRESH_TTL_SECS: i64 = 365 * 86_400;
/// The close code the Go client maps to "credentials rejected, re-pair".
const CLOSE_UNAUTHORIZED: u16 = 4401;

// ---------------------------------------------------------------------------
// Registry — v1's `AgentRegistry`, an in-process map of live agent sockets
// ---------------------------------------------------------------------------

type Registry = Mutex<HashMap<String, Arc<AgentConn>>>;

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Machine info from the agent's `hello` frame (v1 `AgentMeta`).
#[derive(Clone, Debug, Default)]
pub struct AgentMeta {
    pub user_id: String,
    pub hostname: Option<String>,
    pub os: Option<String>,
    pub version: Option<String>,
}

/// Is this agent currently holding a live `/agent-ws` socket **on this process**?
///
/// NOTE: like v1's registry this is per-process, not cluster-wide. An agent is
/// only visible to whichever backend it dialed, so `/agent-ws` must be routed to
/// exactly one of v1/v2 — never both.
pub fn is_online(agent_id: &str) -> bool {
    registry().lock().map(|r| r.contains_key(agent_id)).unwrap_or(false)
}

/// Ids of every agent currently connected to this process.
pub fn online_agents() -> Vec<String> {
    registry()
        .lock()
        .map(|r| r.keys().cloned().collect())
        .unwrap_or_default()
}

fn get_conn(agent_id: &str) -> Option<Arc<AgentConn>> {
    registry().lock().ok()?.get(agent_id).cloned()
}

// ---------------------------------------------------------------------------
// AgentConn — v1's `AgentConnection`: one WebSocket, many multiplexed streams
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ConnInner {
    torn: bool,
    /// streamId -> sink for bytes arriving FROM the agent.
    streams: HashMap<String, mpsc::UnboundedSender<Vec<u8>>>,
    /// streamId -> waiter for the `opened`/`openerr` ack (v1's `PendingOpen`).
    pending: HashMap<String, oneshot::Sender<Result<(), String>>>,
}

pub struct AgentConn {
    pub agent_id: String,
    pub meta: AgentMeta,
    /// Everything written to the socket goes through this channel; the session
    /// task is the single writer (mirrors the Go side's single-writer rule and
    /// keeps `AgentStream` writes lock-free from any task).
    out: mpsc::UnboundedSender<Message>,
    seq: AtomicU64,
    inner: Mutex<ConnInner>,
}

impl AgentConn {
    fn send_control(&self, msg: Value) -> bool {
        self.out.send(Message::Text(msg.to_string())).is_ok()
    }

    /// `[u32 BE idLen][idBytes][payload]` — v1 `sendData`, Go `encodeDataFrame`.
    fn send_data(&self, stream_id: &str, payload: &[u8]) -> bool {
        let id = stream_id.as_bytes();
        let mut frame = Vec::with_capacity(4 + id.len() + payload.len());
        frame.extend_from_slice(&(id.len() as u32).to_be_bytes());
        frame.extend_from_slice(id);
        frame.extend_from_slice(payload);
        self.out.send(Message::Binary(frame)).is_ok()
    }

    /// Ask the agent to dial `host:port`; resolves once it answers `opened`.
    /// v1 `AgentConnection.openStream`.
    async fn open_stream(self: &Arc<Self>, host: &str, port: u16) -> ApiResult<AgentStream> {
        let (ack_tx, ack_rx) = oneshot::channel::<Result<(), String>>();
        let (data_tx, data_rx) = mpsc::unbounded_channel::<Vec<u8>>();

        let stream_id = {
            let mut inner = self.lock();
            if inner.torn {
                return Err(unavailable("agent connection closed"));
            }
            if inner.streams.len() >= MAX_STREAMS_PER_AGENT {
                return Err(unavailable("agent stream limit reached"));
            }
            let id = format!("s{}", self.seq.fetch_add(1, Ordering::Relaxed) + 1);
            inner.streams.insert(id.clone(), data_tx);
            inner.pending.insert(id.clone(), ack_tx);
            id
        };

        if !self.send_control(json!({ "t": "open", "streamId": stream_id, "host": host, "port": port })) {
            self.forget(&stream_id);
            return Err(unavailable("agent connection closed"));
        }

        match tokio::time::timeout(OPEN_TIMEOUT, ack_rx).await {
            // `opened`
            Ok(Ok(Ok(()))) => Ok(AgentStream::new(self.clone(), stream_id, data_rx)),
            // `openerr` — the control handler already dropped both entries.
            Ok(Ok(Err(err))) => Err(unavailable(err)),
            // Sender dropped: the socket died (teardown) while we waited.
            Ok(Err(_)) => {
                self.forget(&stream_id);
                Err(unavailable("agent disconnected"))
            }
            Err(_) => {
                self.forget(&stream_id);
                // DELIBERATE (and only) deviation from v1: v1 drops a timed-out
                // open on the floor, so if the agent's `opened` merely arrived
                // late it keeps a TCP socket to the database open forever with
                // nobody on this end. Telling it to close costs one control
                // frame and is safe for an id the agent never opened — the Go
                // client's `handleServerClose` is a no-op for unknown streams.
                self.send_control(json!({ "t": "close", "streamId": stream_id }));
                Err(unavailable(format!("agent open timed out for {host}:{port}")))
            }
        }
    }

    /// Route a JSON control frame from the agent (v1 `handleControl`).
    fn handle_control(&self, msg: &Value) {
        let t = msg.get("t").and_then(Value::as_str).unwrap_or_default();
        let stream_id = msg.get("streamId").and_then(Value::as_str).unwrap_or_default().to_string();
        match t {
            "opened" => {
                let mut inner = self.lock();
                // v1 requires BOTH the pending waiter and the stream slot.
                if !inner.streams.contains_key(&stream_id) {
                    return;
                }
                if let Some(pend) = inner.pending.remove(&stream_id) {
                    drop(inner);
                    let _ = pend.send(Ok(()));
                }
            }
            "openerr" => {
                let mut inner = self.lock();
                let Some(pend) = inner.pending.remove(&stream_id) else {
                    return;
                };
                inner.streams.remove(&stream_id);
                drop(inner);
                let err = msg
                    .get("error")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("agent failed to open stream")
                    .to_string();
                let _ = pend.send(Err(err));
            }
            // The agent's TCP socket ended: drop our sender so the consumer's
            // reader sees EOF (v1 `finalizeStream` -> `onClose`).
            "close" => {
                self.lock().streams.remove(&stream_id);
            }
            // hello/ping/pong are handled by the session loop, not here.
            _ => {}
        }
    }

    /// Route an inbound binary data frame (v1 `handleBinary`).
    fn handle_binary(&self, frame: &[u8]) {
        if frame.len() > MAX_FRAME_BYTES {
            tracing::warn!(
                "agent {}: dropping oversized frame ({} bytes)",
                self.agent_id,
                frame.len()
            );
            return;
        }
        if frame.len() < 4 {
            return;
        }
        let id_len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        if id_len == 0 || frame.len() < 4 + id_len {
            return;
        }
        let stream_id = String::from_utf8_lossy(&frame[4..4 + id_len]).into_owned();
        let payload = &frame[4 + id_len..];
        let tx = { self.lock().streams.get(&stream_id).cloned() };
        if let Some(tx) = tx {
            let _ = tx.send(payload.to_vec());
        }
    }

    /// Tear every stream down — called when the WS drops (v1 `teardown`).
    fn teardown(&self) {
        let (pending, streams) = {
            let mut inner = self.lock();
            if inner.torn {
                return;
            }
            inner.torn = true;
            (
                std::mem::take(&mut inner.pending),
                std::mem::take(&mut inner.streams),
            )
        };
        for (_, pend) in pending {
            let _ = pend.send(Err("agent disconnected".into()));
        }
        // Dropping every data sender makes each live `AgentStream` read EOF.
        drop(streams);
    }

    fn forget(&self, stream_id: &str) {
        let mut inner = self.lock();
        inner.pending.remove(stream_id);
        inner.streams.remove(stream_id);
    }

    /// A poisoned registry mutex must not take the tunnel down — recover the
    /// guard instead (nothing here can leave the map in an invalid state).
    fn lock(&self) -> std::sync::MutexGuard<'_, ConnInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn unavailable(msg: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, msg)
}

// ---------------------------------------------------------------------------
// AgentStream — one tunneled TCP connection as a plain byte stream
// ---------------------------------------------------------------------------

/// A live tunnel stream. Reads yield bytes the agent read from the target DB;
/// writes are forwarded to the agent's TCP socket. Implements `AsyncRead +
/// AsyncWrite` so it can be handed to `copy_bidirectional` (or any future
/// driver that accepts a socket).
///
/// Dropping it sends `{"t":"close"}` to the agent, exactly like v1's
/// `AgentStream.close()`.
pub struct AgentStream {
    conn: Arc<AgentConn>,
    stream_id: String,
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    /// Partially-consumed chunk (a read buffer smaller than the frame).
    chunk: Vec<u8>,
    pos: usize,
    eof: bool,
    closed: bool,
}

impl AgentStream {
    fn new(conn: Arc<AgentConn>, stream_id: String, rx: mpsc::UnboundedReceiver<Vec<u8>>) -> Self {
        Self { conn, stream_id, rx, chunk: Vec::new(), pos: 0, eof: false, closed: false }
    }

    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    /// Tell the agent to drop its TCP socket for this stream. Idempotent.
    ///
    /// The `close` frame is only sent if the stream was still registered: when
    /// the agent closed first its slot is already gone, and v1 likewise skips
    /// the notification in that case.
    fn close_now(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let still_open = self.conn.lock().streams.remove(&self.stream_id).is_some();
        if still_open {
            self.conn
                .send_control(json!({ "t": "close", "streamId": self.stream_id }));
        }
    }
}

impl Drop for AgentStream {
    fn drop(&mut self) {
        self.close_now();
    }
}

impl AsyncRead for AgentStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.pos < this.chunk.len() {
                let n = std::cmp::min(buf.remaining(), this.chunk.len() - this.pos);
                if n == 0 {
                    return Poll::Ready(Ok(()));
                }
                buf.put_slice(&this.chunk[this.pos..this.pos + n]);
                this.pos += n;
                if this.pos >= this.chunk.len() {
                    this.chunk.clear();
                    this.pos = 0;
                }
                return Poll::Ready(Ok(()));
            }
            if this.eof {
                // 0 bytes filled = clean EOF.
                return Poll::Ready(Ok(()));
            }
            match this.rx.poll_recv(cx) {
                Poll::Ready(Some(chunk)) => {
                    if chunk.is_empty() {
                        continue;
                    }
                    this.chunk = chunk;
                    this.pos = 0;
                }
                Poll::Ready(None) => {
                    this.eof = true;
                    return Poll::Ready(Ok(()));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl AsyncWrite for AgentStream {
    fn poll_write(self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.closed {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "agent stream closed")));
        }
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if !this.conn.send_data(&this.stream_id, buf) {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "agent connection closed",
            )));
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.get_mut().close_now();
        Poll::Ready(Ok(()))
    }
}

// ---------------------------------------------------------------------------
// Public stream-open API
// ---------------------------------------------------------------------------

/// v1's "agent offline" `ServiceUnavailableException`, word for word — the UI
/// shows this string verbatim.
fn offline_error(remote_host: &str, remote_port: u16) -> ApiError {
    unavailable(format!(
        "Local agent is offline. Start the agent (agent.exe) on the machine that can reach \
         {remote_host}:{remote_port}, then retry."
    ))
}

/// Open a raw byte stream to `host:port` through `agent_id`.
///
/// This is the primitive the rest of the crate builds on. Anything that can be
/// handed an `AsyncRead + AsyncWrite` should use this directly; anything that
/// insists on a TCP address (sqlx's `PgConnectOptions`, `pg_dump`, …) should use
/// [`open_tunnel`] instead.
pub async fn open_stream(agent_id: &str, host: &str, port: u16) -> ApiResult<AgentStream> {
    let conn = get_conn(agent_id).ok_or_else(|| offline_error(host, port))?;
    conn.open_stream(host, port).await
}

/// A loopback listener that forwards to a target database through an agent.
/// Mirrors v1's `OpenTunnel` (`{ localHost, localPort, close() }`).
///
/// Dropping it stops the listener; in-flight bridges finish on their own.
pub struct OpenTunnel {
    pub local_host: String,
    pub local_port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl OpenTunnel {
    /// v1's `close()`. Dropping does the same thing; this exists so call sites
    /// can read like the Node ones.
    pub fn close(self) {
        drop(self);
    }
}

impl Drop for OpenTunnel {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// v1 `AgentTunnelService.open(agentId, remoteHost, remotePort)`.
///
/// Binds `127.0.0.1:0`, and bridges every accepted socket to a freshly opened
/// agent stream. The caller rewrites the connection's host/port to the returned
/// endpoint and dials it with an ordinary driver.
pub async fn open_tunnel(agent_id: &str, remote_host: &str, remote_port: u16) -> ApiResult<OpenTunnel> {
    // Fail fast and clearly when the agent isn't paired/online, so the driver
    // surfaces a real message instead of a generic connect timeout.
    if !is_online(agent_id) {
        return Err(offline_error(remote_host, remote_port));
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| ApiError::internal(format!("agent tunnel listen failed: {e}")))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| ApiError::internal(format!("agent tunnel addr failed: {e}")))?
        .port();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let agent_id = agent_id.to_string();
    let host = remote_host.to_string();

    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => match accepted {
                    Ok((sock, _)) => {
                        tokio::spawn(bridge(agent_id.clone(), host.clone(), remote_port, sock));
                    }
                    Err(e) => {
                        tracing::warn!("agent tunnel accept failed: {e}");
                        break;
                    }
                },
            }
        }
    });

    Ok(OpenTunnel {
        local_host: "127.0.0.1".to_string(),
        local_port,
        shutdown: Some(shutdown_tx),
    })
}

/// Wire one loopback socket to a freshly-opened agent stream, both ways.
async fn bridge(agent_id: String, host: String, port: u16, mut sock: TcpStream) {
    let mut stream = match open_stream(&agent_id, &host, port).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("agent openStream failed for {host}:{port}: {}", e.message);
            return; // dropping `sock` gives the driver a clean connection error
        }
    };
    // Errors here are expected (DB unreachable from the agent's network, driver
    // hangs up); both sides are torn down by the drops below either way.
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    // Dropping `stream` sends `{"t":"close"}` to the agent.
}

// ---------------------------------------------------------------------------
// The `/agent-ws` endpoint
// ---------------------------------------------------------------------------

pub fn routes() -> axum::Router<crate::AppState> {
    Router::new().route("/agent-ws", get(agent_ws))
}

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: Option<String>,
}

/// The upgrade always succeeds; authentication failures are reported as a
/// **close frame with code 4401** on the upgraded socket, because that is what
/// the deployed Go agent detects (`IsUnauthorized`) to trigger a browser
/// re-pair. Rejecting with HTTP 401 here would silently break that self-heal.
async fn agent_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(q): Query<TokenQuery>,
) -> Response {
    ws.on_upgrade(move |socket| session(socket, state, q.token))
}

/// Verify the pairing/refresh JWT and pull `{ sub, agentId }` out of it.
///
/// `jwt_decode` does the security-relevant work (HS256 signature over the same
/// secret v1 signs with, plus `exp`); `agentId` is read straight from the
/// already-verified payload since the crate-root `Claims` struct doesn't model
/// it. v1 does not check `kind`, so a pairing token and a refresh token both
/// authenticate through this one path.
fn agent_claims(token: &str, secret: &str) -> Option<(String, String)> {
    let claims = jwt_decode(token, secret).ok()?;
    if claims.sub.is_empty() {
        return None;
    }
    let payload = token.split('.').nth(1)?;
    let raw = B64.decode(payload).ok()?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    let agent_id = v
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    Some((claims.sub, agent_id.to_string()))
}

async fn reject(mut socket: WebSocket) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: CLOSE_UNAUTHORIZED,
            reason: "unauthorized".into(),
        })))
        .await;
}

/// Long-lived reconnect credential returned in `ready`. Signed with the SAME
/// secret the handshake verifies and carrying `{ sub, agentId, kind }`, so a
/// reconnect re-authenticates through `agent_claims` above. Re-minted on every
/// `ready` so the 365-day clock keeps sliding forward.
fn mint_refresh(state: &AppState, agent_id: &str, user_id: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = json!({
        "sub": user_id,
        "agentId": agent_id,
        "kind": "agent-refresh",
        "iat": now,
        "exp": now + REFRESH_TTL_SECS,
    });
    let header = B64.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = B64.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let signing_input = format!("{header}.{payload}");
    let sig = crate::jwt_sign(&signing_input, &state.jwt_secret);
    format!("{signing_input}.{sig}")
}

/// v1 `onHello` + `AgentRegistry.register`: one connection per agentId, a new
/// one replaces (and tears down) any prior one.
fn register(
    state: &AppState,
    agent_id: &str,
    user_id: &str,
    hello: &Value,
    out: mpsc::UnboundedSender<Message>,
) -> Arc<AgentConn> {
    let field = |k: &str| hello.get(k).and_then(Value::as_str).map(str::to_string);
    let conn = Arc::new(AgentConn {
        agent_id: agent_id.to_string(),
        meta: AgentMeta {
            user_id: user_id.to_string(),
            hostname: field("hostname"),
            os: field("os"),
            version: field("version"),
        },
        out: out.clone(),
        seq: AtomicU64::new(0),
        inner: Mutex::new(ConnInner::default()),
    });

    let (previous, total) = {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        let prev = reg.insert(agent_id.to_string(), conn.clone());
        let total = reg.len();
        (prev, total)
    };
    if let Some(prev) = previous {
        tracing::info!("replacing existing connection for agent {agent_id}");
        prev.teardown();
    }

    let _ = out.send(Message::Text(
        json!({
            "t": "ready",
            "agentId": agent_id,
            "refreshSecret": mint_refresh(state, agent_id, user_id),
        })
        .to_string(),
    ));

    tracing::info!(
        "agent {agent_id} ready (host={} os={}) — {total} online",
        conn.meta.hostname.as_deref().unwrap_or("?"),
        conn.meta.os.as_deref().unwrap_or("?"),
    );
    conn
}

/// v1 `AgentRegistry.deregister`: only evict when the tracked connection is
/// still this one, so a late-closing old socket can't evict its replacement.
fn deregister(agent_id: &str, conn: &Arc<AgentConn>) {
    let evicted = {
        let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
        let is_current = reg.get(agent_id).map(|cur| Arc::ptr_eq(cur, conn)).unwrap_or(false);
        if is_current {
            reg.remove(agent_id);
            true
        } else {
            false
        }
    };
    if evicted {
        conn.teardown();
        tracing::info!("agent {agent_id} offline");
    }
}

async fn session(mut socket: WebSocket, state: AppState, token: Option<String>) {
    // 1) Authenticate off the query-string pairing/refresh token.
    let Some((user_id, agent_id)) = token
        .as_deref()
        .and_then(|t| agent_claims(t, &state.jwt_secret))
    else {
        tracing::warn!("agent WS auth failed: missing or invalid token");
        reject(socket).await;
        return;
    };

    // 2) SECURITY: the refresh credential is valid for a year, so the JWT alone
    // is not enough — confirm the agent still exists and still belongs to the
    // user named in the token. Without this, deleting an Agent row would not
    // actually close the tunnel and a leaked token would stay usable for 365d.
    let owner: Option<String> =
        match sqlx::query_scalar(r#"SELECT "ownerId" FROM "Agent" WHERE "id" = $1"#)
            .bind(&agent_id)
            .fetch_optional(&state.pool)
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("agent WS revocation check failed: {e}");
                reject(socket).await;
                return;
            }
        };
    if owner.as_deref() != Some(user_id.as_str()) {
        tracing::warn!("agent WS rejected: agent {agent_id} revoked or reassigned");
        reject(socket).await;
        return;
    }

    // 3) Serve. One task owns the socket: it reads frames and drains the
    // outbound queue that `AgentStream`/`register` write into.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let mut conn: Option<Arc<AgentConn>> = None;
    // v1's keepalive sweep: a socket that didn't answer the previous ping is dead.
    let mut alive = true;
    let mut ticker = tokio::time::interval(KEEPALIVE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick is immediate — consume it

    loop {
        tokio::select! {
            Some(msg) = out_rx.recv() => {
                if socket.send(msg).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    // Binary frames are tunnel data.
                    Message::Binary(bytes) => {
                        // Data before `hello`/registration — ignore, as v1 does.
                        if let Some(c) = conn.as_ref() {
                            c.handle_binary(&bytes);
                        }
                    }
                    Message::Text(text) => {
                        let Ok(v) = serde_json::from_str::<Value>(&text) else {
                            tracing::debug!("agent {agent_id} sent malformed JSON frame");
                            continue;
                        };
                        match v.get("t").and_then(Value::as_str).unwrap_or_default() {
                            "hello" => {
                                // Duplicate hellos are ignored (v1 `onHello`).
                                if conn.is_none() {
                                    conn = Some(register(&state, &agent_id, &user_id, &v, out_tx.clone()));
                                }
                            }
                            // REQUIRED: gorilla only refreshes its 90s read
                            // deadline on a data frame, so this text pong is what
                            // keeps an idle agent connected.
                            "ping" => {
                                let _ = out_tx.send(Message::Text(json!({ "t": "pong" }).to_string()));
                            }
                            "pong" => alive = true,
                            // opened/openerr/close belong to the stream machinery.
                            _ => {
                                if let Some(c) = conn.as_ref() {
                                    c.handle_control(&v);
                                }
                            }
                        }
                    }
                    Message::Pong(_) => alive = true,
                    // tungstenite answers WS pings for us.
                    Message::Ping(_) => {}
                    Message::Close(_) => break,
                }
            }
            _ = ticker.tick() => {
                if !alive {
                    tracing::warn!("agent {agent_id} missed keepalive — terminating socket");
                    break;
                }
                alive = false;
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
        }
    }

    if let Some(c) = conn {
        deregister(&agent_id, &c);
    }
}
