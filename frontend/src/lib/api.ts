import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from "axios";
import { useAuth, type AuthUser } from "./auth-store";
import { applyDensity } from "./density";
import { applyServerTheme } from "./theme-store";

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
  slowQueryAlertMs?: number | null;
  slowQueryAlertEmail?: string | null;
  requireReview?: boolean;
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
  slowQueryAlertMs?: number | null;
  slowQueryAlertEmail?: string | null;
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
  /** True when the server capped the result below the real row count. */
  truncated?: boolean;
  /** The cap the server applied (null if none). */
  appliedLimit?: number | null;
  /** True when this result was served from the correctness-aware cache. */
  cached?: boolean;
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

export interface DashboardSummary {
  id: string;
  name: string;
  description: string | null;
  connectionId: string;
  refreshSec: number | null;
  shareToken: string | null;
  updatedAt: string;
  _count: { tiles: number };
  owner: { id: string; email: string; displayName: string | null };
}

export interface DashboardTile {
  id: string;
  savedQueryId: string;
  title: string | null;
  chartOverride: ChartConfig | null;
  x: number;
  y: number;
  w: number;
  h: number;
  savedQuery: {
    id: string;
    name: string;
    sqlText: string;
    chartConfig: ChartConfig | null;
  };
}

export interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  connectionId: string;
  ownerId: string;
  refreshSec: number | null;
  shareToken: string | null;
  createdAt: string;
  updatedAt: string;
  tiles: DashboardTile[];
}

export interface NotebookCell {
  id: string;
  kind: "md" | "sql";
  source: string;
  title?: string;
}

