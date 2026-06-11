import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, Database, Loader2, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
const OVERALL_UI = {
    operational: {
        label: "All systems operational",
        cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/40 dark:text-emerald-400",
        icon: _jsx(CheckCircle2, { className: "h-5 w-5" }),
    },
    degraded: {
        label: "Degraded performance",
        cls: "bg-amber-500/10 text-amber-700 border-amber-500/40 dark:text-amber-400",
        icon: _jsx(AlertTriangle, { className: "h-5 w-5" }),
    },
    outage: {
        label: "Major outage",
        cls: "bg-destructive/10 text-destructive border-destructive/40",
        icon: _jsx(XCircle, { className: "h-5 w-5" }),
    },
};
const SEV_CLS = {
    MINOR: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    MAJOR: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
    CRITICAL: "bg-destructive/10 text-destructive",
};
export default function StatusPage() {
    const q = useQuery({
        queryKey: ["public-status"],
        queryFn: () => api.publicStatus(),
        refetchInterval: 30_000,
    });
    if (q.isLoading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    if (!q.data)
        return _jsx("div", { className: "p-8 text-destructive", children: "Status unavailable" });
    const s = q.data;
    const ui = OVERALL_UI[s.overall];
    return (_jsxs("div", { className: "min-h-screen bg-background", children: [_jsxs("header", { className: "h-14 flex items-center px-6 border-b border-border bg-card/50", children: [_jsx(Database, { className: "h-5 w-5 text-primary mr-2" }), _jsx("span", { className: "font-semibold", children: "DB Studio \u00B7 Status" }), _jsxs("span", { className: "ml-auto text-[11px] text-muted-foreground", children: ["As of ", format(new Date(s.asOf), "MMM d HH:mm:ss")] })] }), _jsxs("div", { className: "max-w-3xl mx-auto px-6 py-8 space-y-6", children: [_jsxs("div", { className: cn("rounded-md border p-4 flex items-center gap-3", ui.cls), children: [ui.icon, _jsx("div", { className: "font-semibold", children: ui.label })] }), _jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold mb-2", children: "Components" }), _jsx("div", { className: "rounded-md border border-border bg-card divide-y divide-border", children: s.components.map((c) => (_jsxs("div", { className: "flex items-center gap-3 px-3 py-2 text-sm", children: [_jsx(StatusDot, { status: c.status }), _jsx("span", { className: "flex-1", children: c.name }), c.detail && _jsx("span", { className: "text-[11px] text-muted-foreground", children: c.detail })] }, c.name))) })] }), s.activeIncidents.length > 0 && (_jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold mb-2", children: "Active incidents" }), _jsx("div", { className: "space-y-3", children: s.activeIncidents.map((i) => (_jsxs("div", { className: "rounded-md border border-border bg-card p-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-sm", children: [_jsx("span", { className: cn("text-[10px] font-medium rounded px-2 py-0.5", SEV_CLS[i.severity]), children: i.severity }), _jsx("span", { className: "font-semibold", children: i.title }), _jsxs("span", { className: "ml-auto text-[11px] text-muted-foreground", children: ["Started ", format(new Date(i.startedAt), "MMM d HH:mm")] })] }), _jsx("div", { className: "mt-2 space-y-1 text-xs", children: i.updates
                                                .slice()
                                                .reverse()
                                                .map((u, idx) => (_jsxs("div", { className: "flex gap-2", children: [_jsx("span", { className: "text-muted-foreground w-28 shrink-0 font-mono", children: format(new Date(u.at), "MMM d HH:mm") }), _jsx("span", { className: "font-medium uppercase tracking-wider text-[10px] text-primary w-28 shrink-0", children: u.status }), _jsx("span", { className: "flex-1", children: u.message })] }, idx))) })] }, i.id))) })] })), _jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold mb-2", children: "Recent incidents" }), s.recentIncidents.length === 0 ? (_jsx("div", { className: "rounded-md border border-border bg-card p-4 text-sm text-muted-foreground", children: "No recent incidents." })) : (_jsx("div", { className: "rounded-md border border-border bg-card divide-y divide-border", children: s.recentIncidents.map((i) => (_jsxs("div", { className: "px-3 py-2 text-sm flex items-center gap-3", children: [_jsx("span", { className: cn("text-[10px] font-medium rounded px-2 py-0.5", SEV_CLS[i.severity]), children: i.severity }), _jsx("span", { className: "flex-1", children: i.title }), _jsxs("span", { className: "text-[11px] text-muted-foreground", children: [format(new Date(i.startedAt), "MMM d"), " \u2192", " ", format(new Date(i.resolvedAt), "MMM d")] })] }, i.id))) }))] })] })] }));
}
function StatusDot({ status }) {
    const cls = status === "ok"
        ? "bg-emerald-500"
        : status === "degraded"
            ? "bg-amber-500"
            : "bg-destructive";
    return _jsx("span", { className: cn("h-2.5 w-2.5 rounded-full", cls) });
}
