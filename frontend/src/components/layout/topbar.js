import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Link, useNavigate } from "react-router-dom";
import { Check, ChevronRight, LogOut, Menu, Radio, RefreshCw, Search, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-store";
import { api, extractErrorMessage } from "@/lib/api";
import { applyDensity } from "@/lib/density";
import { useRealtimeStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { useModal } from "@/components/modal-provider";
import { AnnouncementBell } from "@/components/announcements";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
export function TopBar({ connection, onOpenPalette, crumbs, onMenuClick }) {
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
        if (!ok)
            return;
        try {
            await api.logout();
        }
        catch {
            // ignore
        }
        clear();
        qc.clear();
        nav("/login");
    };
    const currentDensity = user?.density ?? "MEDIUM";
    const pickDensity = async (d) => {
        if (d === currentDensity)
            return;
        applyDensity(d);
        if (user)
            setUser({ ...user, density: d });
        try {
            await api.updateProfile({ density: d });
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
    };
    return (_jsxs("header", { className: "h-12 flex items-center justify-between px-4 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-20", children: [_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [onMenuClick && (_jsx(Button, { size: "icon", variant: "ghost", className: "h-8 w-8 md:hidden", onClick: onMenuClick, "aria-label": "Open menu", children: _jsx(Menu, { className: "h-4 w-4" }) })), connection && (_jsx(Link, { to: "/connections", className: "text-sm text-muted-foreground hover:text-foreground truncate", children: connection.name })), _jsx("div", { className: "hidden sm:flex items-center gap-2 min-w-0", children: crumbs.map((c, i) => (_jsxs("div", { className: "flex items-center gap-2 min-w-0", children: [_jsx(ChevronRight, { className: "h-3.5 w-3.5 text-muted-foreground shrink-0" }), c.to ? (_jsx(Link, { to: c.to, className: "text-sm text-muted-foreground hover:text-foreground truncate", children: c.label })) : (_jsx("span", { className: "text-sm text-foreground font-medium truncate", children: c.label }))] }, i))) }), connection?.readOnly && (_jsx("span", { className: "ml-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400 uppercase tracking-wider", children: "Read only" }))] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("button", { onClick: onOpenPalette, className: "hidden md:inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 h-8 text-xs text-muted-foreground hover:text-foreground hover:border-ring transition-colors", children: [_jsx(Search, { className: "h-3.5 w-3.5" }), _jsx("span", { children: "Search" }), _jsx("kbd", { className: "ml-2 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-mono", children: "Ctrl K" })] }), _jsx("div", { className: "hidden md:block", children: _jsx(RealtimeIndicator, {}) }), _jsx(Button, { size: "icon", variant: "ghost", title: "Refresh", onClick: () => {
                            qc.invalidateQueries();
                            toast.success("Refreshed");
                        }, children: _jsx(RefreshCw, { className: "h-4 w-4" }) }), _jsx(AnnouncementBell, {}), _jsx(ThemeToggle, {}), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsx(Button, { size: "icon", variant: "ghost", children: _jsx(User, { className: "h-4 w-4" }) }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-56", children: [_jsxs(DropdownMenuLabel, { children: [_jsx("div", { className: "text-foreground", children: user?.displayName || user?.email }), _jsx("div", { className: "text-muted-foreground text-[11px] font-normal", children: user?.email })] }), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuItem, { asChild: true, children: _jsx(Link, { to: "/connections", children: "All connections" }) }), _jsx(DropdownMenuSeparator, {}), _jsx(DropdownMenuLabel, { className: "text-[11px] text-muted-foreground font-normal", children: "Density" }), ["SMALL", "MEDIUM", "LARGE"].map((d) => (_jsxs(DropdownMenuItem, { onSelect: () => pickDensity(d), className: "justify-between", children: [_jsx("span", { className: "capitalize", children: d.toLowerCase() }), currentDensity === d && _jsx(Check, { className: "h-3.5 w-3.5" })] }, d))), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onSelect: logout, className: "text-destructive focus:text-destructive", children: [_jsx(LogOut, { className: "h-3.5 w-3.5" }), " Logout"] })] })] })] })] }));
}
function RealtimeIndicator() {
    const status = useRealtimeStatus();
    const dot = cn("h-1.5 w-1.5 rounded-full", status === "connected" && "bg-emerald-400", status === "connecting" && "bg-amber-400 animate-pulse", status === "error" && "bg-destructive", status === "idle" && "bg-muted-foreground/40");
    const label = status === "connected"
        ? "Realtime"
        : status === "connecting"
            ? "Connecting…"
            : status === "error"
                ? "Realtime offline"
                : "Realtime";
    return (_jsxs("div", { className: "flex items-center gap-1.5 px-2 text-[10px] text-muted-foreground", title: `WebSocket ${status}`, children: [_jsx(Radio, { className: "h-3 w-3 text-muted-foreground" }), _jsx("span", { className: dot }), _jsx("span", { children: label })] }));
}
