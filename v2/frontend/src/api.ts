const BASE = "/v2/api";

export function getToken(): string | null {
  return localStorage.getItem("qs_v2_token");
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem("qs_v2_token", t);
  else localStorage.removeItem("qs_v2_token");
}

export interface Timed<T> {
  body: T;
  clientMs: number;
}

async function req<T = any>(path: string, opts: RequestInit = {}): Promise<Timed<T>> {
  const t0 = performance.now();
  const token = getToken();
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  const clientMs = performance.now() - t0;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error || res.statusText);
  return { body: body as T, clientMs };
}

export const api = {
  login: (email: string, password: string) =>
    req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => req("/auth/me"),
  healthDb: () => req<{ ok: boolean; tookMs: number }>("/health/db"),
  schemas: () => req<{ schemas: string[] }>("/introspect/schemas"),
  tables: (s: string) => req<{ tables: string[] }>(`/introspect/${encodeURIComponent(s)}/tables`),
  columns: (s: string, t: string) =>
    req<{ columns: any[] }>(`/introspect/${encodeURIComponent(s)}/${encodeURIComponent(t)}/columns`),
  rows: (s: string, t: string, limit = 100, offset = 0) =>
    req<{ rows: any[]; rowCount: number; total: number | null; tookMs: number }>(
      `/table/${encodeURIComponent(s)}/${encodeURIComponent(t)}/rows?limit=${limit}&offset=${offset}`,
    ),
  run: (sql: string) =>
    req<{ columns: string[]; rows: any[]; rowCount: number; tookMs: number; rowsAffected?: number }>(
      "/query/run",
      { method: "POST", body: JSON.stringify({ sql }) },
    ),
};
