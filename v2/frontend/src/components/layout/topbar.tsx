import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronRight, CreditCard, Eye, EyeOff, KeyRound, Loader2, LogOut, Menu, Radio, RefreshCw, Search, Sparkles, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth, type Density } from "@/lib/auth-store";
import { api, extractErrorMessage } from "@/lib/api";
import { applyDensity } from "@/lib/density";
import { useRealtimeStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { useModal } from "@/components/modal-provider";
import { AnnouncementBell } from "@/components/announcements";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Connection } from "@/lib/api";

interface Props {
  connection?: Connection;
  onOpenPalette: () => void;
  crumbs: { label: string; to?: string }[];
  /** When provided, show a hamburger button that calls this (mobile-only). */
  onMenuClick?: () => void;
}

export function TopBar({ connection, onOpenPalette, crumbs, onMenuClick }: Props) {
  const { user, setUser, clear } = useAuth();
  const qc = useQueryClient();
  const [pwOpen, setPwOpen] = useState(false);
  // AI usage for the signed-in user — shown in the profile dropdown so people
  // can see their daily allowance without contacting support.
  const aiUsage = useQuery({
    queryKey: ["my-ai-usage"],
    queryFn: () => api.myAiUsage(),
    staleTime: 30_000,
    retry: false,
  });
  const nav = useNavigate();
  const modal = useModal();

  const logout = async () => {
    const ok = await modal.confirm({
      title: "Log out?",
      description: "You'll need to sign in again to continue using Query Schema.",
      confirmLabel: "Log out",
    });
    if (!ok) return;
    try {
      await api.logout();
    } catch {
      // ignore
    }
    clear();
    qc.clear();
    nav("/login");
  };

  const currentDensity: Density = user?.density ?? "MEDIUM";
  const pickDensity = async (d: Density) => {
    if (d === currentDensity) return;
    applyDensity(d);
    if (user) setUser({ ...user, density: d });
    try {
      await api.updateProfile({ density: d });
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  return (
    <header className="h-12 flex items-center justify-between px-4 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-20">
      <div className="flex items-center gap-2 min-w-0">
        {onMenuClick && (
          <Button size="icon" variant="ghost" className="h-8 w-8 md:hidden" onClick={onMenuClick} aria-label="Open menu">
            <Menu className="h-4 w-4" />
          </Button>
        )}
        {connection && (
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground truncate">
            {connection.name}
          </Link>
        )}
        <div className="hidden sm:flex items-center gap-2 min-w-0">
          {crumbs.map((c, i) => (
            <div key={i} className="flex items-center gap-2 min-w-0">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              {c.to ? (
                <Link to={c.to} className="text-sm text-muted-foreground hover:text-foreground truncate">
                  {c.label}
                </Link>
              ) : (
                <span className="text-sm text-foreground font-medium truncate">{c.label}</span>
              )}
            </div>
          ))}
        </div>
        {connection?.readOnly && (
          <span className="ml-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 uppercase tracking-wider">
            Read only
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onOpenPalette}
          className="hidden md:inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 h-8 text-xs text-muted-foreground hover:text-foreground hover:border-ring transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="ml-2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono">Ctrl K</kbd>
        </button>
        <div className="hidden md:block">
          <RealtimeIndicator />
        </div>
        <Button
          size="icon"
          variant="ghost"
          title="Refresh"
          onClick={() => {
            qc.invalidateQueries();
            toast.success("Refreshed");
          }}
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <AnnouncementBell />
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost">
              <User className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-foreground">{user?.displayName || user?.email}</div>
              <div className="text-muted-foreground text-[11px] font-normal">{user?.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {aiUsage.data && (
              <>
                <div className="px-2 py-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                    <span className="flex items-center gap-1">
                      <Sparkles className="h-3 w-3" /> AI calls today
                    </span>
                    <span className="tabular-nums">
                      {aiUsage.data.used}/{aiUsage.data.allowance}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        aiUsage.data.used >= aiUsage.data.allowance
                          ? "bg-destructive"
                          : "bg-primary",
                      )}
                      style={{
                        width: `${Math.min(100, aiUsage.data.allowance ? (aiUsage.data.used / aiUsage.data.allowance) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                  {aiUsage.data.used >= aiUsage.data.allowance && (
                    <div className="text-[10px] text-destructive mt-1">
                      Daily limit reached — resets at midnight UTC.
                    </div>
                  )}
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem asChild>
              <Link to="/connections">All connections</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/billing">
                <CreditCard className="h-3.5 w-3.5" /> Billing &amp; plan
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">Density</DropdownMenuLabel>
            {(["SMALL", "MEDIUM", "LARGE"] as const).map((d) => (
              <DropdownMenuItem key={d} onSelect={() => pickDensity(d)} className="justify-between">
                <span className="capitalize">{d.toLowerCase()}</span>
                {currentDensity === d && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPwOpen(true)}>
              <KeyRound className="h-3.5 w-3.5" /> Change password
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={logout} className="text-destructive focus:text-destructive">
              <LogOut className="h-3.5 w-3.5" /> Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
    </header>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="relative">
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className="pr-9"
          required
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          tabIndex={-1}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error("New passwords don't match");
      return;
    }
    if (next.length < 12) {
      toast.error("New password must be at least 12 characters");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      toast.success("Password changed — other sessions have been signed out");
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Change password
          </DialogTitle>
          <DialogDescription>
            Enter your current password and a new one. Your other active sessions will be signed out.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <PasswordField
            label="Current password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <PasswordField
            label="New password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            placeholder="At least 12 characters"
          />
          <PasswordField
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Change password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RealtimeIndicator() {
  const status = useRealtimeStatus();
  const dot = cn(
    "h-1.5 w-1.5 rounded-full",
    status === "connected" && "bg-emerald-400",
    status === "connecting" && "bg-amber-400 animate-pulse",
    status === "error" && "bg-destructive",
    status === "idle" && "bg-muted-foreground/40",
  );
  const label =
    status === "connected"
      ? "Realtime"
      : status === "connecting"
      ? "Connecting…"
      : status === "error"
      ? "Realtime offline"
      : "Realtime";
  return (
    <div
      className="flex items-center gap-1.5 px-2 text-[10px] text-muted-foreground"
      title={`WebSocket ${status}`}
    >
      <Radio className="h-3 w-3 text-muted-foreground" />
      <span className={dot} />
      <span>{label}</span>
    </div>
  );
}
