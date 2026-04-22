import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2 } from "lucide-react";
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
  const [totpCode, setTotpCode] = useState("");
  const [needsTotp, setNeedsTotp] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sp.get("error") === "oauth_failed") {
      toast.error("Sign-in with that provider failed");
      sp.delete("error");
      setSp(sp, { replace: true });
    }
  }, [sp, setSp]);

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
      if (data?.needsTotp) {
        setNeedsTotp(true);
        toast.info("Two-factor code required");
      } else {
        toast.error(extractErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3">
            <Database className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold">Sign in to DB Studio</h1>
          <p className="text-sm text-muted-foreground mt-1">Welcome back</p>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6">
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
              <Label>Password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
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
