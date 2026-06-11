import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X, AlertTriangle, Info, AlertOctagon } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
/**
 * Shared hook — both `AnnouncementBanner` (top-of-viewport strip) and
 * `AnnouncementBell` (dropdown button for the topbar) read from the same
 * 60-second polling query, so only one HTTP call fires per minute.
 */
function useAnnouncements() {
    const qc = useQueryClient();
    const q = useQuery({
        queryKey: ["announcements-active"],
        queryFn: () => api.activeAnnouncements(),
        refetchInterval: 60_000,
    });
    const dismiss = useMutation({
        mutationFn: (id) => api.dismissAnnouncement(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-active"] }),
    });
    const markSeen = useMutation({
        mutationFn: (id) => api.markAnnouncementSeen(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-active"] }),
    });
    return { list: q.data ?? [], dismiss, markSeen };
}
export function AnnouncementBanner() {
    const { list, dismiss } = useAnnouncements();
    const banner = useMemo(() => {
        const undismissed = list.filter((a) => !a.dismissedAt);
        const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
        return undismissed.sort((a, b) => order[a.severity] - order[b.severity])[0] ?? null;
    }, [list]);
    if (!banner)
        return null;
    return _jsx(Banner, { a: banner, onDismiss: () => dismiss.mutate(banner.id) });
}
export function AnnouncementBell() {
    const { list, markSeen } = useAnnouncements();
    const unread = list.filter((a) => !a.seen).length;
    return (_jsx(Bellbox, { items: list, unread: unread, onOpen: () => {
            for (const a of list) {
                if (!a.seen)
                    markSeen.mutate(a.id);
            }
        } }));
}
function Banner({ a, onDismiss }) {
    const Icon = a.severity === "CRITICAL" ? AlertOctagon : a.severity === "WARNING" ? AlertTriangle : Info;
    return (_jsxs("div", { className: cn("w-full px-4 py-2 flex items-center gap-3 text-sm", a.severity === "CRITICAL" && "bg-destructive text-destructive-foreground", a.severity === "WARNING" && "bg-amber-500/15 text-amber-400 border-b border-amber-500/30", a.severity === "INFO" && "bg-primary/15 text-primary border-b border-primary/30"), children: [_jsx(Icon, { className: "h-4 w-4 shrink-0" }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("span", { className: "font-semibold", children: a.title }), _jsx("span", { className: "mx-2 opacity-60", children: "\u00B7" }), _jsx("span", { className: "opacity-90", children: a.body })] }), _jsx("button", { onClick: onDismiss, className: "opacity-70 hover:opacity-100 shrink-0", "aria-label": "Dismiss", children: _jsx(X, { className: "h-4 w-4" }) })] }));
}
function Bellbox({ items, unread, onOpen, }) {
    return (_jsxs(DropdownMenu, { onOpenChange: (o) => o && onOpen(), children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: "icon", variant: "ghost", title: "Announcements", className: "relative", children: [_jsx(Bell, { className: "h-4 w-4" }), unread > 0 && (_jsx("span", { className: "absolute top-1 right-1 h-2 w-2 rounded-full bg-destructive" }))] }) }), _jsxs(DropdownMenuContent, { align: "end", className: "w-80 p-0", children: [_jsx("div", { className: "p-3 border-b border-border", children: _jsx("div", { className: "text-xs uppercase tracking-wide text-muted-foreground", children: "Announcements" }) }), _jsx("div", { className: "max-h-96 overflow-auto", children: items.length === 0 ? (_jsx("div", { className: "p-4 text-sm text-muted-foreground text-center", children: "Nothing new." })) : (_jsx("ul", { className: "divide-y divide-border", children: items.map((a) => (_jsxs("li", { className: "p-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-sm font-medium", children: a.title }), _jsx("span", { className: cn("text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide", a.severity === "CRITICAL" && "bg-destructive/15 text-destructive", a.severity === "WARNING" && "bg-amber-500/15 text-amber-500", a.severity === "INFO" && "bg-primary/15 text-primary"), children: a.severity })] }), _jsx("p", { className: "text-xs text-muted-foreground mt-1 whitespace-pre-wrap", children: a.body }), _jsx("div", { className: "text-[10px] text-muted-foreground mt-1", children: new Date(a.startsAt).toLocaleString() })] }, a.id))) })) })] })] }));
}
