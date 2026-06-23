/**
 * Query Schema network agent (agent mode of the same backend image).
 *
 * Run this INSIDE your network (where the database's IP allowlist permits) with:
 *   AGENT_RELAY_URL=wss://database-api.mrwari.com \
 *   AGENT_TOKEN=agt_live_xxxxx \
 *   node dist/agent-main.js
 *
 * It opens an OUTBOUND WebSocket to the cloud relay (no inbound ports needed),
 * authenticates with the pairing token, and answers `driver` RPCs by running
 * the real DriverFactory drivers against the database locally. The cloud sends
 * the (decrypted) credentials with each call over the TLS+token-secured relay;
 * the agent caches one driver per connectionId.
 *
 * Because it uses the same DriverFactory as the server, every capability
 * (queries, introspection, mutations) works identically — the only difference
 * is where the TCP connection to the DB originates.
 */
import { io, Socket } from 'socket.io-client';
import { DriverFactory } from './drivers/driver.factory';
import { IDatabaseDriver, ConnectionCredentials, DriverOptions } from './drivers/driver.interface';
import type { Dialect } from '@prisma/client';

const RELAY_URL = process.env.AGENT_RELAY_URL;
const TOKEN = process.env.AGENT_TOKEN;
const VERSION = '0.1.0';

if (!RELAY_URL || !TOKEN) {
  // eslint-disable-next-line no-console
  console.error('AGENT_RELAY_URL and AGENT_TOKEN are required.');
  process.exit(1);
}

const factory = new DriverFactory();

// One cached driver per connectionId. The cloud sends creds each call; we build
// the driver on first sight and reuse it (it pools its own connections).
const drivers = new Map<string, IDatabaseDriver>();

interface DriverRpcPayload {
  connectionId: string;
  dialect: Dialect;
  creds: ConnectionCredentials;
  opts: DriverOptions;
  method: keyof IDatabaseDriver | string;
  args: unknown[];
}

function getDriver(p: DriverRpcPayload): IDatabaseDriver {
  let d = drivers.get(p.connectionId);
  if (!d) {
    d = factory.create(p.dialect, p.creds, p.opts);
    drivers.set(p.connectionId, d);
  }
  return d;
}

// Connect directly to the /agent namespace on the relay.
const ns: Socket = io(`${RELAY_URL!.replace(/\/$/, '')}/agent`, {
  transports: ['websocket'],
  auth: { token: TOKEN, version: VERSION },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});

ns.on('connect', () => {
  // eslint-disable-next-line no-console
  console.log(`[agent] connected to relay ${RELAY_URL}`);
});

ns.on('ready', () => {
  // eslint-disable-next-line no-console
  console.log('[agent] authenticated, ready for queries');
});

ns.on('disconnect', (reason) => {
  // eslint-disable-next-line no-console
  console.warn(`[agent] disconnected: ${reason}`);
});

ns.on('connect_error', (err) => {
  // eslint-disable-next-line no-console
  console.error(`[agent] connect error: ${err.message}`);
});

// Heartbeat so the cloud keeps lastSeenAt fresh.
setInterval(() => {
  if (ns.connected) ns.emit('heartbeat');
}, 20_000);

// Core: handle a driver RPC from the cloud.
ns.on('rpc', async (msg: { id: string; method: string; args: unknown[] }) => {
  const { id, method, args } = msg;
  try {
    if (method !== 'driver') {
      throw new Error(`Unknown RPC method: ${method}`);
    }
    const payload = args[0] as DriverRpcPayload;
    const driver = getDriver(payload);
    const fn = (driver as unknown as Record<string, unknown>)[payload.method];
    if (typeof fn !== 'function') {
      throw new Error(`Driver has no method "${payload.method}"`);
    }
    const result = await (fn as (...a: unknown[]) => Promise<unknown>).apply(driver, payload.args);
    ns.emit('rpc:result', { id, ok: true, result });
  } catch (e) {
    ns.emit('rpc:result', { id, ok: false, error: (e as Error).message });
  }
});

// Clean shutdown.
const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log('[agent] shutting down…');
  for (const d of drivers.values()) await d.close().catch(() => {});
  ns.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
