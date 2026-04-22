import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from "axios";
import { useAuth, type AuthUser } from "./auth-store";
import { applyDensity } from "./density";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000/api";

export const http = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

// Attach access token
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuth.getState().accessToken;
  if (token) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }
  return config;
});

// Refresh on 401
let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const r = await axios.post(
      `${API_URL}/auth/refresh`,
      {},
      { withCredentials: true }
    );
    const token = r.data?.accessToken as string | undefined;
    if (token) {
      useAuth.getState().setAccessToken(token);
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

http.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
    const status = error.response?.status;

    if (status === 401 && original && !original._retry && !original.url?.includes("/auth/")) {
      original._retry = true;
      if (!refreshPromise) refreshPromise = doRefresh().finally(() => (refreshPromise = null));
      const newToken = await refreshPromise;
      if (newToken) {
        original.headers = original.headers ?? {};
        (original.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        return http.request(original);
      }
      useAuth.getState().clear();
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { message?: string | string[]; error?: string }
      | undefined;
    if (data?.message) {
      return Array.isArray(data.message) ? data.message.join(", ") : data.message;
    }
    if (data?.error) return data.error;
    return err.message;
  }
  return err instanceof Error ? err.message : "Unknown error";
}

// ---- Types ----
export type Dialect = "POSTGRES" | "MYSQL" | "SQLITE" | "MSSQL";

export interface Connection {
  id: string;
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode?: string;
  readOnly?: boolean;
  statementTimeoutMs?: number;
  workspaceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SshTunnelInput {
  host: string;
  port: number;
  user: string;
  authType: "password" | "privateKey";
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface CreateConnectionInput {
  name: string;
  dialect: Dialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslMode?: string;
  readOnly?: boolean;
  statementTimeoutMs?: number;
  ssh?: SshTunnelInput | null;
}

export interface TableInfo {
  name: string;
  type: "table" | "view";
  rowEstimate?: number;
  schema?: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey?: boolean;
  isUnique?: boolean;
  isIdentity?: boolean;
  comment?: string | null;
  charMaxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  fk?: { table: string; column: string; schema?: string } | null;
}

export interface TableDataResponse {
  rows: Record<string, unknown>[];
  /** `null` when the backend skipped COUNT on a large filtered set. */
  total: number | null;
  /** True when `total` is a planner estimate (e.g. pg_class.reltuples). */
  totalIsEstimate?: boolean;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataType?: string }[];
  command?: string;
  durationMs: number;
  warnings?: string[];
  needsConfirm?: boolean;
}

export type AuditAction =
  | "LOGIN"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "SIGNUP"
  | "TOTP_ENABLED"
  | "TOTP_DISABLED"
  | "CONNECTION_CREATED"
  | "CONNECTION_UPDATED"
  | "CONNECTION_DELETED"
  | "CONNECTION_TESTED"
  | "QUERY_RUN"
  | "ROW_INSERT"
  | "ROW_UPDATE"
  | "ROW_DELETE"
  | "SCHEMA_CHANGE"
  | "MEMBER_ADDED"
  | "MEMBER_REMOVED";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  user?: string | null;
  userId?: string | null;
  connectionId?: string | null;
  sqlText?: string | null;
  affectedRows?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: unknown;
  createdAt: string;
}

export interface ChartConfig {
  type: "line" | "bar" | "pie" | "area";
  x: string;
  y: string[];
  stacked?: boolean;
  limit?: number;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  isPersonal: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceDetail extends Workspace {
  myRole: "OWNER" | "EDITOR" | "VIEWER";
  members: Array<{
    id: string;
    userId: string;
    role: "OWNER" | "EDITOR" | "VIEWER";
    createdAt: string;
    user: { id: string; email: string; displayName?: string | null };
  }>;
}

export type MemberRole = "OWNER" | "EDITOR" | "VIEWER";

export interface ConnectionMember {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
  createdAt: string;
}

export interface TableGrant {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  schemaName: string;
  tableName: string;
  role: MemberRole;
  createdAt: string;
}

export type ScheduledRunStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface ScheduledQuery {
  id: string;
  connectionId: string;
  connection?: { id: string; name: string; dialect: Dialect };
  ownerId: string;
  name: string;
  cron: string;
  timezone: string | null;
  sqlText: string;
  /** Comma-separated on the wire; UI treats it as a list. */
  emailTo: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: ScheduledRunStatus | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  connectionId: string;
  name: string;
  cron: string;
  timezone?: string;
  sqlText: string;
  emailTo: string[];
  enabled?: boolean;
}

export interface ScheduledQueryRun {
  id: string;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScheduledRunStatus;
  rowCount: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  resultPreview: Record<string, unknown>[] | null;
  emailDelivered: boolean;
  emailError: string | null;
}

export interface Comment {
  id: string;
  connectionId: string;
  userId: string;
  target: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user?: { email: string; displayName?: string | null } | null;
}

export interface SavedQuery {
  id: string;
  name: string;
  sqlText: string;
  chartConfig?: ChartConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface ErNode {
  id: string;
  schema: string;
  name: string;
  columns: Array<{ name: string; type: string; pk?: boolean; nullable?: boolean }>;
  position?: { x: number; y: number };
}
export interface ErEdge {
  id: string;
  source: string;
  target: string;
  columns?: string[];
  refColumns?: string[];
}
export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
}

// ---- Schema changes ----
export interface ColumnSpec {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  defaultIsExpression?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  check?: string | null;
  comment?: string | null;
}
export interface ForeignKeySpec {
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}
export interface CreateTableRequest {
  schema: string;
  name: string;
  columns: ColumnSpec[];
  foreignKeys?: ForeignKeySpec[];
  confirm?: boolean;
}
export interface AlterTableRequest {
  schema: string;
  name: string;
  addColumns?: ColumnSpec[];
  dropColumns?: string[];
  dropConstraints?: string[];
  renameColumns?: { from: string; to: string }[];
  alterColumns?: {
    name: string;
    type?: string;
    nullable?: boolean;
    default?: string | null;
    check?: string | null;
    comment?: string | null;
  }[];
  addForeignKeys?: ForeignKeySpec[];
  renameTo?: string;
  confirm?: boolean;
}
export interface SchemaChangeResponse {
  preview: string;
  executed: boolean;
}

// ---- API functions ----
function toCreatePayload(input: CreateConnectionInput) {
  const { name, dialect, readOnly, statementTimeoutMs, host, port, database, user, password, sslMode, ssh } = input;
  const credentials: Record<string, unknown> = { host, port, database, user, password, sslMode };
  if (ssh) credentials.ssh = ssh;
  return {
    name,
    dialect,
    readOnly,
    statementTimeoutMs,
    credentials,
  };
}

function toUpdatePayload(input: Partial<CreateConnectionInput>) {
  const { name, readOnly, statementTimeoutMs, host, port, database, user, password, sslMode, ssh } = input;
  const credentials: Record<string, unknown> = {};
  if (host !== undefined) credentials.host = host;
  if (port !== undefined) credentials.port = port;
  if (database !== undefined) credentials.database = database;
  if (user !== undefined) credentials.user = user;
  if (password !== undefined) credentials.password = password;
  if (sslMode !== undefined) credentials.sslMode = sslMode;
  if (ssh !== undefined) credentials.ssh = ssh ?? null;
  return {
    ...(name !== undefined && { name }),
    ...(readOnly !== undefined && { readOnly }),
    ...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
    ...(Object.keys(credentials).length > 0 && { credentials }),
  };
}

export const api = {
  signup: async (input: { email: string; password: string; displayName?: string }) => {
    const { data } = await http.post<{ accessToken: string; userId: string }>("/auth/signup", input);
    useAuth.getState().setAccessToken(data.accessToken);
    const user = await http.get<AuthUser>("/users/me").then((r) => r.data);
    if (user.density) applyDensity(user.density);
    return { accessToken: data.accessToken, user };
  },
  login: async (input: { email: string; password: string; totpCode?: string }) => {
    const { data } = await http.post<{ accessToken: string; userId: string }>("/auth/login", input);
    useAuth.getState().setAccessToken(data.accessToken);
    const user = await http.get<AuthUser>("/users/me").then((r) => r.data);
    if (user.density) applyDensity(user.density);
    return { accessToken: data.accessToken, user };
  },
  logout: () => http.post("/auth/logout").then((r) => r.data),
  refresh: () => http.post<{ accessToken: string }>("/auth/refresh").then((r) => r.data),
  me: () => http.get<AuthUser>("/users/me").then((r) => r.data),
  oauthProviders: () =>
    http.get<{ google: boolean; github: boolean }>("/auth/oauth/providers").then((r) => r.data),
  oauthUrl: (provider: "google" | "github") => `${API_URL}/auth/oauth/${provider}`,
  updateProfile: (patch: { displayName?: string; density?: AuthUser["density"] }) =>
    http.patch<AuthUser>("/users/me", patch).then((r) => r.data),
  enable2fa: () =>
    http.post<{ secret: string; otpauthUrl: string; qrSvg: string }>("/auth/2fa/enable").then((r) => r.data),
  verify2fa: (code: string) => http.post("/auth/2fa/verify", { code }).then((r) => r.data),
  disable2fa: (code: string) => http.post("/auth/2fa/disable", { code }).then((r) => r.data),

  listConnections: (workspaceId?: string) =>
    http
      .get<Connection[]>("/connections", { params: workspaceId ? { workspaceId } : undefined })
      .then((r) => r.data),
  createConnection: (input: CreateConnectionInput) =>
    http.post<Connection>("/connections", toCreatePayload(input)).then((r) => r.data),
  updateConnection: (id: string, input: Partial<CreateConnectionInput>) =>
    http.patch<Connection>(`/connections/${id}`, toUpdatePayload(input)).then((r) => r.data),
  deleteConnection: (id: string) => http.delete(`/connections/${id}`).then((r) => r.data),
  testConnection: (id: string) =>
    http
      .post<{ ok: boolean; serverVersion?: string; message?: string; latencyMs?: number }>(
        `/connections/${id}/test`
      )
      .then((r) => r.data),

  listSchemas: (id: string) => http.get<string[]>(`/connections/${id}/schemas`).then((r) => r.data),
  listTables: (id: string, schema: string) =>
    http.get<TableInfo[]>(`/connections/${id}/tables`, { params: { schema } }).then((r) => r.data),
  getTableColumns: (id: string, table: string, schema: string) =>
    http
      .get<ColumnInfo[]>(`/connections/${id}/tables/${encodeURIComponent(table)}/columns`, {
        params: { schema },
      })
      .then((r) => r.data),
  getTableDefinition: (id: string, table: string, schema: string) =>
    http
      .get<{ sql: string; unsupported?: boolean }>(
        `/connections/${id}/tables/${encodeURIComponent(table)}/definition`,
        { params: { schema } },
      )
      .then((r) => r.data),
  getTableData: (
    id: string,
    table: string,
    opts: {
      schema: string;
      limit?: number;
      offset?: number;
      filters?: { column: string; op: string; value: unknown }[];
      orderBy?: { column: string; direction: "asc" | "desc" }[];
    }
  ) =>
    http
      .get<TableDataResponse>(`/connections/${id}/tables/${encodeURIComponent(table)}/data`, {
        params: {
          schema: opts.schema,
          limit: opts.limit,
          offset: opts.offset,
          filters: opts.filters && opts.filters.length ? JSON.stringify(opts.filters) : undefined,
          orderBy: opts.orderBy && opts.orderBy.length
            ? opts.orderBy.map((o) => `${o.column}:${o.direction}`).join(",")
            : undefined,
        },
      })
      .then((r) => r.data),
  insertRow: (id: string, table: string, body: { schema: string; row: Record<string, unknown> }) =>
    http
      .post(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { values: body.row }, { params: { schema: body.schema } })
      .then((r) => r.data),
  updateRow: (
    id: string,
    table: string,
    body: { schema: string; pk: Record<string, unknown>; set: Record<string, unknown> }
  ) =>
    http
      .patch(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { pk: body.pk, values: body.set }, { params: { schema: body.schema } })
      .then((r) => r.data),
  deleteRow: (id: string, table: string, body: { schema: string; pk: Record<string, unknown> }) =>
    http
      .delete(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { data: { pk: body.pk }, params: { schema: body.schema } })
      .then((r) => r.data),
  bulkDeleteRows: (id: string, table: string, body: { schema: string; pks: Record<string, unknown>[] }) =>
    http
      .post<{ affectedRows: number }>(
        `/connections/${id}/tables/${encodeURIComponent(table)}/rows/bulk-delete`,
        { pks: body.pks },
        { params: { schema: body.schema } },
      )
      .then((r) => r.data),
  bulkUpdateRows: (
    id: string,
    table: string,
    body: { schema: string; pks: Record<string, unknown>[]; values: Record<string, unknown> },
  ) =>
    http
      .post<{ affectedRows: number }>(
        `/connections/${id}/tables/${encodeURIComponent(table)}/rows/bulk-update`,
        { pks: body.pks, values: body.values },
        { params: { schema: body.schema } },
      )
      .then((r) => r.data),

  runQuery: (id: string, body: { sql: string; confirmDestructive?: boolean }) =>
    http.post<QueryResult>(`/connections/${id}/query`, body).then((r) => r.data),

  aiGenerateSql: (id: string, body: { prompt: string; schema?: string }) =>
    http
      .post<{ sql: string; explanation: string; tables: string[] }>(`/connections/${id}/ai/generate-sql`, body)
      .then((r) => r.data),

  listWorkspaces: () => http.get<Workspace[]>("/workspaces").then((r) => r.data),
  createWorkspace: (body: { name: string }) =>
    http.post<Workspace>("/workspaces", body).then((r) => r.data),
  getWorkspace: (id: string) =>
    http.get<WorkspaceDetail>(`/workspaces/${id}`).then((r) => r.data),
  renameWorkspace: (id: string, name: string) =>
    http.patch<Workspace>(`/workspaces/${id}`, { name }).then((r) => r.data),
  deleteWorkspace: (id: string) =>
    http.delete(`/workspaces/${id}`).then((r) => r.data),
  addWorkspaceMember: (id: string, body: { email: string; role: "OWNER" | "EDITOR" | "VIEWER" }) =>
    http.post(`/workspaces/${id}/members`, body).then((r) => r.data),
  updateWorkspaceMember: (id: string, memberId: string, role: "OWNER" | "EDITOR" | "VIEWER") =>
    http.patch(`/workspaces/${id}/members/${memberId}`, { role }).then((r) => r.data),
  removeWorkspaceMember: (id: string, memberId: string) =>
    http.delete(`/workspaces/${id}/members/${memberId}`).then((r) => r.data),

  listConnectionMembers: (id: string) =>
    http.get<ConnectionMember[]>(`/connections/${id}/permissions/members`).then((r) => r.data),
  addConnectionMember: (id: string, body: { email: string; role: MemberRole }) =>
    http.post<ConnectionMember>(`/connections/${id}/permissions/members`, body).then((r) => r.data),
  updateConnectionMember: (id: string, memberId: string, role: MemberRole) =>
    http.patch<ConnectionMember>(`/connections/${id}/permissions/members/${memberId}`, { role }).then((r) => r.data),
  removeConnectionMember: (id: string, memberId: string) =>
    http.delete(`/connections/${id}/permissions/members/${memberId}`).then((r) => r.data),

  listTableGrants: (id: string) =>
    http.get<TableGrant[]>(`/connections/${id}/permissions/table-grants`).then((r) => r.data),
  upsertTableGrant: (
    id: string,
    body: { email: string; schemaName: string; tableName: string; role: MemberRole },
  ) => http.post<TableGrant>(`/connections/${id}/permissions/table-grants`, body).then((r) => r.data),
  removeTableGrant: (id: string, grantId: string) =>
    http.delete(`/connections/${id}/permissions/table-grants/${grantId}`).then((r) => r.data),

  listSchedules: () => http.get<ScheduledQuery[]>("/schedules").then((r) => r.data),
  getSchedule: (id: string) =>
    http.get<ScheduledQuery>(`/schedules/${id}`).then((r) => r.data),
  createSchedule: (body: CreateScheduleInput) =>
    http.post<ScheduledQuery>("/schedules", body).then((r) => r.data),
  updateSchedule: (id: string, body: Partial<CreateScheduleInput>) =>
    http.patch<ScheduledQuery>(`/schedules/${id}`, body).then((r) => r.data),
  deleteSchedule: (id: string) => http.delete(`/schedules/${id}`).then((r) => r.data),
  runScheduleNow: (id: string) =>
    http.post<{ queued: boolean }>(`/schedules/${id}/run`).then((r) => r.data),
  listScheduleRuns: (id: string, limit = 50) =>
    http
      .get<ScheduledQueryRun[]>(`/schedules/${id}/runs`, { params: { limit } })
      .then((r) => r.data),

  listComments: (id: string, target?: string) =>
    http
      .get<Comment[]>(`/connections/${id}/comments`, { params: target ? { target } : undefined })
      .then((r) => r.data),
  commentCounts: (id: string) =>
    http.get<Record<string, number>>(`/connections/${id}/comments/counts`).then((r) => r.data),
  createComment: (id: string, body: { target: string; body: string }) =>
    http.post<Comment>(`/connections/${id}/comments`, body).then((r) => r.data),
  updateComment: (id: string, commentId: string, body: string) =>
    http
      .patch<Comment>(`/connections/${id}/comments/${commentId}`, { body })
      .then((r) => r.data),
  deleteComment: (id: string, commentId: string) =>
    http.delete(`/connections/${id}/comments/${commentId}`).then((r) => r.data),

  getEr: (id: string, schema: string) =>
    http.get<ErGraph>(`/connections/${id}/er`, { params: { schema } }).then((r) => r.data),

  createTable: (id: string, body: CreateTableRequest) =>
    http.post<SchemaChangeResponse>(`/connections/${id}/schema/tables`, body).then((r) => r.data),
  alterTable: (id: string, body: AlterTableRequest) =>
    http.patch<SchemaChangeResponse>(`/connections/${id}/schema/tables`, body).then((r) => r.data),
  dropTable: (id: string, schema: string, name: string, confirm: boolean) =>
    http
      .delete<SchemaChangeResponse>(`/connections/${id}/schema/tables`, {
        params: { schema, name, confirm: confirm ? "true" : undefined },
      })
      .then((r) => r.data),

  listAudit: (id: string, params?: { limit?: number; cursor?: string }) =>
    http
      .get<{ items: AuditEntry[]; nextCursor?: string } | AuditEntry[]>(`/connections/${id}/audit`, {
        params,
      })
      .then((r) => {
        const d = r.data;
        if (Array.isArray(d)) return { items: d, nextCursor: undefined as string | undefined };
        return d;
      }),

  auditRevertPreview: (id: string, entryId: string) =>
    http
      .get<{ kind: string; description: string; rowCount: number }>(
        `/connections/${id}/audit/${entryId}/revert-preview`,
      )
      .then((r) => r.data),
  auditRevert: (id: string, entryId: string) =>
    http
      .post<{ affected: number }>(`/connections/${id}/audit/${entryId}/revert`)
      .then((r) => r.data),

  listSavedQueries: (id: string) =>
    http.get<SavedQuery[]>(`/connections/${id}/saved-queries`).then((r) => r.data),
  getSavedQuery: (id: string, queryId: string) =>
    http.get<SavedQuery>(`/connections/${id}/saved-queries/${queryId}`).then((r) => r.data),
  createSavedQuery: (
    id: string,
    body: { name: string; sqlText: string; chartConfig?: ChartConfig | null },
  ) =>
    http.post<SavedQuery>(`/connections/${id}/saved-queries`, body).then((r) => r.data),
  updateSavedQuery: (
    id: string,
    queryId: string,
    patch: { name?: string; sqlText?: string; chartConfig?: ChartConfig | null },
  ) =>
    http
      .patch<SavedQuery>(`/connections/${id}/saved-queries/${queryId}`, patch)
      .then((r) => r.data),
  deleteSavedQuery: (id: string, queryId: string) =>
    http.delete(`/connections/${id}/saved-queries/${queryId}`).then((r) => r.data),
};
