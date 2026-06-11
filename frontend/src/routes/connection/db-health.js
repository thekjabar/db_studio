import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
const REFRESH_MS = 20_000;
export default function DbHealthRoute() {
    const { id } = useParams();
    const [autoRefresh, setAutoRefresh] = useState(true);
    const q = useQuery({
        queryKey: ["db-health", id],
        queryFn: () => api.dbHealthSnapshot(id),
        enabled: !!id,
        refetchInterval: autoRefresh ? REFRESH_MS : false,
    });
    // Re-render a relative "X seconds ago" every few seconds without refetching.
    const [, setTick] = useState(0);
    useEffect(() => {
        const t = setInterval(() => setTick((n) => n + 1), 2000);
        return () => clearInterval(t);
    }, []);
    const snap = q.data;
    const ageSec = useMemo(() => {
        if (!snap)
            return 0;
        return Math.max(0, Math.floor((Date.now() - new Date(snap.at).getTime()) / 1000));
    }, [snap]);
    if (q.isLoading && !snap) {
        return (_jsx("div", { className: "h-full flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    if (q.error && !snap) {
        return _jsx("div", { className: "p-6 text-destructive", children: extractErrorMessage(q.error) });
    }
    if (!snap)
        return null;
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(Activity, { className: "h-4 w-4 text-primary" }), _jsxs("div", { children: [_jsxs("div", { className: "text-sm font-semibold", children: ["Database health \u00B7 ", snap.dialect] }), _jsxs("div", { className: "text-[11px] text-muted-foreground", children: ["Snapshot ", format(new Date(snap.at), "HH:mm:ss"), " \u00B7 ", ageSec, "s ago"] })] }), _jsxs("div", { className: "ml-auto flex items-center gap-2", children: [_jsxs("button", { onClick: () => setAutoRefresh((a) => !a), className: cn("text-xs px-2 py-1 rounded border border-border", autoRefresh ? "bg-primary/10 text-primary border-primary/30" : "text-muted-foreground"), children: ["Auto-refresh: ", autoRefresh ? "on" : "off"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => q.refetch(), disabled: q.isFetching, children: [_jsx(RefreshCw, { className: cn("h-3.5 w-3.5", q.isFetching && "animate-spin") }), "Refresh"] })] })] }), _jsxs("div", { className: "p-4 space-y-4", children: [snap.metrics.length === 0 ? (_jsx("div", { className: "rounded-md border border-border bg-card p-6 text-center text-muted-foreground text-sm", children: "No health metrics available for this dialect yet." })) : (_jsx("div", { className: "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3", children: snap.metrics.map((m) => (_jsx(MetricCard, { metric: m }, m.key))) })), snap.errors.length > 0 && (_jsxs("div", { className: "rounded-md border border-amber-500/40 bg-amber-500/10 p-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400", children: [_jsx(AlertTriangle, { className: "h-3.5 w-3.5" }), " Some probes failed"] }), _jsx("ul", { className: "mt-1 text-[11px] font-mono text-amber-700/80 dark:text-amber-400/80 space-y-0.5", children: snap.errors.map((e, i) => (_jsxs("li", { children: ["\u00B7 ", e] }, i))) })] })), _jsxs("div", { children: [_jsxs("div", { className: "text-xs font-semibold mb-2 flex items-center gap-2", children: ["Long-running queries", snap.longRunning.length === 0 && (_jsxs("span", { className: "inline-flex items-center gap-1 text-muted-foreground font-normal", children: [_jsx(CheckCircle2, { className: "h-3 w-3 text-emerald-500" }), " none detected"] }))] }), snap.longRunning.length > 0 && (_jsx("div", { className: "rounded-md border border-border bg-card overflow-x-auto", children: _jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-border bg-muted/30", children: [_jsx("th", { className: "text-left px-2 py-1 font-medium", children: "PID" }), _jsx("th", { className: "text-left px-2 py-1 font-medium", children: "User" }), _jsx("th", { className: "text-left px-2 py-1 font-medium", children: "DB" }), _jsx("th", { className: "text-left px-2 py-1 font-medium", children: "Duration" }), _jsx("th", { className: "text-left px-2 py-1 font-medium", children: "State" }), _jsx("th", { className: "text-left px-2 py-1 font-medium", children: "Query" })] }) }), _jsx("tbody", { children: snap.longRunning.map((r, i) => (_jsxs("tr", { className: "border-b border-border last:border-b-0 align-top", children: [_jsx("td", { className: "px-2 py-1 font-mono", children: String(r.pid ?? "") }), _jsx("td", { className: "px-2 py-1", children: r.user ?? "—" }), _jsx("td", { className: "px-2 py-1", children: r.database ?? "—" }), _jsx("td", { className: "px-2 py-1 font-mono", children: r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "—" }), _jsxs("td", { className: "px-2 py-1", children: [r.state, r.waitEvent ? ` · ${r.waitEvent}` : ""] }), _jsx("td", { className: "px-2 py-1 font-mono text-[10px] max-w-lg", children: _jsx("code", { className: "block whitespace-pre-wrap break-all", children: r.query ?? "" }) })] }, i))) })] }) }))] })] })] }));
}
function MetricCard({ metric, }) {
    const severityClass = metric.severity === "crit"
        ? "border-destructive/50 bg-destructive/5"
        : metric.severity === "warn"
            ? "border-amber-500/40 bg-amber-500/5"
            : "border-border bg-card";
    const valueClass = metric.severity === "crit"
        ? "text-destructive"
        : metric.severity === "warn"
            ? "text-amber-600 dark:text-amber-400"
            : "";
    return (_jsxs("div", { className: cn("rounded-md border p-3", severityClass), children: [_jsx("div", { className: "text-[11px] text-muted-foreground", children: metric.label }), _jsxs("div", { className: cn("text-xl font-semibold mt-0.5", valueClass), children: [metric.value ?? "—", metric.unit && _jsx("span", { className: "text-xs font-normal ml-1", children: metric.unit })] }), metric.hint && _jsx("div", { className: "text-[10px] text-muted-foreground mt-1", children: metric.hint })] }));
}
