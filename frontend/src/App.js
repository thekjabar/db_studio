import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
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
import BackupRoute from "@/routes/connection/backup";
import SlowQueriesRoute from "@/routes/connection/slow-queries";
import MigrationExportRoute from "@/routes/connection/migration-export";
import WebhooksRoute from "@/routes/connection/webhooks";
import SchedulesRoute from "@/routes/schedules";
import FederatedRoute from "@/routes/federated";
import ApiKeysRoute from "@/routes/api-keys";
import WorkspaceSsoRoute from "@/routes/workspace-sso";
import AdminRoute from "@/routes/admin";
import DashboardsListRoute from "@/routes/dashboards";
import DashboardDetailRoute from "@/routes/dashboard-detail";
import PublicDashboardRoute from "@/routes/public-dashboard";
import NotebooksListRoute from "@/routes/notebooks";
import NotebookDetailRoute from "@/routes/notebook-detail";
import StatusPage from "@/routes/status";
import SessionsRoute from "@/routes/sessions";
import LandingPage from "@/routes/landing";
import NotFoundPage from "@/routes/not-found";
import { Loader2 } from "lucide-react";
function Protected({ children }) {
    const { accessToken } = useAuth();
    const loc = useLocation();
    if (!accessToken)
        return _jsx(Navigate, { to: "/login", replace: true, state: { from: loc } });
    return _jsx(_Fragment, { children: children });
}
// Don't fire more than once per this window when the tab regains focus.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 5 * 60_000;
export default function App() {
    const [bootstrapping, setBootstrapping] = useState(true);
    const { accessToken, setAccessToken, setUser } = useAuth();
    const didBootstrap = useRef(false);
    const lastFocusRefresh = useRef(0);
    // Try to silently refresh on first load so an existing cookie restores session.
    // Guard against StrictMode's double-invoke — the refresh token rotates on
    // every call, so a second call would use an already-revoked token and 401.
    useEffect(() => {
        if (didBootstrap.current)
            return;
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
                    if (user.density)
                        applyDensity(user.density);
                    applyServerTheme(user.theme);
                }
            }
            catch {
                // no session
            }
            finally {
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
            if (document.visibilityState !== "visible")
                return;
            if (!useAuth.getState().accessToken)
                return; // not logged in, nothing to refresh
            const now = Date.now();
            if (now - lastFocusRefresh.current < FOCUS_REFRESH_MIN_INTERVAL_MS)
                return;
            lastFocusRefresh.current = now;
            try {
                const r = await api.refresh();
                if (r?.accessToken)
                    setAccessToken(r.accessToken);
            }
            catch {
                // Backend rejected the cookie — axios interceptor will have cleared state.
            }
        };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, [setAccessToken]);
    if (bootstrapping) {
        return (_jsx("div", { className: "h-screen w-screen flex items-center justify-center bg-background text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginPage, {}) }), _jsx(Route, { path: "/signup", element: _jsx(SignupPage, {}) }), _jsx(Route, { path: "/auth/callback", element: _jsx(OAuthCallbackPage, {}) }), _jsx(Route, { path: "/auth/verify", element: _jsx(VerifyEmailPage, {}) }), _jsx(Route, { path: "/forgot-password", element: _jsx(ForgotPasswordPage, {}) }), _jsx(Route, { path: "/auth/reset", element: _jsx(ResetPasswordPage, {}) }), _jsx(Route, { path: "/connections", element: _jsx(Protected, { children: _jsx(ConnectionsPage, {}) }) }), _jsx(Route, { path: "/schedules", element: _jsx(Protected, { children: _jsx(SchedulesRoute, {}) }) }), _jsx(Route, { path: "/federated", element: _jsx(Protected, { children: _jsx(FederatedRoute, {}) }) }), _jsx(Route, { path: "/api-keys", element: _jsx(Protected, { children: _jsx(ApiKeysRoute, {}) }) }), _jsx(Route, { path: "/workspaces/:id/sso", element: _jsx(Protected, { children: _jsx(WorkspaceSsoRoute, {}) }) }), _jsx(Route, { path: "/admin", element: _jsx(Protected, { children: _jsx(AdminRoute, {}) }) }), _jsx(Route, { path: "/dashboards", element: _jsx(Protected, { children: _jsx(DashboardsListRoute, {}) }) }), _jsx(Route, { path: "/dashboards/:id", element: _jsx(Protected, { children: _jsx(DashboardDetailRoute, {}) }) }), _jsx(Route, { path: "/d/:token", element: _jsx(PublicDashboardRoute, {}) }), _jsx(Route, { path: "/status", element: _jsx(StatusPage, {}) }), _jsx(Route, { path: "/sessions", element: _jsx(Protected, { children: _jsx(SessionsRoute, {}) }) }), _jsx(Route, { path: "/notebooks", element: _jsx(Protected, { children: _jsx(NotebooksListRoute, {}) }) }), _jsx(Route, { path: "/notebooks/:id", element: _jsx(Protected, { children: _jsx(NotebookDetailRoute, {}) }) }), _jsxs(Route, { path: "/c/:id", element: _jsx(Protected, { children: _jsx(AppShell, {}) }), children: [_jsx(Route, { index: true, element: _jsx(Navigate, { to: "sql", replace: true }) }), _jsx(Route, { path: "t/:schema/:table", element: _jsx(TableRoute, {}) }), _jsx(Route, { path: "t/:schema", element: _jsx(TableRoute, {}) }), _jsx(Route, { path: "sql", element: _jsx(SqlRoute, {}) }), _jsx(Route, { path: "er", element: _jsx(ErRoute, {}) }), _jsx(Route, { path: "schema", element: _jsx(SchemaRoute, {}) }), _jsx(Route, { path: "audit", element: _jsx(AuditRoute, {}) }), _jsx(Route, { path: "query-history", element: _jsx(QueryHistoryRoute, {}) }), _jsx(Route, { path: "db-health", element: _jsx(DbHealthRoute, {}) }), _jsx(Route, { path: "reviews", element: _jsx(ReviewRequestsRoute, {}) }), _jsx(Route, { path: "row-filters", element: _jsx(RowFiltersRoute, {}) }), _jsx(Route, { path: "docs", element: _jsx(SchemaDocsRoute, {}) }), _jsx(Route, { path: "ai", element: _jsx(AiChatRoute, {}) }), _jsx(Route, { path: "migrate", element: _jsx(MigrationBuilderRoute, {}) }), _jsx(Route, { path: "saved", element: _jsx(SavedRoute, {}) }), _jsx(Route, { path: "permissions", element: _jsx(PermissionsRoute, {}) }), _jsx(Route, { path: "backup", element: _jsx(BackupRoute, {}) }), _jsx(Route, { path: "slow-queries", element: _jsx(SlowQueriesRoute, {}) }), _jsx(Route, { path: "migration-export", element: _jsx(MigrationExportRoute, {}) }), _jsx(Route, { path: "webhooks", element: _jsx(WebhooksRoute, {}) }), _jsx(Route, { path: "*", element: _jsx(NotFoundPage, {}) })] }), _jsx(Route, { path: "/", element: _jsx(LandingPage, {}) }), _jsx(Route, { path: "*", element: _jsx(NotFoundPage, {}) })] }));
}
