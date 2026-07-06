import { useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";

/** Only loopback callback URLs are allowed. The agent runs a local HTTP server
 *  on 127.0.0.1 / localhost, so any other host means someone is trying to
 *  redirect the pairing token off-machine — reject it. */
function isLoopbackCallback(url: string): boolean {
  return url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
}

/** Chrome — matches the login page's layout so the flow feels native. */
function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-center">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">{subtitle}</p>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6 space-y-4">
          {children}
        </div>
      </div>
    </div>
  );
}

export default function AgentAuthorizePage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { accessToken, bootstrapping } = useAuth();

  const callback = sp.get("callback") ?? "";
  const state = sp.get("state") ?? "";
  const name = sp.get("name") ?? "";
  const displayName = name || "this machine";

  const [pairing, setPairing] = useState(false);
  const [done, setDone] = useState<null | "paired" | "cancelled">(null);

  // Validate the request up front. Order matters: missing params first, then
  // the security check on the callback host.
  const validationError = useMemo(() => {
    if (!callback || !state) {
      return "This authorization link is missing required information. Restart the agent and try again.";
    }
    if (!isLoopbackCallback(callback)) {
      return "This authorization link points to a non-local address and was blocked for your safety. The agent must run on your own machine.";
    }
    return null;
  }, [callback, state]);

  // Still restoring the session — hold off on the redirect-to-login decision so
  // a logged-in user with only a refresh cookie isn't bounced unnecessarily.
  if (bootstrapping && !accessToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  // Not logged in → send to login with a redirect back to this exact URL
  // (path + query), so after sign-in the user lands right back on this page.
  if (!accessToken) {
    const here = `${window.location.pathname}${window.location.search}`;
    return <Navigate to={`/login?redirect=${encodeURIComponent(here)}`} replace />;
  }

  if (validationError) {
    return (
      <Shell title="Authorization blocked" subtitle="Something looks off">
        <div className="flex flex-col items-center text-center gap-2">
          <div className="h-10 w-10 rounded-full border bg-destructive/15 border-destructive/30 text-destructive flex items-center justify-center">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <p className="text-xs text-muted-foreground">{validationError}</p>
        </div>
        <Button variant="outline" className="w-full" onClick={() => nav("/")}>
          Go to DB Studio
        </Button>
      </Shell>
    );
  }

  if (done === "paired") {
    return (
      <Shell title="Agent paired" subtitle="You're all set">
        <p className="text-xs text-muted-foreground text-center">
          You can return to the agent now — it will finish connecting on its own.
          This tab can be closed.
        </p>
      </Shell>
    );
  }

  if (done === "cancelled") {
    return (
      <Shell title="Authorization cancelled" subtitle="No changes were made">
        <p className="text-xs text-muted-foreground text-center">
          The agent was not authorized. You can close this tab.
        </p>
        <Button variant="outline" className="w-full" onClick={() => nav("/")}>
          Go to DB Studio
        </Button>
      </Shell>
    );
  }

  const onAllow = async () => {
    setPairing(true);
    try {
      const { token } = await api.authorizeAgent({ name, state });
      // Show the "paired" fallback state before navigating, in case the
      // loopback server is slow to render its own success page.
      setDone("paired");
      // TOP-LEVEL browser navigation (NOT fetch/axios) so it hits the agent's
      // loopback server directly without CORS. callback is verified loopback.
      const target = `${callback}?token=${encodeURIComponent(token)}&state=${encodeURIComponent(
        state,
      )}`;
      window.location.assign(target);
    } catch (err) {
      setPairing(false);
      toast.error(extractErrorMessage(err));
    }
  };

  const onCancel = () => setDone("cancelled");

  return (
    <Shell title="Authorize local agent" subtitle="Connect an agent to DB Studio">
      <div className="flex flex-col items-center text-center gap-2">
        <div className="h-10 w-10 rounded-full border bg-primary/15 border-primary/30 text-primary flex items-center justify-center">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <p className="text-sm text-muted-foreground">
          Allow the agent on{" "}
          <span className="font-mono font-medium text-foreground">{displayName}</span>{" "}
          to connect to your databases through DB Studio? Only do this for an
          agent you started yourself.
        </p>
      </div>
      <div className="flex flex-col gap-2 pt-2">
        <Button className="w-full" onClick={onAllow} disabled={pairing}>
          {pairing && <Loader2 className="h-4 w-4 animate-spin" />}
          {pairing ? "Pairing…" : "Allow"}
        </Button>
        <Button variant="outline" className="w-full" onClick={onCancel} disabled={pairing}>
          Cancel
        </Button>
      </div>
    </Shell>
  );
}
