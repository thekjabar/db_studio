import axios from 'axios';

export type PlanTier = 'FREE' | 'PRO' | 'TEAM';

export interface PlanConfig {
  tier: PlanTier;
  name: string;
  /** Monthly price per seat, whole IQD. */
  seatPriceIqd: number;
  maxConnections: number;
  aiEnabled: boolean;
  dailyAiCalls: number;
  maxScheduledQueries: number;
  maxWebhooksPerConnection: number;
  /** null = unlimited seats. */
  maxSeats: number | null;
  updatedByOperatorId: string | null;
  updatedAt: string;
  createdAt: string;
}

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
        approvalStatus: 'pending' | 'approved' | 'rejected';
        approvalNote: string | null;
        approvedAt: string | null;
        rejectedAt: string | null;
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
        approvalStatus: 'pending' | 'approved' | 'rejected';
        approvalNote: string | null;
        approvedAt: string | null;
        rejectedAt: string | null;
        approvedByOperatorId: string | null;
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
  async approveUser(id: string, note?: string) {
    await client.post(`/operator/users/${id}/approve`, { note });
  },
  async rejectUser(id: string, reason: string) {
    await client.post(`/operator/users/${id}/reject`, { reason });
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
  async getPlans() {
    const { data } = await client.get<PlanConfig[]>('/operator/billing/plans');
    return data;
  },
  async updatePlan(tier: string, body: Record<string, unknown>) {
    const { data } = await client.patch<PlanConfig>(`/operator/billing/plans/${tier}`, body);
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

  // ---- Feedback inbox ----
  async listFeedback(status: string | undefined, limit = 50, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        userId: string | null;
        email: string | null;
        category: string;
        message: string;
        sourcePath: string | null;
        status: string;
        internalNotes: string | null;
        replyText: string | null;
        repliedAt: string | null;
        createdAt: string;
        user: { email: string; displayName: string | null; id: string } | null;
      }>;
      total: number;
      unread: number;
    }>('/operator/feedback', { params: { status, limit, offset } });
    return data;
  },
  async getFeedback(id: string) {
    const { data } = await client.get(`/operator/feedback/${id}`);
    return data;
  },
  async setFeedbackStatus(id: string, status: string) {
    await client.patch(`/operator/feedback/${id}/status`, { status });
  },
  async setFeedbackNote(id: string, internalNotes: string) {
    await client.patch(`/operator/feedback/${id}/note`, { internalNotes });
  },
  async replyFeedback(id: string, body: string) {
    const { data } = await client.post<{ sent: boolean; copyToManualEmail: boolean; error: string | null }>(
      `/operator/feedback/${id}/reply`,
      { body },
    );
    return data;
  },

  // ---- Announcements ----
  async listAnnouncements(limit = 50, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        title: string;
        body: string;
        severity: 'INFO' | 'WARNING' | 'CRITICAL';
        targeting: { userIds?: string[]; workspaceIds?: string[] } | null;
        startsAt: string;
        endsAt: string | null;
        createdAt: string;
      }>;
      total: number;
    }>('/operator/announcements', { params: { limit, offset } });
    return data;
  },
  async createAnnouncement(body: {
    title: string;
    body: string;
    severity: 'INFO' | 'WARNING' | 'CRITICAL';
    targeting?: { userIds?: string[]; workspaceIds?: string[] };
    startsAt?: string;
    endsAt?: string;
  }) {
    const { data } = await client.post('/operator/announcements', body);
    return data;
  },
  async updateAnnouncement(id: string, body: Record<string, unknown>) {
    const { data } = await client.patch(`/operator/announcements/${id}`, body);
    return data;
  },
  async deleteAnnouncement(id: string) {
    await client.delete(`/operator/announcements/${id}`);
  },

  // ---- Email templates ----
  async listEmailTemplates() {
    const { data } = await client.get<Array<{
      name: string;
      subject: string;
      bodyHtml: string;
      bodyText: string;
      variables: string[];
      updatedAt: string;
    }>>('/operator/email-templates');
    return data;
  },
  async updateEmailTemplate(name: string, patch: { subject?: string; bodyHtml?: string; bodyText?: string }) {
    const { data } = await client.patch(`/operator/email-templates/${name}`, patch);
    return data;
  },

  // ---- Analytics ----
  async platformSeries(days = 30) {
    const { data } = await client.get<Array<{ day: string; signups: number; logins: number; uniqueUsers: number }>>(
      '/operator/analytics/platform', { params: { days } });
    return data;
  },
  async userSeries(id: string, days = 30) {
    const { data } = await client.get<{
      classification: 'active' | 'at_risk' | 'dormant' | 'never_logged_in';
      series: Array<{ day: string; logins: number; queries: number; aiCalls: number }>;
    }>(`/operator/analytics/users/${id}`, { params: { days } });
    return data;
  },
  async userSupport(id: string) {
    const { data } = await client.get<{
      failedLogins: Array<{ id: string; createdAt: string; ip: string | null }>;
      suspendedLogins: Array<{ id: string; createdAt: string }>;
      abuseEvents: Array<{ id: string; rule: string; createdAt: string; ip: string | null; metadata: unknown }>;
    }>(`/operator/analytics/users/${id}/support`);
    return data;
  },

  // ---- Billing adjustments ----
  async listAdjustments(workspaceId: string) {
    const { data } = await client.get<Array<{
      id: string;
      amountCents: number;
      currency: string;
      reason: string;
      periodStart: string | null;
      periodEnd: string | null;
      createdAt: string;
    }>>(`/operator/workspaces/${workspaceId}/adjustments`);
    return data;
  },
  async issueAdjustment(workspaceId: string, body: {
    amountCents: number;
    currency?: string;
    reason: string;
    periodStart?: string;
    periodEnd?: string;
  }) {
    const { data } = await client.post(`/operator/workspaces/${workspaceId}/adjustments`, body);
    return data;
  },

  // ---- Invite codes + waitlist ----
  async listInviteCodes(limit = 50, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        code: string;
        usesRemaining: number;
        maxUses: number;
        expiresAt: string | null;
        assignedEmail: string | null;
        note: string | null;
        createdAt: string;
      }>;
      total: number;
    }>('/operator/invite-codes', { params: { limit, offset } });
    return data;
  },
  async createInviteCode(body: {
    code?: string;
    maxUses?: number;
    expiresAt?: string;
    assignedEmail?: string;
    note?: string;
  }) {
    const { data } = await client.post('/operator/invite-codes', body);
    return data;
  },
  async deleteInviteCode(code: string) {
    await client.delete(`/operator/invite-codes/${encodeURIComponent(code)}`);
  },
  async listWaitlist(limit = 100, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        email: string;
        invitedAt: string | null;
        notes: string | null;
        createdAt: string;
        inviteCode: { code: string; usesRemaining: number } | null;
      }>;
      total: number;
    }>('/operator/waitlist', { params: { limit, offset } });
    return data;
  },
  async inviteWaitlistEntry(id: string, maxUses = 1) {
    const { data } = await client.post(`/operator/waitlist/${id}/invite`, { maxUses });
    return data;
  },

  // ---- Abuse ----
  async listAbuse(acked: boolean | undefined, rule: string | undefined, ip: string | undefined, limit = 100, offset = 0) {
    const { data } = await client.get<{
      rows: Array<{
        id: string;
        rule: string;
        ip: string | null;
        userId: string | null;
        path: string | null;
        metadata: unknown;
        ackedAt: string | null;
        createdAt: string;
        user: { email: string; id: string } | null;
      }>;
      total: number;
    }>('/operator/abuse', {
      params: {
        acked: acked === undefined ? undefined : String(acked),
        rule,
        ip,
        limit,
        offset,
      },
    });
    return data;
  },
  async ackAbuse(id: string) {
    await client.post(`/operator/abuse/${id}/ack`);
  },
  async ackAbuseByIp(ip: string) {
    await client.post(`/operator/abuse/ack-ip/${encodeURIComponent(ip)}`);
  },
  async listBlockedIps() {
    const { data } = await client.get<Array<{ ip: string; reason: string | null; createdAt: string }>>(
      '/operator/abuse/blocked-ips');
    return data;
  },
  async blockIp(ip: string, reason?: string) {
    const { data } = await client.post('/operator/abuse/block-ip', { ip, reason });
    return data;
  },
  async unblockIp(ip: string) {
    await client.delete(`/operator/abuse/block-ip/${encodeURIComponent(ip)}`);
  },

  // ---- Retention ----
  async listRetention() {
    const { data } = await client.get<Array<{
      resource: string;
      keepDays: number;
      lastRunAt: string | null;
      lastRunRowsDeleted: number;
      updatedAt: string;
    }>>('/operator/retention');
    return data;
  },
  async updateRetention(resource: string, keepDays: number) {
    const { data } = await client.patch(`/operator/retention/${resource}`, { keepDays });
    return data;
  },
  async sweepRetention() {
    const { data } = await client.post<Record<string, number>>('/operator/retention/sweep');
    return data;
  },

  // ---- Feature flags ----
  async listFlags() {
    const { data } = await client.get<Array<{
      key: string;
      description: string | null;
      rolloutPercent: number;
      enabledUserIds: string[];
      enabledWorkspaceIds: string[];
      disabledUserIds: string[];
      disabledWorkspaceIds: string[];
      updatedAt: string;
    }>>('/operator/flags');
    return data;
  },
  async upsertFlag(body: {
    key: string;
    description?: string;
    rolloutPercent: number;
    enabledUserIds?: string[];
    enabledWorkspaceIds?: string[];
    disabledUserIds?: string[];
    disabledWorkspaceIds?: string[];
  }) {
    const { data } = await client.post('/operator/flags', body);
    return data;
  },
  async deleteFlag(key: string) {
    await client.delete(`/operator/flags/${encodeURIComponent(key)}`);
  },

  // ---- Audit export ----
  auditExportUrl(format: 'csv' | 'jsonl', from?: string, to?: string) {
    const params = new URLSearchParams({ format });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return `/api/operator/audit/export?${params.toString()}`;
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
