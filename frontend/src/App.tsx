import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { applyDensity } from "@/lib/density";
import { applyServerTheme } from "@/lib/theme-store";
import { Loader2 } from "lucide-react";

// Every route is code-split (React.lazy) so the initial bundle stays small —
// heavy deps (Monaco, xyflow/dagre, recharts) load only when their route is
// visited, instead of shipping in one ~2 MB main chunk.
const LoginPage = lazy(() => import("@/routes/login"));
const SignupPage = lazy(() => import("@/routes/signup"));
const OAuthCallbackPage = lazy(() => import("@/routes/oauth-callback"));
const AgentAuthorizePage = lazy(() => import("@/routes/agent-authorize"));
const DownloadPage = lazy(() => import("@/routes/download"));
const VerifyEmailPage = lazy(() => import("@/routes/verify-email"));
const ForgotPasswordPage = lazy(() => import("@/routes/forgot-password"));
const ResetPasswordPage = lazy(() => import("@/routes/reset-password"));
const ConnectionsPage = lazy(() => import("@/routes/connections"));
const AppShell = lazy(() =>
  import("@/components/layout/app-shell").then((m) => ({ default: m.AppShell })),
);
const TableRoute = lazy(() => import("@/routes/connection/table"));
const SqlRoute = lazy(() => import("@/routes/connection/sql"));
const QueryBuilderRoute = lazy(() => import("@/routes/connection/query-builder"));
const DiffRoute = lazy(() => import("@/routes/connection/diff"));
const DictionaryRoute = lazy(() => import("@/routes/connection/dictionary"));
const SensitiveScanRoute = lazy(() => import("@/routes/connection/sensitive"));
const ErRoute = lazy(() => import("@/routes/connection/er"));
const SchemaRoute = lazy(() => import("@/routes/connection/schema"));
const AuditRoute = lazy(() => import("@/routes/connection/audit"));
const QueryHistoryRoute = lazy(() => import("@/routes/connection/query-history"));
const DbHealthRoute = lazy(() => import("@/routes/connection/db-health"));
const ReviewRequestsRoute = lazy(() => import("@/routes/connection/review-requests"));
const RowFiltersRoute = lazy(() => import("@/routes/connection/row-filters"));
const SchemaDocsRoute = lazy(() => import("@/routes/connection/schema-docs"));
const AiChatRoute = lazy(() => import("@/routes/connection/ai-chat"));
const MigrationBuilderRoute = lazy(() => import("@/routes/connection/migration-builder"));
const SavedRoute = lazy(() => import("@/routes/connection/saved"));
const PermissionsRoute = lazy(() => import("@/routes/connection/permissions"));
const DbUsersRoute = lazy(() => import("@/routes/connection/db-users"));
const BackupRoute = lazy(() => import("@/routes/connection/backup"));
const SlowQueriesRoute = lazy(() => import("@/routes/connection/slow-queries"));
const PlanRegressionsRoute = lazy(() => import("@/routes/connection/plan-regressions"));
const MigrationExportRoute = lazy(() => import("@/routes/connection/migration-export"));
const WebhooksRoute = lazy(() => import("@/routes/connection/webhooks"));
const SchedulesRoute = lazy(() => import("@/routes/schedules"));
const FederatedRoute = lazy(() => import("@/routes/federated"));
const ApiKeysRoute = lazy(() => import("@/routes/api-keys"));
const BillingRoute = lazy(() => import("@/routes/billing"));
const WorkspaceSsoRoute = lazy(() => import("@/routes/workspace-sso"));
const DashboardsListRoute = lazy(() => import("@/routes/dashboards"));
const DashboardDetailRoute = lazy(() => import("@/routes/dashboard-detail"));
const PublicDashboardRoute = lazy(() => import("@/routes/public-dashboard"));
const PublicSharedQueryRoute = lazy(() => import("@/routes/public-shared-query"));
const NotebooksListRoute = lazy(() => import("@/routes/notebooks"));
const NotebookDetailRoute = lazy(() => import("@/routes/notebook-detail"));
const StatusPage = lazy(() => import("@/routes/status"));
const SessionsRoute = lazy(() => import("@/routes/sessions"));
const LandingPage = lazy(() => import("@/routes/landing"));
const NotFoundPage = lazy(() => import("@/routes/not-found"));

function Protected({ children }: { children: React.ReactNode }) {
  const { accessToken, bootstrapping } = useAuth();
  const loc = useLocation();
  // Still restoring the session from the refresh cookie — don't bounce to
  // /login yet, just show a spinner on THIS protected route. Public pages
  // (landing/login/etc.) never hit this and render instantly.
  if (bootstrapping && !accessToken) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!accessToken) return <Navigate to="/login" replace state={{ from: loc }} />;
  return <>{children}</>;
}

// Don't fire more than once per this window when the tab regains focus.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;

