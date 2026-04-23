import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { applyDensity } from "@/lib/density";
import LoginPage from "@/routes/login";
import SignupPage from "@/routes/signup";
import OAuthCallbackPage from "@/routes/oauth-callback";
import ConnectionsPage from "@/routes/connections";
import { AppShell } from "@/components/layout/app-shell";
import TableRoute from "@/routes/connection/table";
import SqlRoute from "@/routes/connection/sql";
import ErRoute from "@/routes/connection/er";
import SchemaRoute from "@/routes/connection/schema";
import AuditRoute from "@/routes/connection/audit";
import SavedRoute from "@/routes/connection/saved";
import PermissionsRoute from "@/routes/connection/permissions";
import BackupRoute from "@/routes/connection/backup";
import SchedulesRoute from "@/routes/schedules";
import { Loader2 } from "lucide-react";

function Protected({ children }: { children: React.ReactNode }) {
  const { accessToken } = useAuth();
  const loc = useLocation();
  if (!accessToken) return <Navigate to="/login" replace state={{ from: loc }} />;
  return <>{children}</>;
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

  if (bootstrapping) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/auth/callback" element={<OAuthCallbackPage />} />
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
        <Route path="er" element={<ErRoute />} />
        <Route path="schema" element={<SchemaRoute />} />
        <Route path="audit" element={<AuditRoute />} />
        <Route path="saved" element={<SavedRoute />} />
        <Route path="permissions" element={<PermissionsRoute />} />
        <Route path="backup" element={<BackupRoute />} />
      </Route>
      <Route path="/" element={<Navigate to="/connections" replace />} />
      <Route path="*" element={<Navigate to="/connections" replace />} />
    </Routes>
  );
}
