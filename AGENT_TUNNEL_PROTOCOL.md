# DB Studio — Local Agent Tunnel Protocol (CONTRACT)

This is the shared contract between the **server** (NestJS backend) and the
**Go agent** (`agent.exe` running on the user's laptop). Both sides MUST implement
this exactly. Do not change field names or framing without updating both sides.

## Goal

A user's database is firewalled to only accept connections from the user's own
network/WiFi (not the server's IP). The agent runs on the user's laptop, connects
**outbound** to the server over secure WebSocket, and acts as a **raw TCP
byte-pipe**: the server asks the agent to open a TCP connection to `host:port`
(reachable from the laptop's network), and all bytes are tunneled both ways. The
server's existing DB drivers (pg/mysql/mssql/mongo) connect to a **local
forwarded port** and are completely unaware of the tunnel — same trick as the
existing SSH tunnel (`SshTunnelService`).

The agent is a **dumb byte-pipe**. It does NOT parse SQL or DB wire protocols.
This makes all TCP databases work automatically.

## Transport

- Agent connects to: `wss://database-api.mrwari.com/agent`  (socket.io namespace `/agent`)
  - (dev/local: `ws://localhost:<api-port>/agent`)
- Library: server uses socket.io (matches existing RealtimeGateway). The Go agent
  uses a socket.io client OR a plain WS client — **DECISION: use plain WebSocket
  with our own JSON+binary framing on a raw `@WebSocketGateway` path `/agent-ws`**,
  because socket.io Go clients are fragile. See "Framing" below. The gateway is a
  raw `ws` server mounted by Nest, NOT socket.io, to keep the Go side simple.

## Authentication & Pairing

1. User is logged into DB Studio (JWT). In the UI they click "Connect via local
   agent" on a connection. Server generates a short-lived **pairing token** (JWT,
   15 min TTL) bound to `{ userId, agentId }` and shows it (or a one-line command)
   to the user.
2. User runs `agent.exe` and pastes the pairing token (or passes `--token`).
3. Agent opens WSS to `/agent-ws?token=<pairingToken>`. Server verifies the JWT
   with `jwtAccessSecret`, extracts `{ userId, agentId }`, marks that agent
   **online**, and remembers the socket. One agent per `agentId`; a new
   connection replaces the old.
4. Agent then sends a `hello` frame with its machine info. Server replies `ready`.

Long-lived auth: after first pair, the agent stores a **refresh secret** (returned
in `ready`) in a local config file so it can reconnect without re-pairing.

## Framing

All control messages are JSON text frames. All tunneled DB bytes are binary
frames prefixed with an 8-byte header.

### Control frames (JSON text)

Server → Agent:
```json
{ "t": "ready",  "agentId": "...", "refreshSecret": "..." }
{ "t": "open",   "streamId": "s1", "host": "10.0.0.5", "port": 5432 }
{ "t": "close",  "streamId": "s1" }
{ "t": "ping" }
```

Agent → Server:
```json
{ "t": "hello",  "hostname": "Karwan-Laptop", "os": "windows", "version": "1.0.0" }
{ "t": "opened", "streamId": "s1" }
{ "t": "openerr","streamId": "s1", "error": "dial tcp: connection refused" }
{ "t": "close",  "streamId": "s1" }
{ "t": "pong" }
```

### Data frames (binary)

A data frame is a single WS **binary** message:
```
[ 4 bytes: streamId length N (uint32 BE) ]
[ N bytes: streamId (utf8 ascii, e.g. "s1") ]
[ remaining bytes: raw TCP payload ]
```
- Server → Agent binary frame: "write these bytes to the TCP socket for streamId".
- Agent → Server binary frame: "these bytes came back from the TCP socket".

This multiplexes many DB connections (streams) over one WebSocket. `streamId` is
assigned by the server, unique per open connection, freed on `close`.

## Stream lifecycle

1. Server needs a DB connection → picks a new `streamId` → sends `open{host,port}`.
2. Agent dials `host:port` (from the laptop's network). On success → `opened`;
   on failure → `openerr` (server rejects the DB connection attempt).
3. Bidirectional: every chunk read from the local forwarded socket → binary frame
   to agent → written to the TCP socket, and vice-versa.
4. Either side closes → send `close{streamId}` → other side tears down its socket.
5. If the WS drops, ALL streams for that agent are torn down; the local forwarded
   listeners are closed so the DB drivers get clean connection errors.

## Server-side integration (AgentTunnelService)

Mirror `SshTunnelService.open(ssh, remoteHost, remotePort) -> OpenTunnel`:

```ts
open(agentId: string, remoteHost: string, remotePort: number): Promise<OpenTunnel>
// returns { localHost: '127.0.0.1', localPort, close() }
```

- Creates a local `net.createServer()` on `127.0.0.1:0` (OS picks port).
- For each incoming loopback connection: allocate a `streamId`, send `open` to the
  agent's WS, wait for `opened`, then pipe: loopback socket bytes → binary frames
  to agent; binary frames from agent → loopback socket.
- If the agent is offline → the local listener refuses/errors so the driver fails
  fast with a clear "agent offline" message.

Then in `ConnectionsService.maybeOpenTunnel`, branch: if `connection.viaAgent`,
call `agentTunnel.open(connection.agentId, creds.host, creds.port)` and rewrite
`creds.host/port` to the returned local endpoint — EXACTLY like the ssh branch.
The four DB drivers stay unchanged.

## Data model additions (Prisma)

`Agent` model:
```
model Agent {
  id           String   @id @default(cuid())
  name         String                  // "Karwan office laptop"
  ownerId      String
  owner        User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  workspaceId  String?
  refreshHash  String?                 // hash of the agent's long-lived refresh secret
  lastSeenAt   DateTime?
  createdAt    DateTime @default(now())
  connections  Connection[]
}
```
On `Connection`:
```
viaAgent  Boolean  @default(false)
agentId   String?
agent     Agent?   @relation(fields: [agentId], references: [id])
```

## Security notes

- Pairing token: JWT, 15-min TTL, single-use-ish (bound to agentId).
- WS handshake verifies JWT with jwtAccessSecret (same as RealtimeGateway).
- The agent only opens TCP to whatever host:port the SERVER requests — which is
  the decrypted connection host/port for a connection the user owns. The agent
  never receives credentials; it just moves bytes. TLS/auth to the DB is
  end-to-end between the server's driver and the DB (over the pipe).
- Rate/size limits: cap concurrent streams per agent; drop oversized frames.

## Deliverables / ownership

- **A. Prisma + migration**: Agent model, Connection.viaAgent/agentId.
- **B. Backend AgentGateway (raw ws) + AgentTunnelService + registry**: the WS
  endpoint, online-agent registry, and the `open()` that mirrors SshTunnelService.
- **C. Backend wiring**: branch in maybeOpenTunnel; agent CRUD + pairing-token
  controller; module registration.
- **D. Go agent**: WSS client, pairing/config persistence, stream dial+pipe,
  reconnect; cross-compiled to `agent.exe`.
- **E. Frontend**: "Connect via local agent" toggle on the connection form, agent
  list/create, pairing token display + download-agent link.
