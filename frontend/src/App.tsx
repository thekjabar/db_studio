import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { applyDensity } from "@/lib/density";
import { applyServerTheme } from "@/lib/theme-store";
import LoginPage from "@/routes/login";
import SignupPage from "@/routes/signup";
import OAuthCallbackPage from "@/routes/oauth-callback";
import VerifyEmailPage from "@/routes/verify-email";
import ForgotPasswordPage from "@/routes/forgot-password";
import ResetPasswordPage from "@/routes/reset-password";
import ConnectionsPage from "@/routes/connections";
import { AppShell } from "@/components/layout/app-shell";
import TableRoute from "@/routes/connection/table";
import SqlRoute from "@/routes/connection/sql";
import QueryBuilderRoute from "@/routes/connection/query-builder";
import DiffRoute from "@/routes/connection/diff";
import DictionaryRoute from "@/routes/connection/dictionary";
import SensitiveScanRoute from "@/routes/connection/sensitive";
import ErRoute from "@/routes/connection/er";
import SchemaRoute from "@/routes/connection/schema";
import AuditRoute from "@/routes/connection/audit";
import QueryHistoryRoute from "@/routes/connection/query-history";
import DbHealthRoute from "@/routes/connection/db-health";
import ReviewRequestsRoute from "@/routes/connection/review-requests";
import RowFiltersRoute from "@/routes/connection/row-filters";
import SchemaDocsRoute from "@/routes/connection/schema-docs";
import AiChatRoute from "@/routes/connection/ai-chat";
import MigrationBuilderRoute from "@/routes/connection/migration-builder";
import SavedRoute from "@/routes/connection/saved";
import PermissionsRoute from "@/routes/connection/permissions";
import DbUsersRoute from "@/routes/connection/db-users";
import BackupRoute from "@/routes/connection/backup";
import SlowQueriesRoute from "@/routes/connection/slow-queries";
import PlanRegressionsRoute from "@/routes/connection/plan-regressions";
import MigrationExportRoute from "@/routes/connection/migration-export";
import WebhooksRoute from "@/routes/connection/webhooks";
import SchedulesRoute from "@/routes/schedules";
import FederatedRoute from "@/routes/federated";
import ApiKeysRoute from "@/routes/api-keys";
import WorkspaceSsoRoute from "@/routes/workspace-sso";
import DashboardsListRoute from "@/routes/dashboards";
import DashboardDetailRoute from "@/routes/dashboard-detail";
import PublicDashboardRoute from "@/routes/public-dashboard";
import PublicSharedQueryRoute from "@/routes/public-shared-query";
import NotebooksListRoute from "@/routes/notebooks";
import NotebookDetailRoute from "@/routes/notebook-detail";
import StatusPage from "@/routes/status";
import SessionsRoute from "@/routes/sessions";
import LandingPage from "@/routes/landing";
import NotFoundPage from "@/routes/not-found";
import { Loader2 } from "lucide-react";

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
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/auth/callback" element={<OAuthCallbackPage />} />
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
  );
}