export interface PublicDashboard {
  id: string;
  name: string;
  description: string | null;
  refreshSec: number | null;
  tiles: {
    id: string;
    title: string;
    chartConfig: ChartConfig | null;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
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
  schemaName: string | null;
  sqlText: string;
  /** Comma-separated on the wire; UI treats it as a list. */
  emailTo: string;
  slackWebhook: string | null;
  alertCondition: AlertCondition | null;
  alertCooldownMin: number | null;
  lastAlertedAt: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: ScheduledRunStatus | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AlertOp =
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "eq"
  | "neq"
  | "rows_gt"
  | "rows_gte"
  | "rows_lt"
  | "rows_eq";

export interface AlertCondition {
  column?: string;
  op: AlertOp;
  value: number;
}

export interface CreateScheduleInput {
  connectionId: string;
  name: string;
  cron: string;
  timezone?: string;
  schemaName?: string | null;
  sqlText: string;
  emailTo: string[];
  slackWebhook?: string;
  alertCondition?: AlertCondition | null;
  alertCooldownMin?: number | null;
  enabled?: boolean;
}

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  connectionIds: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type WebhookEvent = "ROW_INSERT" | "ROW_UPDATE" | "ROW_DELETE";
export type WebhookDeliveryStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface Webhook {
  id: string;
  connectionId: string;
  ownerId: string;
  name: string;
  url: string;
  schemaName: string;
  tableName: string;
  events: WebhookEvent[];
  enabled: boolean;
  lastFiredAt: string | null;
  lastStatus: WebhookDeliveryStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  schemaName: string;
  tableName: string;
  events: WebhookEvent[];
  enabled?: boolean;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  attempt: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface FederatedQueryResult {
  rows: Record<string, unknown>[];
  fields: { name: string; dataType?: string }[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  appliedLimit: number | null;
  sources: { alias: string; connectionId: string; dialect: Dialect }[];
}

export interface SourcePushdown {
  alias: string;
  dialect: Dialect;
  tables: string[];
  pushedFilters: string[];
  projectedColumns: string[];
  fullScan: boolean;
  estimatedRows: number | null;
}

export interface FederatedPlan {
  raw: string;
  sources: SourcePushdown[];
  localOperations: string[];
  warnings: string[];
}

export interface SlowQueryGroup {
  shapeHash: string;
  normalizedSql: string;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  lastSeen: string;
  erroredCount: number;
  exampleSql: string;
}

export interface SlowQueryRun {
  id: string;
  connectionId: string;
  userId: string | null;
  shapeHash: string;
  normalizedSql: string;
  exampleSql: string;
  durationMs: number;
  rowCount: number | null;
  rowsAffected: number | null;
  errored: boolean;
  errorMessage: string | null;
  createdAt: string;
  user?: { email: string; displayName: string | null } | null;
}

export type ExplainMode = "plan" | "analyze";
export type ExplainWarningSeverity = "info" | "warn" | "error";

export interface ExplainWarning {
  severity: ExplainWarningSeverity;
  message: string;
  nodePath?: string;
}

export interface ExplainPlanNode {
  id: string;
  parentId: string | null;
  depth: number;
  label: string;
  nodeType: string;
  relation?: string;
  totalCost?: number;
  startupCost?: number;
  planRows?: number;
  actualRows?: number;
  actualTotalMs?: number;
  warnings: ExplainWarning[];
}

export interface ExplainResult {
  dialect: Dialect;
  mode: ExplainMode;
  raw: unknown;
  nodes: ExplainPlanNode[];
  warnings: ExplainWarning[];
  totalCost?: number;
  totalTimeMs?: number;
  planTimeMs?: number;
  executionTimeMs?: number;
}

export interface PlanScan {
  nodeType: string;
  relation: string | null;
}

export interface PlanSnapshot {
  id: string;
  shapeHash: string;
  normalizedSql: string;
  exampleSql: string;
  planHash: string;
  planSummary: string;
  totalCost: number | null;
  totalTimeMs: number | null;
  scans: PlanScan[];
  nodes: ExplainPlanNode[];
  regressed: boolean;
  regressionNote: string | null;
  createdAt: string;
}

export interface PlanDiff {
  from: PlanSnapshot;
  to: PlanSnapshot;
  changed: boolean;
  costDeltaRatio: number | null;
  regressionNote: string | null;
}

export interface CursorPage {
  fields: { name: string; dataType?: string }[];
  rows: Record<string, unknown>[];
  done: boolean;
}

export interface TranspileWarning {
  severity: "info" | "warn";
  message: string;
}
export interface TranspileResult {
  from: Dialect;
  to: Dialect;
  sql: string;
  warnings: TranspileWarning[];
  noop: boolean;
}

export interface CsvUploadResult {
  sessionId: string;
  filename: string;
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
}

export interface CsvMapping {
  csvColumn: number | null;
  targetColumn: string;
}

export interface CsvDryRunReport {
  totalRows: number;
  okRows: number;
  errorRows: { rowIndex: number; message: string }[];
}

export interface CsvCommitReport {
  inserted: number;
  failed: { rowIndex: number; message: string }[];
  durationMs: number;
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
    const { data } = await http.post<
      | { accessToken: string; userId: string }
      | { needsVerification: true; userId: string }
      | { awaitingApproval: true; userId: string }
    >("/auth/signup", input);
    if ("awaitingApproval" in data && data.awaitingApproval) {
      return { awaitingApproval: true as const, userId: data.userId };
    }
    if ("needsVerification" in data && data.needsVerification) {
      return { needsVerification: true as const, userId: data.userId };
    }
    if ("accessToken" in data) {
      useAuth.getState().setAccessToken(data.accessToken);
      const user = await http.get<AuthUser>("/users/me").then((r) => r.data);
      if (user.density) applyDensity(user.density);
      applyServerTheme(user.theme);
      return { accessToken: data.accessToken, user };
    }
    throw new Error("Unexpected signup response");
  },
  verifyEmail: (token: string) =>
    http.post<{ ok: boolean }>("/auth/verify-email", { token }).then((r) => r.data),
  resendVerification: (email: string) =>
    http.post<{ ok: boolean }>("/auth/resend-verification", { email }).then((r) => r.data),
  requestPasswordReset: (email: string) =>
    http.post<{ ok: boolean }>("/auth/request-password-reset", { email }).then((r) => r.data),
  completePasswordReset: (token: string, newPassword: string) =>
    http
      .post<{ ok: boolean }>("/auth/complete-password-reset", { token, newPassword })
      .then((r) => r.data),
  login: async (input: { email: string; password: string; totpCode?: string }) => {
    const { data } = await http.post<{ accessToken: string; userId: string }>("/auth/login", input);
    useAuth.getState().setAccessToken(data.accessToken);
    const user = await http.get<AuthUser>("/users/me").then((r) => r.data);
    if (user.density) applyDensity(user.density);
    applyServerTheme(user.theme);
    return { accessToken: data.accessToken, user };
  },
  logout: () => http.post("/auth/logout").then((r) => r.data),
  refresh: () => http.post<{ accessToken: string }>("/auth/refresh").then((r) => r.data),
  me: () => http.get<AuthUser>("/users/me").then((r) => r.data),
  oauthProviders: () =>
    http.get<{ google: boolean; github: boolean }>("/auth/oauth/providers").then((r) => r.data),
  oauthUrl: (provider: "google" | "github") => `${API_URL}/auth/oauth/${provider}`,
  updateProfile: (patch: { displayName?: string; density?: AuthUser["density"]; theme?: AuthUser["theme"] }) =>
    http.patch<AuthUser>("/users/me", patch).then((r) => r.data),
  enable2fa: () =>
    http.post<{ secret: string; otpauthUrl: string; qrSvg: string }>("/auth/2fa/enable").then((r) => r.data),
  verify2fa: (code: string) => http.post("/auth/2fa/verify", { code }).then((r) => r.data),
  disable2fa: (code: string) => http.post("/auth/2fa/disable", { code }).then((r) => r.data),

  listConnections: (workspaceId?: string) =>
    http
      .get<Connection[]>("/connections", { params: workspaceId ? { workspaceId } : undefined })
      .then((r) => r.data),
  getConnection: (id: string) =>
    http.get<Connection>(`/connections/${id}`).then((r) => r.data),
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

  runQuery: (
    id: string,
    body: {
      sql: string;
      confirmDestructive?: boolean;
      maxRows?: number;
      reviewRequestId?: string;
    },
  ) =>
    http.post<QueryResult>(`/connections/${id}/query`, body).then((r) => r.data),

  exportResult: (
    id: string,
    body: {
      sql: string;
      target: "email" | "slack" | "webhook";
      to: string;
      name?: string;
    },
  ) =>
    http
      .post<{ rowCount: number; delivered: true }>(`/connections/${id}/export`, body)
      .then((r) => r.data),

  aiGenerateSql: (id: string, body: { prompt: string; schema?: string }) =>
    http
      .post<{ sql: string; explanation: string; tables: string[] }>(`/connections/${id}/ai/generate-sql`, body)
      .then((r) => r.data),

  getWorkspaceSso: (workspaceId: string) =>
    http
      .get<{
        enabled: boolean;
        issuerUrl: string;
        clientId: string;
        allowedDomains: string | null;
        autoProvision: boolean;
        hasSecret: boolean;
      } | null>(`/workspaces/${workspaceId}/sso`)
      .then((r) => r.data),
  upsertWorkspaceSso: (
    workspaceId: string,
    input: {
      issuerUrl: string;
      clientId: string;
      clientSecret?: string;
      enabled?: boolean;
      allowedDomains?: string | null;
      autoProvision?: boolean;
    },
  ) =>
    http.put<{
      enabled: boolean;
      issuerUrl: string;
      clientId: string;
      allowedDomains: string | null;
      autoProvision: boolean;
      hasSecret: boolean;
    }>(`/workspaces/${workspaceId}/sso`, input).then((r) => r.data),
  disableWorkspaceSso: (workspaceId: string) =>
    http.delete<{ ok: true }>(`/workspaces/${workspaceId}/sso`).then((r) => r.data),
  ssoAvailable: (slug: string) =>
    http.get<{ available: boolean }>(`/auth/sso/${slug}/available`).then((r) => r.data),
  ssoStartUrl: (slug: string) => `${API_URL}/auth/sso/${slug}`,

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

  uploadCsv: (connectionId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return http
      .post<CsvUploadResult>(`/connections/${connectionId}/csv-import/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      })
      .then((r) => r.data);
  },
  csvDryRun: (
    connectionId: string,
    sessionId: string,
    body: { schema: string; table: string; mappings: CsvMapping[] },
  ) =>
    http
      .post<CsvDryRunReport>(
        `/connections/${connectionId}/csv-import/${sessionId}/dry-run`,
        body,
      )
      .then((r) => r.data),
  csvCommit: (
    connectionId: string,
    sessionId: string,
    body: { schema: string; table: string; mappings: CsvMapping[]; stopOnError?: boolean },
  ) =>
    http
      .post<CsvCommitReport>(
        `/connections/${connectionId}/csv-import/${sessionId}/commit`,
        body,
      )
      .then((r) => r.data),
  csvDiscard: (connectionId: string, sessionId: string) =>
    http.delete(`/connections/${connectionId}/csv-import/${sessionId}`).then((r) => r.data),

  /**
   * Fetch a DB backup as a blob and trigger a browser download. Uses axios so
   * the access token is attached automatically. Server streams pg_dump stdout.
   */
  listSlowQueries: (connectionId: string, hours = 168, limit = 100) =>
    http
      .get<SlowQueryGroup[]>(`/connections/${connectionId}/slow-queries`, {
        params: { hours, limit },
      })
      .then((r) => r.data),
  listSlowQueryRuns: (connectionId: string, shapeHash: string, limit = 50) =>
    http
      .get<SlowQueryRun[]>(`/connections/${connectionId}/slow-queries/${shapeHash}/runs`, {
        params: { limit },
      })
      .then((r) => r.data),

  explain: (
    connectionId: string,
    body: { sql: string; mode?: "plan" | "analyze" },
  ) =>
    http
      .post<ExplainResult>(`/connections/${connectionId}/query/explain`, body)
      .then((r) => r.data),

  // ---- Plan regression detection ----
  planCapture: (connectionId: string, sql: string) =>
    http
      .post<{ captured: boolean; snapshot: PlanSnapshot | null }>(
        `/connections/${connectionId}/query/plan-capture`,
        { sql },
      )
      .then((r) => r.data),
  planHistory: (connectionId: string, shapeHash: string, limit = 50) =>
    http
      .get<PlanSnapshot[]>(`/connections/${connectionId}/query/plan-history/${shapeHash}`, {
        params: { limit },
      })
      .then((r) => r.data),
  planRegressions: (connectionId: string, hours = 168, limit = 50) =>
    http
      .get<PlanSnapshot[]>(`/connections/${connectionId}/query/plan-regressions`, {
        params: { hours, limit },
      })
      .then((r) => r.data),
  planDiff: (connectionId: string, from: string, to: string) =>
    http
      .get<PlanDiff>(`/connections/${connectionId}/query/plan-diff`, { params: { from, to } })
      .then((r) => r.data),

  // ---- Server-side cursor streaming (Postgres) ----
  cursorOpen: (connectionId: string, sql: string, pageSize = 1000) =>
    http
      .post<CursorPage & { cursorId: string }>(`/connections/${connectionId}/query/cursor`, {
        sql,
        pageSize,
      })
      .then((r) => r.data),
  cursorFetch: (connectionId: string, cursorId: string, pageSize = 1000) =>
    http
      .post<CursorPage>(`/connections/${connectionId}/query/cursor/${cursorId}/fetch`, { pageSize })
      .then((r) => r.data),
  cursorClose: (connectionId: string, cursorId: string) =>
    http
      .post<{ closed: boolean }>(`/connections/${connectionId}/query/cursor/${cursorId}/close`)
      .then((r) => r.data),

  // ---- Cross-dialect transpilation ----
  transpile: (connectionId: string, body: { sql: string; to: Dialect; from?: Dialect }) =>
    http
      .post<TranspileResult>(`/connections/${connectionId}/query/transpile`, body)
      .then((r) => r.data),

  listApiKeys: () => http.get<ApiKey[]>("/api-keys").then((r) => r.data),
  createApiKey: (body: { name: string; connectionIds?: string[]; expiresAt?: string }) =>
    http.post<ApiKey & { token: string }>("/api-keys", body).then((r) => r.data),
  revokeApiKey: (id: string) =>
    http.post<ApiKey>(`/api-keys/${id}/revoke`).then((r) => r.data),
  deleteApiKey: (id: string) => http.delete(`/api-keys/${id}`).then((r) => r.data),

  listWebhooks: (connectionId: string) =>
    http.get<Webhook[]>(`/connections/${connectionId}/webhooks`).then((r) => r.data),
  createWebhook: (connectionId: string, body: CreateWebhookInput) =>
    http
      .post<Webhook & { secret: string }>(`/connections/${connectionId}/webhooks`, body)
      .then((r) => r.data),
  updateWebhook: (connectionId: string, webhookId: string, body: Partial<CreateWebhookInput> & { secret?: string }) =>
    http
      .patch<Webhook>(`/connections/${connectionId}/webhooks/${webhookId}`, body)
      .then((r) => r.data),
  deleteWebhook: (connectionId: string, webhookId: string) =>
    http.delete(`/connections/${connectionId}/webhooks/${webhookId}`).then((r) => r.data),
  testWebhook: (connectionId: string, webhookId: string) =>
    http
      .post<{ queued: boolean }>(`/connections/${connectionId}/webhooks/${webhookId}/test`)
      .then((r) => r.data),
  listWebhookDeliveries: (connectionId: string, webhookId: string, limit = 50) =>
    http
      .get<WebhookDelivery[]>(`/connections/${connectionId}/webhooks/${webhookId}/deliveries`, {
        params: { limit },
      })
      .then((r) => r.data),

  migrationExport: (
    connectionId: string,
    target: "prisma" | "drizzle" | "sql",
    schema?: string,
  ) =>
    http
      .get<{ target: string; filename: string; content: string }>(
        `/connections/${connectionId}/migration-export`,
        { params: { target, ...(schema ? { schema } : {}) } },
      )
      .then((r) => r.data),

  listSchemaSnapshots: (connectionId: string) =>
    http
      .get<
        {
          id: string;
          name: string;
          dbSchema: string | null;
          createdAt: string;
          createdBy: { email: string; displayName: string | null } | null;
        }[]
      >(`/connections/${connectionId}/migration-export/snapshots`)
      .then((r) => r.data),
  createSchemaSnapshot: (connectionId: string, body: { name: string; schema?: string }) =>
    http
      .post<{ id: string; name: string; createdAt: string }>(
        `/connections/${connectionId}/migration-export/snapshots`,
        body,
      )
      .then((r) => r.data),
  deleteSchemaSnapshot: (connectionId: string, snapshotId: string) =>
    http
      .delete<{ ok: true }>(
        `/connections/${connectionId}/migration-export/snapshots/${snapshotId}`,
      )
      .then((r) => r.data),
  diffSchemaSnapshot: (connectionId: string, snapshotId: string) =>
    http
      .get<{
        fromSnapshotId: string;
        dialect: string;
        sql: string;
        summary: {
          addedTables: string[];
          droppedTables: string[];
          addedColumns: string[];
          droppedColumns: string[];
          changedColumns: string[];
          addedFks: string[];
          droppedFks: string[];
        };
      }>(`/connections/${connectionId}/migration-export/snapshots/${snapshotId}/diff`)
      .then((r) => r.data),

  federatedQuery: (body: {
    sources: { alias: string; connectionId: string }[];
    sql: string;
    maxRows?: number;
  }) => http.post<FederatedQueryResult>("/federated/query", body).then((r) => r.data),

  federatedExplain: (body: {
    sources: { alias: string; connectionId: string }[];
    sql: string;
  }) => http.post<FederatedPlan>("/federated/explain", body).then((r) => r.data),

  estimateBackup: (connectionId: string, schema?: string) =>
    http
      .get<{ bytes: number | null; tables: number; note: string }>(
        `/connections/${connectionId}/backup/estimate`,
        { params: schema ? { schema } : undefined },
      )
      .then((r) => r.data),

  /**
   * Stream a DB backup and report live progress. Uses fetch() directly because
   * axios blob mode doesn't expose chunks mid-flight.
   *
   * `fileHandle` must be provided by the caller synchronously during the click
   * handler — `showSaveFilePicker` enforces that it's opened from a user
   * gesture, and any `await` before it loses the gesture flag. If omitted we
   * fall back to buffering in memory and triggering a normal download (used
   * on Firefox/Safari and HTTP origins where the picker isn't available).
   */
  downloadBackup: async (
    connectionId: string,
    opts: { format: "sql" | "custom"; schemaOnly?: boolean; schema?: string },
    onProgress?: (p: { bytes: number; estimateBytes: number | null; elapsedMs: number }) => void,
    signal?: AbortSignal,
    fileHandle?: FileSystemFileHandle | null,
  ) => {
    const params = new URLSearchParams({ format: opts.format });
    if (opts.schemaOnly) params.set("schemaOnly", "true");
    if (opts.schema) params.set("schema", opts.schema);

    const token = useAuth.getState().accessToken;
    const response = await fetch(
      `${API_URL}/connections/${connectionId}/backup?${params.toString()}`,
      {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal,
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Backup failed (${response.status}): ${text.slice(0, 200)}`);
    }
    if (!response.body) throw new Error("Streaming not supported by browser");

    const estimateRaw = response.headers.get("X-Dbdash-Estimate-Bytes");
    const estimateBytes = estimateRaw ? Number(estimateRaw) : null;
    const disposition = response.headers.get("Content-Disposition");
    const match = disposition?.match(/filename="([^"]+)"/);
    const filename = match?.[1] ?? `backup.${opts.format === "custom" ? "dump" : "sql"}`;

    const started = Date.now();
    onProgress?.({ bytes: 0, estimateBytes, elapsedMs: 0 });
    // Throttle progress callbacks so React doesn't re-render on every chunk.
    let lastEmit = 0;
    const EMIT_INTERVAL = 150;
    let bytes = 0;

    // Fast path: caller already opened a file picker on the user click and
    // handed us a writable handle. Stream chunks straight to disk — memory
    // stays flat, so the browser doesn't stall on large dumps (>500 MB).
    //
    // If this path fails mid-stream the response body is already locked to a
    // reader, so we can't retry the in-memory fallback. Surface the error
    // instead; the user picked a file and expects bytes in it.
    if (fileHandle) {
      const writable = await fileHandle.createWritable();
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await writable.write(value);
            bytes += value.byteLength;
            const now = Date.now();
            if (now - lastEmit >= EMIT_INTERVAL) {
              lastEmit = now;
              onProgress?.({ bytes, estimateBytes, elapsedMs: now - started });
            }
          }
        }
      } finally {
        await writable.close().catch(() => {});
      }
      onProgress?.({ bytes, estimateBytes, elapsedMs: Date.now() - started });
      return { bytes, filename };
    }

    // In-memory path — used when the File System Access API isn't available
    // (Firefox/Safari/HTTP origin) or the caller chose not to open a picker.
    // Fine up to a few hundred MB; gets memory-pressure stalls past that.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        bytes += value.byteLength;
        const now = Date.now();
        if (now - lastEmit >= EMIT_INTERVAL) {
          lastEmit = now;
          onProgress?.({ bytes, estimateBytes, elapsedMs: now - started });
        }
      }
    }
    onProgress?.({ bytes, estimateBytes, elapsedMs: Date.now() - started });

    const blob = new Blob(chunks as BlobPart[], {
      type: opts.format === "custom" ? "application/octet-stream" : "application/sql",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { bytes, filename };
  },

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

  listQueryHistory: (
    id: string,
    params?: {
      limit?: number;
      cursor?: string;
      userId?: string;
      sinceMs?: number;
      search?: string;
      action?: "QUERY_RUN" | "SCHEMA_CHANGE";
    },
  ) =>
    http
      .get<{ items: AuditEntry[]; nextCursor?: string }>(
        `/connections/${id}/audit/query-history`,
        { params },
      )
      .then((r) => r.data),

  adminOverview: () =>
    http
      .get<{
        users: number;
        admins: number;
        workspaces: number;
        connections: number;
        scheduledQueriesEnabled: number;
        webhooksEnabled: number;
        apiKeysActive: number;
        last24h: { failedLogins: number; signups: number; activeUsers: number };
      }>("/admin/overview")
      .then((r) => r.data),
  adminQueryVolume: () =>
    http
      .get<{ hour: string; queries: number; schemaChanges: number }[]>(
        "/admin/query-volume",
      )
      .then((r) => r.data),
  adminTopConnections: () =>
    http
      .get<{ connectionId: string; name: string; dialect: string | null; queries: number }[]>(
        "/admin/top-connections",
      )
      .then((r) => r.data),
  adminTopUsers: () =>
    http
      .get<{ userId: string; email: string; displayName: string | null; queries: number }[]>(
        "/admin/top-users",
      )
      .then((r) => r.data),
  adminListUsers: (params?: { search?: string; cursor?: string; limit?: number }) =>
    http
      .get<{
        items: {
          id: string;
          email: string;
          displayName: string | null;
          isAdmin: boolean;
          emailVerifiedAt: string | null;
          oauthProvider: string | null;
          createdAt: string;
        }[];
        nextCursor?: string;
      }>("/admin/users", { params })
      .then((r) => r.data),
  adminSetUserAdmin: (userId: string, isAdmin: boolean) =>
    http
      .patch<{ id: string; email: string; isAdmin: boolean }>(`/admin/users/${userId}`, {
        isAdmin,
      })
      .then((r) => r.data),

  listDashboards: (connectionId?: string) =>
    http
      .get<DashboardSummary[]>("/dashboards", {
        params: connectionId ? { connectionId } : undefined,
      })
      .then((r) => r.data),
  getDashboard: (id: string) =>
    http.get<Dashboard>(`/dashboards/${id}`).then((r) => r.data),
  createDashboard: (body: {
    name: string;
    description?: string;
    connectionId: string;
    refreshSec?: number;
  }) => http.post<Dashboard>("/dashboards", body).then((r) => r.data),
  updateDashboard: (
    id: string,
    patch: { name?: string; description?: string | null; refreshSec?: number | null },
  ) => http.patch<Dashboard>(`/dashboards/${id}`, patch).then((r) => r.data),
  deleteDashboard: (id: string) => http.delete<{ ok: true }>(`/dashboards/${id}`).then((r) => r.data),
  shareDashboard: (id: string, share: boolean) =>
    http
      .post<{ shareToken: string | null }>(`/dashboards/${id}/share`, { share })
      .then((r) => r.data),
  addDashboardTile: (
    id: string,
    body: {
      savedQueryId: string;
      title?: string;
      chartOverride?: ChartConfig | null;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
    },
  ) => http.post<DashboardTile>(`/dashboards/${id}/tiles`, body).then((r) => r.data),
  updateDashboardTile: (
    id: string,
    tileId: string,
    patch: {
      title?: string | null;
      chartOverride?: ChartConfig | null;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
    },
  ) =>
    http
      .patch<DashboardTile>(`/dashboards/${id}/tiles/${tileId}`, patch)
      .then((r) => r.data),
  removeDashboardTile: (id: string, tileId: string) =>
    http.delete<{ ok: true }>(`/dashboards/${id}/tiles/${tileId}`).then((r) => r.data),
  reorderDashboardTiles: (
    id: string,
    tiles: { id: string; x: number; y: number; w: number; h: number }[],
  ) =>
    http.put<{ ok: true }>(`/dashboards/${id}/tiles`, { tiles }).then((r) => r.data),
  runDashboardTile: (id: string, tileId: string) =>
    http
      .post<QueryResult>(`/dashboards/${id}/tiles/${tileId}/run`)
      .then((r) => r.data),

  getPublicDashboard: (token: string) =>
    http.get<PublicDashboard>(`/public/dashboards/${token}`).then((r) => r.data),
  runPublicDashboardTile: (token: string, tileId: string) =>
    http
      .post<QueryResult>(`/public/dashboards/${token}/tiles/${tileId}/run`)
      .then((r) => r.data),

  listAiChats: (connectionId: string) =>
    http
      .get<{ id: string; title: string; createdAt: string; updatedAt: string }[]>(
        "/ai/chats",
        { params: { connectionId } },
      )
      .then((r) => r.data),
  getAiChat: (id: string) =>
    http
      .get<{
        id: string;
        title: string;
        messages: {
          id: string;
          role: "user" | "assistant";
          content: string;
          sqlBlock: string | null;
          createdAt: string;
        }[];
      }>(`/ai/chats/${id}`)
      .then((r) => r.data),
  sendAiChatMessage: (body: { chatId?: string; connectionId: string; content: string }) =>
    http
      .post<{
        chatId: string;
        message: {
          id: string;
          role: "assistant";
          content: string;
          sqlBlock: string | null;
          createdAt: string;
        };
      }>("/ai/chats/messages", body)
      .then((r) => r.data),
  deleteAiChat: (id: string) =>
    http.delete<{ ok: true }>(`/ai/chats/${id}`).then((r) => r.data),

  listSessions: () =>
    http
      .get<
        {
          id: string;
          userAgent: string | null;
          ip: string | null;
          createdAt: string;
          expiresAt: string;
          current: boolean;
        }[]
      >("/auth/sessions")
      .then((r) => r.data),
  revokeSession: (id: string) =>
    http.delete<{ ok: true }>(`/auth/sessions/${id}`).then((r) => r.data),
  revokeOtherSessions: () =>
    http.delete<{ revoked: number }>("/auth/sessions").then((r) => r.data),

  publicStatus: () =>
    http
      .get<{
        overall: "operational" | "degraded" | "outage";
        asOf: string;
        components: {
          name: string;
          status: "ok" | "degraded" | "down";
          detail?: string;
        }[];
        activeIncidents: {
          id: string;
          title: string;
          status: "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED";
          severity: "MINOR" | "MAJOR" | "CRITICAL";
          startedAt: string;
          updates: { at: string; status: string; message: string }[];
        }[];
        recentIncidents: {
          id: string;
          title: string;
          severity: "MINOR" | "MAJOR" | "CRITICAL";
          startedAt: string;
          resolvedAt: string;
        }[];
      }>("/status")
      .then((r) => r.data),
  adminListIncidents: () =>
    http
      .get<
        {
          id: string;
          title: string;
          status: "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED";
          severity: "MINOR" | "MAJOR" | "CRITICAL";
          impact: string | null;
          updates: { at: string; status: string; message: string }[];
          startedAt: string;
          resolvedAt: string | null;
          createdBy: { email: string; displayName: string | null } | null;
        }[]
      >("/admin/incidents")
      .then((r) => r.data),
  adminCreateIncident: (body: {
    title: string;
    severity?: "MINOR" | "MAJOR" | "CRITICAL";
    impact?: string;
    message: string;
  }) => http.post("/admin/incidents", body).then((r) => r.data),
  adminAddIncidentUpdate: (
    id: string,
    body: { status: "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED"; message: string },
  ) => http.post(`/admin/incidents/${id}/updates`, body).then((r) => r.data),
  adminDeleteIncident: (id: string) =>
    http.delete(`/admin/incidents/${id}`).then((r) => r.data),

  listSchemaDocs: (connectionId: string, schema?: string, table?: string) =>
    http
      .get<
        {
          id: string;
          schemaName: string;
          tableName: string;
          columnName: string;
          description: string | null;
          tags: string | null;
          ownerEmail: string | null;
          updatedAt: string;
          updatedBy: { email: string; displayName: string | null } | null;
        }[]
      >(`/connections/${connectionId}/schema-docs`, {
        params: {
          ...(schema ? { schema } : {}),
          ...(table ? { table } : {}),
        },
      })
      .then((r) => r.data),
  upsertSchemaDoc: (
    connectionId: string,
    body: {
      schemaName: string;
      tableName: string;
      columnName?: string;
      description?: string;
      tags?: string;
      ownerEmail?: string;
    },
  ) => http.post(`/connections/${connectionId}/schema-docs`, body).then((r) => r.data),
  deleteSchemaDoc: (connectionId: string, docId: string) =>
    http.delete(`/connections/${connectionId}/schema-docs/${docId}`).then((r) => r.data),

  listRowFilters: (connectionId: string) =>
    http
      .get<
        {
          id: string;
          userId: string;
          email: string;
          displayName: string | null;
          schemaName: string;
          tableName: string;
          predicate: string;
          createdAt: string;
        }[]
      >(`/connections/${connectionId}/row-filters`)
      .then((r) => r.data),
  upsertRowFilter: (
    connectionId: string,
    body: { email: string; schemaName: string; tableName: string; predicate: string },
  ) =>
    http.post(`/connections/${connectionId}/row-filters`, body).then((r) => r.data),
  deleteRowFilter: (connectionId: string, filterId: string) =>
    http.delete(`/connections/${connectionId}/row-filters/${filterId}`).then((r) => r.data),

  listNotebooks: (connectionId?: string) =>
    http
      .get<
        {
          id: string;
          name: string;
          description: string | null;
          connectionId: string;
          updatedAt: string;
          owner: { id: string; email: string; displayName: string | null };
        }[]
      >("/notebooks", { params: connectionId ? { connectionId } : undefined })
      .then((r) => r.data),
  getNotebook: (id: string) =>
    http
      .get<{
        id: string;
        name: string;
        description: string | null;
        connectionId: string;
        ownerId: string;
        cells: NotebookCell[];
        createdAt: string;
        updatedAt: string;
      }>(`/notebooks/${id}`)
      .then((r) => r.data),
  createNotebook: (body: { name: string; description?: string; connectionId: string }) =>
    http
      .post<{ id: string; name: string; connectionId: string }>("/notebooks", body)
      .then((r) => r.data),
  updateNotebook: (
    id: string,
    patch: { name?: string; description?: string | null; cells?: NotebookCell[] },
  ) => http.patch(`/notebooks/${id}`, patch).then((r) => r.data),
  deleteNotebook: (id: string) =>
    http.delete<{ ok: true }>(`/notebooks/${id}`).then((r) => r.data),

  submitReviewRequest: (
    connectionId: string,
    body: { sqlText: string; reason?: string },
  ) =>
    http
      .post<{
        id: string;
        status: string;
        classification: string;
      }>(`/connections/${connectionId}/review-requests`, body)
      .then((r) => r.data),
  listReviewRequests: (connectionId: string, status?: string) =>
    http
      .get<
        {
          id: string;
          connectionId: string;
          sqlText: string;
          classification: string;
          reason: string | null;
          reviewComment: string | null;
          status:
            | "PENDING"
            | "APPROVED"
            | "REJECTED"
            | "EXECUTED"
            | "EXPIRED";
          approvedAt: string | null;
          executedAt: string | null;
          createdAt: string;
          requester: { id: string; email: string; displayName: string | null };
          reviewer: { id: string; email: string; displayName: string | null } | null;
        }[]
      >(`/connections/${connectionId}/review-requests`, {
        params: status ? { status } : undefined,
      })
      .then((r) => r.data),
  inboxReviewRequests: () =>
    http
      .get<
        {
          id: string;
          sqlText: string;
          classification: string;
          reason: string | null;
          createdAt: string;
          connection: { id: string; name: string; dialect: string };
          requester: { id: string; email: string; displayName: string | null };
        }[]
      >("/review-requests/inbox")
      .then((r) => r.data),
  approveReviewRequest: (id: string, comment?: string) =>
    http
      .post<{ id: string; status: string }>(`/review-requests/${id}/approve`, { comment })
      .then((r) => r.data),
  rejectReviewRequest: (id: string, comment?: string) =>
    http
      .post<{ id: string; status: string }>(`/review-requests/${id}/reject`, { comment })
      .then((r) => r.data),

  estimateCost: (connectionId: string, sql: string) =>
    http
      .post<{
        estimatedRowsScanned: number;
        plannerCost: number | null;
        estimatedDurationMs: number;
        verdict: "fast" | "moderate" | "slow" | "dangerous";
        warnings: string[];
      }>(`/connections/${connectionId}/query/estimate`, { sql })
      .then((r) => r.data),

  perfInsights: (connectionId: string, sql: string) =>
    http
      .post<{
        dialect: Dialect;
        findings: {
          severity: "info" | "warn" | "error";
          title: string;
          detail: string;
          nodePath?: string;
        }[];
        suggestions: {
          table: string;
          columns: string[];
          reason: string;
          sql: string;
          impact?: number;
        }[];
        plan: unknown[];
        totalCost?: number;
        totalTimeMs?: number;
      }>(`/connections/${connectionId}/query/insights`, { sql })
      .then((r) => r.data),

  dbHealthSnapshot: (connectionId: string) =>
    http
      .get<{
        at: string;
        dialect: Dialect;
        metrics: {
          key: string;
          label: string;
          value: number | string | null;
          unit?: string;
          severity?: "ok" | "warn" | "crit";
          hint?: string;
        }[];
        errors: string[];
        longRunning: {
          pid: number | string | null;
          user: string | null;
          database: string | null;
          durationMs: number | null;
          state: string | null;
          query: string | null;
          waitEvent?: string | null;
        }[];
      }>(`/connections/${connectionId}/db-health`)
      .then((r) => r.data),

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

  // ---- Feedback widget ----
  submitFeedback: (input: {
    message: string;
    category: 'BUG' | 'FEATURE' | 'QUESTION' | 'OTHER';
    sourcePath?: string;
    email?: string;
  }) => http.post('/feedback', input).then((r) => r.data),

  // ---- Announcements ----
  activeAnnouncements: () =>
    http
      .get<Array<{
        id: string;
        title: string;
        body: string;
        severity: 'INFO' | 'WARNING' | 'CRITICAL';
        startsAt: string;
        endsAt: string | null;
        seen: boolean;
        dismissedAt: string | null;
      }>>('/announcements/active')
      .then((r) => r.data),
  markAnnouncementSeen: (id: string) => http.post(`/announcements/${id}/seen`).then((r) => r.data),
  dismissAnnouncement: (id: string) => http.post(`/announcements/${id}/dismiss`).then((r) => r.data),

  // ---- Feature flags ----
  myFlags: () => http.get<Record<string, boolean>>('/flags/my').then((r) => r.data),

  // ---- SQL snippets ----
  listSnippets: (connectionId?: string) =>
    http
      .get<Array<{ id: string; name: string; sqlText: string; connectionId: string | null; updatedAt: string }>>(
        "/snippets",
        { params: { connectionId } },
      )
      .then((r) => r.data),
  createSnippet: (body: { name: string; sqlText: string; connectionId?: string }) =>
    http.post("/snippets", body).then((r) => r.data),
  deleteSnippet: (id: string) => http.delete(`/snippets/${id}`).then((r) => r.data),

  // ---- Sensitive data scan ----
  scanSensitive: (connectionId: string) =>
    http
      .post<{
        findings: Array<{
          schema: string;
          table: string;
          column: string;
          dataType: string;
          kind: string;
          reason: string;
          confidence: "high" | "medium";
        }>;
        tablesScanned: number;
      }>(`/connections/${connectionId}/sensitive-scan`)
      .then((r) => r.data),

  // ---- Column masks (pairs with the scanner) ----
  listColumnMasks: (connectionId: string) =>
    http
      .get<Array<{ id: string; email: string; schemaName: string; tableName: string; columnName: string }>>(
        `/connections/${connectionId}/column-masks`,
      )
      .then((r) => r.data),
  createColumnMask: (
    connectionId: string,
    body: { email: string; schemaName: string; tableName: string; columnName: string },
  ) => http.post(`/connections/${connectionId}/column-masks`, body).then((r) => r.data),

  // ---- Self usage (AI quota for the signed-in user) ----
  myAiUsage: () =>
    http
      .get<{ used: number; allowance: number; day: string }>('/ai/chats/quota')
      .then((r) => r.data),

  // ---- Customer audit log CSV export (owner-only) ----
  exportAuditCsv: async (connectionId: string) => {
    const res = await http.get(`/connections/${connectionId}/audit/export.csv`, {
      responseType: "blob",
    });
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${connectionId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  // ---- Shareable read-only query links ----
  createSharedQuery: (
    connectionId: string,
    body: { sqlText: string; title?: string; expiresInDays?: number; rowLimit?: number },
  ) =>
    http
      .post<{ token: string; id: string; expiresAt: string | null }>(
        `/connections/${connectionId}/shared-queries`,
        body,
      )
      .then((r) => r.data),
  listSharedQueries: (connectionId: string) =>
    http
      .get<
        Array<{
          id: string;
          token: string;
          title: string | null;
          sqlText: string;
          expiresAt: string | null;
          viewCount: number;
          createdAt: string;
          createdBy: { email: string; displayName: string | null };
        }>
      >(`/connections/${connectionId}/shared-queries`)
      .then((r) => r.data),
  revokeSharedQuery: (connectionId: string, shareId: string) =>
    http.delete(`/connections/${connectionId}/shared-queries/${shareId}`).then((r) => r.data),
  // Public — no auth header needed but http client tolerates it.
  getSharedQueryMeta: (token: string) =>
    http
      .get<{
        title: string | null;
        sqlText: string;
        expiresAt: string | null;
        rowLimit: number;
        connectionName: string;
        dialect: string;
      }>(`/public/shared-queries/${token}`)
      .then((r) => r.data),
  runSharedQuery: (token: string) =>
    http
      .post<{
        fields: { name: string; dataType: string }[];
        rows: Record<string, unknown>[];
        rowCount: number;
        truncated: boolean;
        durationMs: number;
      }>(`/public/shared-queries/${token}/run`)
      .then((r) => r.data),
};
