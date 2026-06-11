import axios from "axios";
import { useAuth } from "./auth-store";
import { applyDensity } from "./density";
import { applyServerTheme } from "./theme-store";
export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000/api";
export const http = axios.create({
    baseURL: API_URL,
    withCredentials: true,
    headers: { "Content-Type": "application/json" },
});
// Attach access token
http.interceptors.request.use((config) => {
    const token = useAuth.getState().accessToken;
    if (token) {
        config.headers = config.headers ?? {};
        config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
});
// Refresh on 401
let refreshPromise = null;
async function doRefresh() {
    try {
        const r = await axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true });
        const token = r.data?.accessToken;
        if (token) {
            useAuth.getState().setAccessToken(token);
            return token;
        }
        return null;
    }
    catch {
        return null;
    }
}
http.interceptors.response.use((r) => r, async (error) => {
    const original = error.config;
    const status = error.response?.status;
    if (status === 401 && original && !original._retry && !original.url?.includes("/auth/")) {
        original._retry = true;
        if (!refreshPromise)
            refreshPromise = doRefresh().finally(() => (refreshPromise = null));
        const newToken = await refreshPromise;
        if (newToken) {
            original.headers = original.headers ?? {};
            original.headers.Authorization = `Bearer ${newToken}`;
            return http.request(original);
        }
        useAuth.getState().clear();
        if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
            window.location.href = "/login";
        }
    }
    return Promise.reject(error);
});
export function extractErrorMessage(err) {
    if (axios.isAxiosError(err)) {
        const data = err.response?.data;
        if (data?.message) {
            return Array.isArray(data.message) ? data.message.join(", ") : data.message;
        }
        if (data?.error)
            return data.error;
        return err.message;
    }
    return err instanceof Error ? err.message : "Unknown error";
}
// ---- API functions ----
function toCreatePayload(input) {
    const { name, dialect, readOnly, statementTimeoutMs, host, port, database, user, password, sslMode, ssh } = input;
    const credentials = { host, port, database, user, password, sslMode };
    if (ssh)
        credentials.ssh = ssh;
    return {
        name,
        dialect,
        readOnly,
        statementTimeoutMs,
        credentials,
    };
}
function toUpdatePayload(input) {
    const { name, readOnly, statementTimeoutMs, host, port, database, user, password, sslMode, ssh } = input;
    const credentials = {};
    if (host !== undefined)
        credentials.host = host;
    if (port !== undefined)
        credentials.port = port;
    if (database !== undefined)
        credentials.database = database;
    if (user !== undefined)
        credentials.user = user;
    if (password !== undefined)
        credentials.password = password;
    if (sslMode !== undefined)
        credentials.sslMode = sslMode;
    if (ssh !== undefined)
        credentials.ssh = ssh ?? null;
    return {
        ...(name !== undefined && { name }),
        ...(readOnly !== undefined && { readOnly }),
        ...(statementTimeoutMs !== undefined && { statementTimeoutMs }),
        ...(Object.keys(credentials).length > 0 && { credentials }),
    };
}
export const api = {
    signup: async (input) => {
        const { data } = await http.post("/auth/signup", input);
        if ("awaitingApproval" in data && data.awaitingApproval) {
            return { awaitingApproval: true, userId: data.userId };
        }
        if ("needsVerification" in data && data.needsVerification) {
            return { needsVerification: true, userId: data.userId };
        }
        if ("accessToken" in data) {
            useAuth.getState().setAccessToken(data.accessToken);
            const user = await http.get("/users/me").then((r) => r.data);
            if (user.density)
                applyDensity(user.density);
            applyServerTheme(user.theme);
            return { accessToken: data.accessToken, user };
        }
        throw new Error("Unexpected signup response");
    },
    verifyEmail: (token) => http.post("/auth/verify-email", { token }).then((r) => r.data),
    resendVerification: (email) => http.post("/auth/resend-verification", { email }).then((r) => r.data),
    requestPasswordReset: (email) => http.post("/auth/request-password-reset", { email }).then((r) => r.data),
    completePasswordReset: (token, newPassword) => http
        .post("/auth/complete-password-reset", { token, newPassword })
        .then((r) => r.data),
    login: async (input) => {
        const { data } = await http.post("/auth/login", input);
        useAuth.getState().setAccessToken(data.accessToken);
        const user = await http.get("/users/me").then((r) => r.data);
        if (user.density)
            applyDensity(user.density);
        applyServerTheme(user.theme);
        return { accessToken: data.accessToken, user };
    },
    logout: () => http.post("/auth/logout").then((r) => r.data),
    refresh: () => http.post("/auth/refresh").then((r) => r.data),
    me: () => http.get("/users/me").then((r) => r.data),
    oauthProviders: () => http.get("/auth/oauth/providers").then((r) => r.data),
    oauthUrl: (provider) => `${API_URL}/auth/oauth/${provider}`,
    updateProfile: (patch) => http.patch("/users/me", patch).then((r) => r.data),
    enable2fa: () => http.post("/auth/2fa/enable").then((r) => r.data),
    verify2fa: (code) => http.post("/auth/2fa/verify", { code }).then((r) => r.data),
    disable2fa: (code) => http.post("/auth/2fa/disable", { code }).then((r) => r.data),
    listConnections: (workspaceId) => http
        .get("/connections", { params: workspaceId ? { workspaceId } : undefined })
        .then((r) => r.data),
    getConnection: (id) => http.get(`/connections/${id}`).then((r) => r.data),
    createConnection: (input) => http.post("/connections", toCreatePayload(input)).then((r) => r.data),
    updateConnection: (id, input) => http.patch(`/connections/${id}`, toUpdatePayload(input)).then((r) => r.data),
    deleteConnection: (id) => http.delete(`/connections/${id}`).then((r) => r.data),
    testConnection: (id) => http
        .post(`/connections/${id}/test`)
        .then((r) => r.data),
    listSchemas: (id) => http.get(`/connections/${id}/schemas`).then((r) => r.data),
    listTables: (id, schema) => http.get(`/connections/${id}/tables`, { params: { schema } }).then((r) => r.data),
    getTableColumns: (id, table, schema) => http
        .get(`/connections/${id}/tables/${encodeURIComponent(table)}/columns`, {
        params: { schema },
    })
        .then((r) => r.data),
    getTableDefinition: (id, table, schema) => http
        .get(`/connections/${id}/tables/${encodeURIComponent(table)}/definition`, { params: { schema } })
        .then((r) => r.data),
    getTableData: (id, table, opts) => http
        .get(`/connections/${id}/tables/${encodeURIComponent(table)}/data`, {
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
    insertRow: (id, table, body) => http
        .post(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { values: body.row }, { params: { schema: body.schema } })
        .then((r) => r.data),
    updateRow: (id, table, body) => http
        .patch(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { pk: body.pk, values: body.set }, { params: { schema: body.schema } })
        .then((r) => r.data),
    deleteRow: (id, table, body) => http
        .delete(`/connections/${id}/tables/${encodeURIComponent(table)}/rows`, { data: { pk: body.pk }, params: { schema: body.schema } })
        .then((r) => r.data),
    bulkDeleteRows: (id, table, body) => http
        .post(`/connections/${id}/tables/${encodeURIComponent(table)}/rows/bulk-delete`, { pks: body.pks }, { params: { schema: body.schema } })
        .then((r) => r.data),
    bulkUpdateRows: (id, table, body) => http
        .post(`/connections/${id}/tables/${encodeURIComponent(table)}/rows/bulk-update`, { pks: body.pks, values: body.values }, { params: { schema: body.schema } })
        .then((r) => r.data),
    runQuery: (id, body) => http.post(`/connections/${id}/query`, body).then((r) => r.data),
    exportResult: (id, body) => http
        .post(`/connections/${id}/export`, body)
        .then((r) => r.data),
    aiGenerateSql: (id, body) => http
        .post(`/connections/${id}/ai/generate-sql`, body)
        .then((r) => r.data),
    getWorkspaceSso: (workspaceId) => http
        .get(`/workspaces/${workspaceId}/sso`)
        .then((r) => r.data),
    upsertWorkspaceSso: (workspaceId, input) => http.put(`/workspaces/${workspaceId}/sso`, input).then((r) => r.data),
    disableWorkspaceSso: (workspaceId) => http.delete(`/workspaces/${workspaceId}/sso`).then((r) => r.data),
    ssoAvailable: (slug) => http.get(`/auth/sso/${slug}/available`).then((r) => r.data),
    ssoStartUrl: (slug) => `${API_URL}/auth/sso/${slug}`,
    listWorkspaces: () => http.get("/workspaces").then((r) => r.data),
    createWorkspace: (body) => http.post("/workspaces", body).then((r) => r.data),
    getWorkspace: (id) => http.get(`/workspaces/${id}`).then((r) => r.data),
    renameWorkspace: (id, name) => http.patch(`/workspaces/${id}`, { name }).then((r) => r.data),
    deleteWorkspace: (id) => http.delete(`/workspaces/${id}`).then((r) => r.data),
    addWorkspaceMember: (id, body) => http.post(`/workspaces/${id}/members`, body).then((r) => r.data),
    updateWorkspaceMember: (id, memberId, role) => http.patch(`/workspaces/${id}/members/${memberId}`, { role }).then((r) => r.data),
    removeWorkspaceMember: (id, memberId) => http.delete(`/workspaces/${id}/members/${memberId}`).then((r) => r.data),
    listConnectionMembers: (id) => http.get(`/connections/${id}/permissions/members`).then((r) => r.data),
    addConnectionMember: (id, body) => http.post(`/connections/${id}/permissions/members`, body).then((r) => r.data),
    updateConnectionMember: (id, memberId, role) => http.patch(`/connections/${id}/permissions/members/${memberId}`, { role }).then((r) => r.data),
    removeConnectionMember: (id, memberId) => http.delete(`/connections/${id}/permissions/members/${memberId}`).then((r) => r.data),
    listTableGrants: (id) => http.get(`/connections/${id}/permissions/table-grants`).then((r) => r.data),
    upsertTableGrant: (id, body) => http.post(`/connections/${id}/permissions/table-grants`, body).then((r) => r.data),
    removeTableGrant: (id, grantId) => http.delete(`/connections/${id}/permissions/table-grants/${grantId}`).then((r) => r.data),
    listSchedules: () => http.get("/schedules").then((r) => r.data),
    getSchedule: (id) => http.get(`/schedules/${id}`).then((r) => r.data),
    createSchedule: (body) => http.post("/schedules", body).then((r) => r.data),
    updateSchedule: (id, body) => http.patch(`/schedules/${id}`, body).then((r) => r.data),
    deleteSchedule: (id) => http.delete(`/schedules/${id}`).then((r) => r.data),
    runScheduleNow: (id) => http.post(`/schedules/${id}/run`).then((r) => r.data),
    listScheduleRuns: (id, limit = 50) => http
        .get(`/schedules/${id}/runs`, { params: { limit } })
        .then((r) => r.data),
    uploadCsv: (connectionId, file) => {
        const fd = new FormData();
        fd.append("file", file);
        return http
            .post(`/connections/${connectionId}/csv-import/upload`, fd, {
            headers: { "Content-Type": "multipart/form-data" },
        })
            .then((r) => r.data);
    },
    csvDryRun: (connectionId, sessionId, body) => http
        .post(`/connections/${connectionId}/csv-import/${sessionId}/dry-run`, body)
        .then((r) => r.data),
    csvCommit: (connectionId, sessionId, body) => http
        .post(`/connections/${connectionId}/csv-import/${sessionId}/commit`, body)
        .then((r) => r.data),
    csvDiscard: (connectionId, sessionId) => http.delete(`/connections/${connectionId}/csv-import/${sessionId}`).then((r) => r.data),
    /**
     * Fetch a DB backup as a blob and trigger a browser download. Uses axios so
     * the access token is attached automatically. Server streams pg_dump stdout.
     */
    listSlowQueries: (connectionId, hours = 168, limit = 100) => http
        .get(`/connections/${connectionId}/slow-queries`, {
        params: { hours, limit },
    })
        .then((r) => r.data),
    listSlowQueryRuns: (connectionId, shapeHash, limit = 50) => http
        .get(`/connections/${connectionId}/slow-queries/${shapeHash}/runs`, {
        params: { limit },
    })
        .then((r) => r.data),
    explain: (connectionId, body) => http
        .post(`/connections/${connectionId}/query/explain`, body)
        .then((r) => r.data),
    listApiKeys: () => http.get("/api-keys").then((r) => r.data),
    createApiKey: (body) => http.post("/api-keys", body).then((r) => r.data),
    revokeApiKey: (id) => http.post(`/api-keys/${id}/revoke`).then((r) => r.data),
    deleteApiKey: (id) => http.delete(`/api-keys/${id}`).then((r) => r.data),
    listWebhooks: (connectionId) => http.get(`/connections/${connectionId}/webhooks`).then((r) => r.data),
    createWebhook: (connectionId, body) => http
        .post(`/connections/${connectionId}/webhooks`, body)
        .then((r) => r.data),
    updateWebhook: (connectionId, webhookId, body) => http
        .patch(`/connections/${connectionId}/webhooks/${webhookId}`, body)
        .then((r) => r.data),
    deleteWebhook: (connectionId, webhookId) => http.delete(`/connections/${connectionId}/webhooks/${webhookId}`).then((r) => r.data),
    testWebhook: (connectionId, webhookId) => http
        .post(`/connections/${connectionId}/webhooks/${webhookId}/test`)
        .then((r) => r.data),
    listWebhookDeliveries: (connectionId, webhookId, limit = 50) => http
        .get(`/connections/${connectionId}/webhooks/${webhookId}/deliveries`, {
        params: { limit },
    })
        .then((r) => r.data),
    migrationExport: (connectionId, target, schema) => http
        .get(`/connections/${connectionId}/migration-export`, { params: { target, ...(schema ? { schema } : {}) } })
        .then((r) => r.data),
    listSchemaSnapshots: (connectionId) => http
        .get(`/connections/${connectionId}/migration-export/snapshots`)
        .then((r) => r.data),
    createSchemaSnapshot: (connectionId, body) => http
        .post(`/connections/${connectionId}/migration-export/snapshots`, body)
        .then((r) => r.data),
    deleteSchemaSnapshot: (connectionId, snapshotId) => http
        .delete(`/connections/${connectionId}/migration-export/snapshots/${snapshotId}`)
        .then((r) => r.data),
    diffSchemaSnapshot: (connectionId, snapshotId) => http
        .get(`/connections/${connectionId}/migration-export/snapshots/${snapshotId}/diff`)
        .then((r) => r.data),
    federatedQuery: (body) => http.post("/federated/query", body).then((r) => r.data),
    estimateBackup: (connectionId, schema) => http
        .get(`/connections/${connectionId}/backup/estimate`, { params: schema ? { schema } : undefined })
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
    downloadBackup: async (connectionId, opts, onProgress, signal, fileHandle) => {
        const params = new URLSearchParams({ format: opts.format });
        if (opts.schemaOnly)
            params.set("schemaOnly", "true");
        if (opts.schema)
            params.set("schema", opts.schema);
        const token = useAuth.getState().accessToken;
        const response = await fetch(`${API_URL}/connections/${connectionId}/backup?${params.toString()}`, {
            credentials: "include",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`Backup failed (${response.status}): ${text.slice(0, 200)}`);
        }
        if (!response.body)
            throw new Error("Streaming not supported by browser");
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
                    if (done)
                        break;
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
            }
            finally {
                await writable.close().catch(() => { });
            }
            onProgress?.({ bytes, estimateBytes, elapsedMs: Date.now() - started });
            return { bytes, filename };
        }
        // In-memory path — used when the File System Access API isn't available
        // (Firefox/Safari/HTTP origin) or the caller chose not to open a picker.
        // Fine up to a few hundred MB; gets memory-pressure stalls past that.
        const reader = response.body.getReader();
        const chunks = [];
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
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
        const blob = new Blob(chunks, {
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
    listComments: (id, target) => http
        .get(`/connections/${id}/comments`, { params: target ? { target } : undefined })
        .then((r) => r.data),
    commentCounts: (id) => http.get(`/connections/${id}/comments/counts`).then((r) => r.data),
    createComment: (id, body) => http.post(`/connections/${id}/comments`, body).then((r) => r.data),
    updateComment: (id, commentId, body) => http
        .patch(`/connections/${id}/comments/${commentId}`, { body })
        .then((r) => r.data),
    deleteComment: (id, commentId) => http.delete(`/connections/${id}/comments/${commentId}`).then((r) => r.data),
    getEr: (id, schema) => http.get(`/connections/${id}/er`, { params: { schema } }).then((r) => r.data),
    createTable: (id, body) => http.post(`/connections/${id}/schema/tables`, body).then((r) => r.data),
    alterTable: (id, body) => http.patch(`/connections/${id}/schema/tables`, body).then((r) => r.data),
    dropTable: (id, schema, name, confirm) => http
        .delete(`/connections/${id}/schema/tables`, {
        params: { schema, name, confirm: confirm ? "true" : undefined },
    })
        .then((r) => r.data),
    listAudit: (id, params) => http
        .get(`/connections/${id}/audit`, {
        params,
    })
        .then((r) => {
        const d = r.data;
        if (Array.isArray(d))
            return { items: d, nextCursor: undefined };
        return d;
    }),
    listQueryHistory: (id, params) => http
        .get(`/connections/${id}/audit/query-history`, { params })
        .then((r) => r.data),
    adminOverview: () => http
        .get("/admin/overview")
        .then((r) => r.data),
    adminQueryVolume: () => http
        .get("/admin/query-volume")
        .then((r) => r.data),
    adminTopConnections: () => http
        .get("/admin/top-connections")
        .then((r) => r.data),
    adminTopUsers: () => http
        .get("/admin/top-users")
        .then((r) => r.data),
    adminListUsers: (params) => http
        .get("/admin/users", { params })
        .then((r) => r.data),
    adminSetUserAdmin: (userId, isAdmin) => http
        .patch(`/admin/users/${userId}`, {
        isAdmin,
    })
        .then((r) => r.data),
    listDashboards: (connectionId) => http
        .get("/dashboards", {
        params: connectionId ? { connectionId } : undefined,
    })
        .then((r) => r.data),
    getDashboard: (id) => http.get(`/dashboards/${id}`).then((r) => r.data),
    createDashboard: (body) => http.post("/dashboards", body).then((r) => r.data),
    updateDashboard: (id, patch) => http.patch(`/dashboards/${id}`, patch).then((r) => r.data),
    deleteDashboard: (id) => http.delete(`/dashboards/${id}`).then((r) => r.data),
    shareDashboard: (id, share) => http
        .post(`/dashboards/${id}/share`, { share })
        .then((r) => r.data),
    addDashboardTile: (id, body) => http.post(`/dashboards/${id}/tiles`, body).then((r) => r.data),
    updateDashboardTile: (id, tileId, patch) => http
        .patch(`/dashboards/${id}/tiles/${tileId}`, patch)
        .then((r) => r.data),
    removeDashboardTile: (id, tileId) => http.delete(`/dashboards/${id}/tiles/${tileId}`).then((r) => r.data),
    reorderDashboardTiles: (id, tiles) => http.put(`/dashboards/${id}/tiles`, { tiles }).then((r) => r.data),
    runDashboardTile: (id, tileId) => http
        .post(`/dashboards/${id}/tiles/${tileId}/run`)
        .then((r) => r.data),
    getPublicDashboard: (token) => http.get(`/public/dashboards/${token}`).then((r) => r.data),
    runPublicDashboardTile: (token, tileId) => http
        .post(`/public/dashboards/${token}/tiles/${tileId}/run`)
        .then((r) => r.data),
    listAiChats: (connectionId) => http
        .get("/ai/chats", { params: { connectionId } })
        .then((r) => r.data),
    getAiChat: (id) => http
        .get(`/ai/chats/${id}`)
        .then((r) => r.data),
    sendAiChatMessage: (body) => http
        .post("/ai/chats/messages", body)
        .then((r) => r.data),
    deleteAiChat: (id) => http.delete(`/ai/chats/${id}`).then((r) => r.data),
    listSessions: () => http
        .get("/auth/sessions")
        .then((r) => r.data),
    revokeSession: (id) => http.delete(`/auth/sessions/${id}`).then((r) => r.data),
    revokeOtherSessions: () => http.delete("/auth/sessions").then((r) => r.data),
    publicStatus: () => http
        .get("/status")
        .then((r) => r.data),
    adminListIncidents: () => http
        .get("/admin/incidents")
        .then((r) => r.data),
    adminCreateIncident: (body) => http.post("/admin/incidents", body).then((r) => r.data),
    adminAddIncidentUpdate: (id, body) => http.post(`/admin/incidents/${id}/updates`, body).then((r) => r.data),
    adminDeleteIncident: (id) => http.delete(`/admin/incidents/${id}`).then((r) => r.data),
    listSchemaDocs: (connectionId, schema, table) => http
        .get(`/connections/${connectionId}/schema-docs`, {
        params: {
            ...(schema ? { schema } : {}),
            ...(table ? { table } : {}),
        },
    })
        .then((r) => r.data),
    upsertSchemaDoc: (connectionId, body) => http.post(`/connections/${connectionId}/schema-docs`, body).then((r) => r.data),
    deleteSchemaDoc: (connectionId, docId) => http.delete(`/connections/${connectionId}/schema-docs/${docId}`).then((r) => r.data),
    listRowFilters: (connectionId) => http
        .get(`/connections/${connectionId}/row-filters`)
        .then((r) => r.data),
    upsertRowFilter: (connectionId, body) => http.post(`/connections/${connectionId}/row-filters`, body).then((r) => r.data),
    deleteRowFilter: (connectionId, filterId) => http.delete(`/connections/${connectionId}/row-filters/${filterId}`).then((r) => r.data),
    listNotebooks: (connectionId) => http
        .get("/notebooks", { params: connectionId ? { connectionId } : undefined })
        .then((r) => r.data),
    getNotebook: (id) => http
        .get(`/notebooks/${id}`)
        .then((r) => r.data),
    createNotebook: (body) => http
        .post("/notebooks", body)
        .then((r) => r.data),
    updateNotebook: (id, patch) => http.patch(`/notebooks/${id}`, patch).then((r) => r.data),
    deleteNotebook: (id) => http.delete(`/notebooks/${id}`).then((r) => r.data),
    submitReviewRequest: (connectionId, body) => http
        .post(`/connections/${connectionId}/review-requests`, body)
        .then((r) => r.data),
    listReviewRequests: (connectionId, status) => http
        .get(`/connections/${connectionId}/review-requests`, {
        params: status ? { status } : undefined,
    })
        .then((r) => r.data),
    inboxReviewRequests: () => http
        .get("/review-requests/inbox")
        .then((r) => r.data),
    approveReviewRequest: (id, comment) => http
        .post(`/review-requests/${id}/approve`, { comment })
        .then((r) => r.data),
    rejectReviewRequest: (id, comment) => http
        .post(`/review-requests/${id}/reject`, { comment })
        .then((r) => r.data),
    estimateCost: (connectionId, sql) => http
        .post(`/connections/${connectionId}/query/estimate`, { sql })
        .then((r) => r.data),
    perfInsights: (connectionId, sql) => http
        .post(`/connections/${connectionId}/query/insights`, { sql })
        .then((r) => r.data),
    dbHealthSnapshot: (connectionId) => http
        .get(`/connections/${connectionId}/db-health`)
        .then((r) => r.data),
    auditRevertPreview: (id, entryId) => http
        .get(`/connections/${id}/audit/${entryId}/revert-preview`)
        .then((r) => r.data),
    auditRevert: (id, entryId) => http
        .post(`/connections/${id}/audit/${entryId}/revert`)
        .then((r) => r.data),
    listSavedQueries: (id) => http.get(`/connections/${id}/saved-queries`).then((r) => r.data),
    getSavedQuery: (id, queryId) => http.get(`/connections/${id}/saved-queries/${queryId}`).then((r) => r.data),
    createSavedQuery: (id, body) => http.post(`/connections/${id}/saved-queries`, body).then((r) => r.data),
    updateSavedQuery: (id, queryId, patch) => http
        .patch(`/connections/${id}/saved-queries/${queryId}`, patch)
        .then((r) => r.data),
    deleteSavedQuery: (id, queryId) => http.delete(`/connections/${id}/saved-queries/${queryId}`).then((r) => r.data),
    // ---- Feedback widget ----
    submitFeedback: (input) => http.post('/feedback', input).then((r) => r.data),
    // ---- Announcements ----
    activeAnnouncements: () => http
        .get('/announcements/active')
        .then((r) => r.data),
    markAnnouncementSeen: (id) => http.post(`/announcements/${id}/seen`).then((r) => r.data),
    dismissAnnouncement: (id) => http.post(`/announcements/${id}/dismiss`).then((r) => r.data),
    // ---- Feature flags ----
    myFlags: () => http.get('/flags/my').then((r) => r.data),
};
