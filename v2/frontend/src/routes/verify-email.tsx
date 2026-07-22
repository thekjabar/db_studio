import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Database, Loader2, XCircle } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";

export default function VerifyEmailPage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const nav = useNavigate();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [error, setError] = useState<string>("");
  // StrictMode double-invokes effects in dev — guard against the server
  // consuming the token twice and showing an "already used" error.
  const didRun = useRef(false);

  useEffect(() => {
    if (didRun.current) return;
    didRun.current = true;
    if (!token) {
      setState("error");
      setError("No verification token in the URL");
      return;
    }
    api
      .verifyEmail(token)
      .then(() => setState("ok"))
      .catch((err) => {
        setState("error");
        setError(extractErrorMessage(err));
      });
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">Verify email</h1>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6 text-center">
          {state === "loading" && (
            <>
              <Loader2 className="h-8 w-8 text-muted-foreground animate-spin mx-auto mb-3" />
              <div className="text-sm text-muted-foreground">Verifying…</div>
            </>
          )}
          {state === "ok" && (
            <>
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
              <div className="text-sm font-medium mb-3">Email verified.</div>
              <Button className="w-full" onClick={() => nav("/login", { replace: true })}>
                Sign in
              </Button>
            </>
          )}
          {state === "error" && (
            <>
              <XCircle className="h-10 w-10 text-destructive mx-auto mb-3" />
              <div className="text-sm font-medium mb-1">Couldn't verify</div>
              <div className="text-xs text-muted-foreground mb-4">{error}</div>
              <Button variant="outline" className="w-full" asChild>
                <Link to="/login">Back to login</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
