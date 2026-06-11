import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2, ShieldCheck, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { OAuthButtons } from "@/components/oauth-buttons";

export default function LoginPage() {
  const nav = useNavigate();
  const { setAuth } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [loading, setLoading] = useState(false);
  // When the server says the email isn't verified, the login form shows a
  // "Resend verification email" link next to the error instead of just toasting.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  // Inline approval-related banners surfaced either from a fresh signup
  // (router state) or from a login attempt against a pending / rejected
  // account.
  const loc = useLocation();
  const [approvalBanner, setApprovalBanner] = useState<
    | null
    | { kind: 'awaiting'; email?: string }
    | { kind: 'pending' }
    | { kind: 'rejected'; message: string }
    | { kind: 'suspended'; message: string }
  >(() => {
    const s = (loc.state ?? {}) as { awaitingApproval?: boolean; email?: string };
    return s.awaitingApproval ? { kind: 'awaiting', email: s.email } : null;
  });
  // Workspace slug from ?ws= — when present and SSO is configured for that
  // workspace, show a "Sign in with SSO" button that short-circuits the form.
  const wsSlug = sp.get("ws") ?? null;
  const [ssoAvailable, setSsoAvailable] = useState(false);

  useEffect(() => {
    if (sp.get("error") === "oauth_failed") {
      toast.error("Sign-in with that provider failed");
      sp.delete("error");
      setSp(sp, { replace: true });
    } else if (sp.get("error") === "sso") {
      const detail = sp.get("detail");
      toast.error(`SSO sign-in failed${detail ? `: ${detail}` : ""}`);
      sp.delete("error");
      sp.delete("detail");
      setSp(sp, { replace: true });
    }
  }, [sp, setSp]);

  useEffect(() => {
    if (!wsSlug) return;
    api
      .ssoAvailable(wsSlug)
      .then((r) => setSsoAvailable(r.available))
      .catch(() => setSsoAvailable(false));
  }, [wsSlug]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await api.login({ email, password, totpCode: needsTotp ? totpCode : undefined });
      setAuth(r.accessToken, r.user);
      toast.success(`Welcome ${r.user.displayName || r.user.email}`);
      nav("/connections");
    } catch (err: any) {
      const data = err?.response?.data;
      // Server returns either a flat { code, message } or { message: { code, message } }
      // depending on which NestJS exception filter ran. Normalise.
      const code = data?.code ?? data?.message?.code;
      const msg = data?.message?.message ?? data?.message ?? '';
      if (data?.needsTotp) {
        setNeedsTotp(true);
        toast.info("Two-factor code required");
      } else if (code === "EMAIL_NOT_VERIFIED") {
        setUnverifiedEmail(email);
      } else if (code === "ACCOUNT_PENDING") {
        setApprovalBanner({ kind: 'pending' });
      } else if (code === "ACCOUNT_REJECTED") {
        setApprovalBanner({ kind: 'rejected', message: String(msg) });
      } else if (code === "ACCOUNT_SUSPENDED") {
        setApprovalBanner({ kind: 'suspended', message: String(msg) });
      } else {
        toast.error(extractErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (!unverifiedEmail) return;
    setResending(true);
    try {
      await api.resendVerification(unverifiedEmail);
      toast.success("If the email is registered, a new verification link has been sent.");
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <Link
            to="/"
            aria-label="DB Studio home"
            className="h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors"
          >
            <Database className="h-6 w-6 text-primary" />
          </Link>
          <h1 className="text-xl font-semibold">Sign in to DB Studio</h1>
          <p className="text-sm text-muted-foreground mt-1">Welcome back</p>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6">
          {approvalBanner && (
            <div
              className={
                approvalBanner.kind === 'rejected' || approvalBanner.kind === 'suspended'
                  ? "mb-4 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
                  : "mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
              }
            >
              {approvalBanner.kind === 'awaiting' && (
                <>
                  <div className="font-medium mb-1">Thanks for signing up</div>
                  <div className="text-muted-foreground">
                    Your account{approvalBanner.email ? ` (${approvalBanner.email})` : ''} is now
                    awaiting admin approval. You'll be able to sign in once it's reviewed.
                  </div>
                </>
              )}
              {approvalBanner.kind === 'pending' && (
                <>
                  <div className="font-medium mb-1">Awaiting approval</div>
                  <div className="text-muted-foreground">
                    Your account hasn't been approved yet. Hang tight — an admin will get to it
                    soon.
                  </div>
                </>
              )}
              {approvalBanner.kind === 'rejected' && (
                <>
                  <div className="font-medium mb-1">Account not approved</div>
                  <div>{approvalBanner.message || 'An admin rejected your account.'}</div>
                </>
              )}
              {approvalBanner.kind === 'suspended' && (
                <>
                  <div className="font-medium mb-1">Account suspended</div>
                  <div>{approvalBanner.message || 'Your account has been suspended.'}</div>
                </>
              )}
            </div>
          )}
          {unverifiedEmail && (
            <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              <div className="font-medium mb-1">Verify your email first</div>
              <div className="text-muted-foreground">
                We sent a link to <span className="font-mono">{unverifiedEmail}</span>. Click it
                before signing in.
              </div>
              <button
                type="button"
                onClick={resend}
                disabled={resending}
                className="mt-2 underline hover:text-foreground disabled:opacity-50"
              >
                {resending ? "Sending…" : "Resend verification email"}
              </button>
            </div>
          )}
          {ssoAvailable && wsSlug && (
            <div className="mb-4">
              <a
                href={api.ssoStartUrl(wsSlug)}
                className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background hover:bg-accent text-sm py-2.5 font-medium"
              >
                <ShieldCheck className="h-4 w-4" />
                Sign in with SSO ({wsSlug})
              </a>
              <div className="relative my-3">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                  <span className="bg-card px-2 text-muted-foreground">or sign in with password</span>
                </div>
              </div>
            </div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Password</Label>
                <Link
                  to="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Forgot?
                </Link>
              </div>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            {needsTotp && (
              <div className="space-y-1.5">
                <Label>2FA Code</Label>
                <Input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  className="font-mono tracking-widest"
                />
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Sign in
            </Button>
          </form>
          <OAuthButtons />
        </div>
        <p className="text-center text-sm text-muted-foreground mt-4">
          No account?{" "}
          <Link to="/signup" className="text-primary hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