export default function App() {
  const { accessToken, setAccessToken, setUser, setBootstrapping } = useAuth();
  const didBootstrap = useRef(false);
  const lastFocusRefresh = useRef(0);

  // Try to silently refresh on first load so an existing cookie restores session.
  // Guard against StrictMode's double-invoke — the refresh token rotates on
  // every call, so a second call would use an already-revoked token and 401.
  useEffect(() => {
    if (didBootstrap.current) return;
    didBootstrap.current = true;
    (async () => {
      if (accessToken) {
        setBootstrapping(false);
        return;
      }
      try {
        const r = await api.refresh();
        if (r?.accessToken) {
          setAccessToken(r.accessToken);
          lastFocusRefresh.current = Date.now();
          const user = await api.me();
          setUser(user);
          if (user.density) applyDensity(user.density);
          applyServerTheme(user.theme);
        }
      } catch {
        // no session
      } finally {
        setBootstrapping(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Silent refresh when the tab regains focus after being backgrounded for a
  // while. Prevents users from coming back to a logged-out state when their
  // access token has expired mid-background. Throttled so flipping tabs rapidly
  // doesn't rotate the refresh token constantly.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      if (!useAuth.getState().accessToken) return; // not logged in, nothing to refresh
      const now = Date.now();
      if (now - lastFocusRefresh.current < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
      lastFocusRefresh.current = now;
      try {
        const r = await api.refresh();
        if (r?.accessToken) setAccessToken(r.accessToken);
      } catch {
        // Backend rejected the cookie — axios interceptor will have cleared state.
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [setAccessToken]);

  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center bg-background text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      }
    >
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/auth/callback" element={<OAuthCallbackPage />} />
      <Route path="/agent/authorize" element={<AgentAuthorizePage />} />
      {/* Public agent download page — no auth required */}
      <Route path="/download" element={<DownloadPage />} />
      <Route path="/auth/verify" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset" element={<ResetPasswordPage />} />
      <Route
        path="/connections"
        element={
          <Protected>
            <ConnectionsPage />
          </Protected>
        }
      />
      <Route
        path="/schedules"
        element={
          <Protected>
            <SchedulesRoute />
          </Protected>
        }
      />
      <Route
        path="/federated"
        element={
          <Protected>
            <FederatedRoute />
          </Protected>
        }
      />
      <Route
        path="/api-keys"
        element={
          <Protected>
            <ApiKeysRoute />
          </Protected>
        }
      />
      <Route
        path="/billing"
        element={
          <Protected>
            <BillingRoute />
          </Protected>
        }
      />
      <Route
        path="/workspaces/:id/sso"
        element={
          <Protected>
            <WorkspaceSsoRoute />
          </Protected>
        }
      />
      <Route
        path="/dashboards"
        element={
          <Protected>
            <DashboardsListRoute />
          </Protected>
        }
      />
      <Route
        path="/dashboards/:id"
        element={
          <Protected>
            <DashboardDetailRoute />
          </Protected>
        }
      />
      {/* Public share URL — no auth required */}
      <Route path="/d/:token" element={<PublicDashboardRoute />} />
      <Route path="/q/:token" element={<PublicSharedQueryRoute />} />
      <Route path="/status" element={<StatusPage />} />
      <Route
        path="/sessions"
        element={
          <Protected>
            <SessionsRoute />
          </Protected>
        }
      />
      <Route
        path="/notebooks"
        element={
          <Protected>
            <NotebooksListRoute />
          </Protected>
        }
      />
      <Route
        path="/notebooks/:id"
        element={
          <Protected>
            <NotebookDetailRoute />
          </Protected>
        }
      />
      <Route
        path="/c/:id"
        element={
          <Protected>
            <AppShell />
          </Protected>
        }
      >
        <Route index element={<Navigate to="sql" replace />} />
        <Route path="t/:schema/:table" element={<TableRoute />} />
        <Route path="t/:schema" element={<TableRoute />} />
        <Route path="sql" element={<SqlRoute />} />
        <Route path="builder" element={<QueryBuilderRoute />} />
        <Route path="diff" element={<DiffRoute />} />
        <Route path="dictionary" element={<DictionaryRoute />} />
        <Route path="sensitive" element={<SensitiveScanRoute />} />
        <Route path="er" element={<ErRoute />} />
        <Route path="schema" element={<SchemaRoute />} />
        <Route path="audit" element={<AuditRoute />} />
        <Route path="query-history" element={<QueryHistoryRoute />} />
        <Route path="db-health" element={<DbHealthRoute />} />
        <Route path="reviews" element={<ReviewRequestsRoute />} />
        <Route path="row-filters" element={<RowFiltersRoute />} />
        <Route path="docs" element={<SchemaDocsRoute />} />
        <Route path="ai" element={<AiChatRoute />} />
        <Route path="migrate" element={<MigrationBuilderRoute />} />
        <Route path="saved" element={<SavedRoute />} />
        <Route path="permissions" element={<PermissionsRoute />} />
        <Route path="db-users" element={<DbUsersRoute />} />
        <Route path="backup" element={<BackupRoute />} />
        <Route path="slow-queries" element={<SlowQueriesRoute />} />
        <Route path="plan-regressions" element={<PlanRegressionsRoute />} />
        <Route path="migration-export" element={<MigrationExportRoute />} />
        <Route path="webhooks" element={<WebhooksRoute />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="/" element={<LandingPage />} />
      <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}
