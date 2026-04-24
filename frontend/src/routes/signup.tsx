import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { OAuthButtons } from "@/components/oauth-buttons";

export default function SignupPage() {
  const nav = useNavigate();
  const { setAuth } = useAuth();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const r = await api.signup({ email, password, displayName: displayName || undefined });
      if ("needsVerification" in r && r.needsVerification) {
        toast.success(`We sent a verification link to ${email}. Click it to finish.`);
        nav("/login", { replace: true, state: { justSignedUp: true } });
        return;
      }
      if ("accessToken" in r) {
        setAuth(r.accessToken, r.user);
        toast.success("Account created");
        nav("/connections");
      }
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
          <h1 className="text-xl font-semibold">Create account</h1>
          <p className="text-sm text-muted-foreground mt-1">Get started with DB Studio</p>
        </div>
        <div className="rounded-lg border border-border bg-card shadow-xl p-6">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Display name</Label>
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Doe" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <PasswordInput
                value={password}
                onChange={setPassword}
                show={showPassword}
                onToggle={() => setShowPassword((v) => !v)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Confirm password</Label>
              <PasswordInput
                value={confirm}
                onChange={setConfirm}
                show={showConfirm}
                onToggle={() => setShowConfirm((v) => !v)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Create account
            </Button>
          </form>
          <OAuthButtons />
        </div>
        <p className="text-center text-sm text-muted-foreground mt-4">
          Already have an account?{" "}
          <Link to="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  show,
  onToggle,
}: {
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-9"
      />
      <button
        type="button"
        onClick={onToggle}
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
