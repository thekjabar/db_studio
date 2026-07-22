import { io, Socket } from "socket.io-client";
import { useEffect, useState } from "react";
import { API_URL } from "./api";
import { useAuth } from "./auth-store";

// Strip the `/api` suffix — socket.io lives at the root of the backend.
const WS_ORIGIN = API_URL.replace(/\/api\/?$/, "");

let socket: Socket | null = null;
let socketToken: string | null = null;

function getSocket(token: string): Socket {
  // Same token → reuse, regardless of current state (reconnect in progress counts).
  if (socket && socketToken === token) {
    return socket;
  }
  // Different token → clean disconnect and start over.
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  socketToken = token;
  socket = io(`${WS_ORIGIN}/realtime`, {
    auth: { token },
    // POLLING FIRST, then websocket. Cloudflare completes the WS 101 handshake
    // but then corrupts socket.io's frames ("websocket error"), and with
    // websocket listed first socket.io errors out instead of falling back —
    // realtime stayed permanently offline. Verified: with websocket-first it
    // FAILS; with polling-first it CONNECTS. Starting on polling connects
    // immediately (polling works fine through CF); socket.io still upgrades to
    // websocket afterward if that path happens to work.
    transports: ["polling", "websocket"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
  });
  return socket;
}

function closeSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
  socketToken = null;
}

export type RealtimeStatus = "idle" | "connecting" | "connected" | "error";

/** Tracks the global WS status so the topbar pill can reflect reality. */
export function useRealtimeStatus(): RealtimeStatus {
  const token = useAuth((s) => s.accessToken);
  const [status, setStatus] = useState<RealtimeStatus>("idle");

  useEffect(() => {
    if (!token) {
      setStatus("idle");
      closeSocket();
      return;
    }
    const s = getSocket(token);
    setStatus(s.connected ? "connected" : "connecting");
    const onConnect = () => setStatus("connected");
    const onDisconnect = () => setStatus("connecting");
    const onError = () => setStatus("error");
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    s.on("connect_error", onError);
    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
      s.off("connect_error", onError);
    };
  }, [token]);

  return status;
}

/**
 * Subscribe to table change notifications. `onChange` fires when a change is
 * received — typical use is `() => qc.invalidateQueries(...)`.
 */
export function useTableSubscription(
  args: { connectionId?: string; schema?: string; table?: string; enabled?: boolean },
  onChange: () => void,
) {
  const token = useAuth((s) => s.accessToken);
  const { connectionId, schema, table, enabled = true } = args;

  useEffect(() => {
    if (!token || !enabled || !connectionId || !schema || !table) return;
    const s = getSocket(token);
    const payload = { connectionId, schema, table };

    const fire = () => onChange();
    s.on("change", fire);

    const subscribe = () => s.emit("subscribe", payload);
    if (s.connected) subscribe();
    else s.once("connect", subscribe);

    return () => {
      s.off("change", fire);
      s.emit("unsubscribe", payload);
    };
    // onChange intentionally omitted — we want to subscribe once per target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, enabled, connectionId, schema, table]);
}
