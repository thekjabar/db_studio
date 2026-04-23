import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, Database, Loader2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPasswordPage() {
  const [sp] = useSearchParams();
  const token = sp.get("token") ?? "";
  const nav = useNavigate();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    if (pw !== pw2) {
      toast.error("Passwords don't match");
      return;
    }
    setLoading(true);
    try {
      await api.completePasswordReset(token, pw);
      setDone(true);
    } catch (err) {
      toast.error(extractErrorMessage(err));
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
          <h1 className="text-xl font-semibold">Choose a new password</h1>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6">
          {!token ? (
            <div className="text-sm text-destructive">
              No reset token in the URL. Request a fresh link from the{" "}
              <Link to="/forgot-password" className="underline">
                forgot password page
              </Link>.
            </div>
          ) : done ? (
            <div className="space-y-3 text-center">
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
              <div className="text-sm font-medium">Password updated.</div>
              <Button className="w-full" onClick={() => nav("/login", { replace: true })}>
                Sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label>New password</Label>
                <Input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Confirm password</Label>
                <Input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Set new password
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
