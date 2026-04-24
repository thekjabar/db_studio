import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronRight, LogOut, Menu, Radio, RefreshCw, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { useQueryClient } from "@tanstack/react-query";
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
  const nav = useNavigate();
  const modal = useModal();

  const logout = async () => {
    const ok = await modal.confirm({
      title: "Log out?",
      description: "You'll need to sign in again to continue using DB Studio.",
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
            <DropdownMenuItem asChild>
              <Link to="/connections">All connections</Link>
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
            <DropdownMenuItem onSelect={logout} className="text-destructive focus:text-destructive">
              <LogOut className="h-3.5 w-3.5" /> Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
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
