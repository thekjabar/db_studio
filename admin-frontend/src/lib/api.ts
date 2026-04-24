import axios from 'axios';

/**
 * Operator API client. Cookies carry the operator session (httpOnly,
 * never readable from JS), so we only need `withCredentials: true`.
 * A 401 triggers a single automatic refresh attempt; if that also
 * fails we bounce to /login.
 */
const client = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

let refreshing: Promise<void> | null = null;

// Paths the interceptor must NEVER intercept, otherwise we loop forever:
// the refresh endpoint itself returning 401 would re-trigger the refresh
// flow. The login endpoint is listed so a bad-password response falls
// straight through to the mutation's onError.
const NO_RETRY = ['/operator/auth/refresh', '/operator/auth/login', '/operator/auth/me'];

client.interceptors.response.use(
  (r) => r,
  async (error) => {
    if (!error.response || error.response.status !== 401) return Promise.reject(error);
    const original = error.config;
    const url = (original?.url ?? '') as string;
    // Don't try to refresh on the auth endpoints themselves — just let the
    // caller see the 401 so <RequireAuth> can navigate to /login.
    if (NO_RETRY.some((p) => url.endsWith(p))) return Promise.reject(error);
    if (original?._retried) return Promise.reject(error);
    try {
      refreshing ??= client.post('/operator/auth/refresh').then(() => undefined).finally(() => { refreshing = null; });
      await refreshing;
      original._retried = true;
      return client(original);
    } catch {
      return Promise.reject(error);
    }
  },
);

export interface Operator {
  id: string;
  email: string;
  displayName: string | null;
  isSuper: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const api = {
  async login(email: string, password: string) {
    const { data } = await client.post<{ operator: Operator; accessToken: string }>(
      '/operator/auth/login',
      { email, password },
    );
    return data;
  },
  async logout() {
    await client.post('/operator/auth/logout');
  },
  async me() {
    const { data } = await client.get<Operator>('/operator/auth/me');
    return data;
  },
  async dashboard() {
    const { data } = await client.get<{
      mrrCents: number;
      currency: string;
      activeSubscriptions: number;
      activeSeats: number;
      activeTopUpPacks: number;
      byStatus: Record<string, number>;
      totalUsers: number;
      suspendedUsers: number;
      usersThisWeek: number;
      usersThisMonth: number;
      cancelledThisMonth: number;
      totalWorkspaces: number;
      aiCallsToday: number;
    }>('/operator/dashboard/overview');
    return data;
  },
  async listUsers(q: string | undefined, status: string | undefined, limit = 50, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        email: string;
        displayName: string | null;
        isAdmin: boolean;
        suspendedAt: string | null;
        suspendedReason: string | null;
        emailVerified: boolean;
        createdAt: string;
        connections: number;
        workspacesOwned: number;
        workspacesJoined: number;
      }>;
      total: number;
    }>('/operator/users', { params: { q, status, limit, offset } });
    return data;
  },
  async getUser(id: string) {
    const { data } = await client.get(`/operator/users/${id}`);
    return data as {
      user: {
        id: string;
        email: string;
        displayName: string | null;
        isAdmin: boolean;
        suspendedAt: string | null;
        suspendedReason: string | null;
        emailVerified: boolean;
        createdAt: string;
      };
      workspaces: Array<{
        id: string;
        name: string;
        slug: string;
        seats: number;
        subscription: {
          status: string;
          periodStart: string;
          periodEnd: string;
          aiTopUpPacks: number;
        } | null;
      }>;
      aiUsageToday: number;
    };
  },
  async suspendUser(id: string, reason: string) {
    await client.post(`/operator/users/${id}/suspend`, { reason });
  },
  async unsuspendUser(id: string) {
    await client.post(`/operator/users/${id}/unsuspend`);
  },
  async deleteUser(id: string) {
    await client.delete(`/operator/users/${id}`);
  },
  async overrideSubscription(workspaceId: string, patch: Record<string, unknown>) {
    await client.patch(`/operator/users/subscriptions/${workspaceId}`, patch);
  },
  async listWorkspaces(q: string | undefined, status: string | undefined, limit = 50, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        name: string;
        slug: string;
        isPersonal: boolean;
        createdAt: string;
        owner: { id: string; email: string; displayName: string | null; suspendedAt: string | null };
        seats: number;
        connections: number;
        subscription: {
          status: string;
          periodStart: string;
          periodEnd: string;
          aiTopUpPacks: number;
          manualOverrideNote: string | null;
        } | null;
        monthlyCents: number;
      }>;
      total: number;
    }>('/operator/workspaces', { params: { q, status, limit, offset } });
    return data;
  },
  async getBilling() {
    const { data } = await client.get<{
      id: string;
      pricePerSeatCents: number;
      currency: string;
      dailyFreeAiCalls: number;
      aiTopUpCallsPerPack: number;
      aiTopUpPriceCents: number;
      updatedAt: string;
      createdAt: string;
    }>('/operator/billing/settings');
    return data;
  },
  async updateBilling(body: Record<string, unknown>) {
    const { data } = await client.patch('/operator/billing/settings', body);
    return data;
  },
  async listAudit(limit = 50, offset = 0, action?: string) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        operatorId: string;
        action: string;
        targetType: string | null;
        targetId: string | null;
        reason: string | null;
        metadata: Record<string, unknown> | null;
        createdAt: string;
        operator: { email: string; displayName: string | null };
      }>;
      total: number;
    }>('/operator/audit', { params: { limit, offset, action } });
    return data;
  },
  async listOperators() {
    const { data } = await client.get<Operator[]>('/operator/operators');
    return data;
  },
  async createOperator(body: { email: string; password: string; displayName?: string; isSuper?: boolean }) {
    const { data } = await client.post('/operator/operators', body);
    return data;
  },
  async disableOperator(id: string) {
    await client.post(`/operator/operators/${id}/disable`);
  },
  async enableOperator(id: string) {
    await client.post(`/operator/operators/${id}/enable`);
  },
};

export { client };

export function money(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function relativeDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
