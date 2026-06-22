import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, ArrowRight, GitCompareArrows, Loader2, TrendingDown } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
const WINDOWS = [
    { value: 24, label: "Last 24h" },
    { value: 168, label: "Last 7d" },
    { value: 720, label: "Last 30d" },
    { value: 2160, label: "Last 90d" },
];
export default function PlanRegressionsRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(Inner, { connectionId: id });
}
function Inner({ connectionId }) {
    const [hours, setHours] = useState(168);
    const [expanded, setExpanded] = useState(null);
    const regressionsQ = useQuery({
        queryKey: ["plan-regressions", connectionId, hours],
        queryFn: () => api.planRegressions(connectionId, hours, 100),
        refetchInterval: 60_000,
    });
    const items = regressionsQ.data ?? [];
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-6xl mx-auto", children: [_jsxs("div", { className: "flex items-start justify-between gap-4 flex-wrap", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-lg font-semibold flex items-center gap-2", children: [_jsx(TrendingDown, { className: "h-5 w-5" }), " Plan regressions"] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1 max-w-2xl", children: "When a query's SQL stays the same but the planner silently switches strategy \u2014 an index scan becoming a sequential scan, or a join flipping to a nested loop \u2014 that's the usual cause of a query that \"suddenly got slow.\" We capture each query's plan structure over time and flag these structural downgrades here." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Select, { value: String(hours), onValueChange: (v) => setHours(parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "w-40", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: WINDOWS.map((w) => (_jsx(SelectItem, { value: String(w.value), children: w.label }, w.value))) })] }), _jsx(Button, { variant: "outline", size: "sm", onClick: () => regressionsQ.refetch(), disabled: regressionsQ.isFetching, children: regressionsQ.isFetching ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : "Refresh" })] })] }), regressionsQ.isLoading ? (_jsx("div", { className: "flex items-center justify-center py-16 text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) })) : items.length === 0 ? (_jsxs("div", { className: "rounded-md border border-dashed border-border p-12 text-center", children: [_jsx(Activity, { className: "h-8 w-8 text-emerald-500 mx-auto mb-3" }), _jsx("div", { className: "text-sm font-medium", children: "No plan regressions detected" }), _jsx("div", { className: "text-xs text-muted-foreground mt-1 max-w-md mx-auto", children: "Plans are captured automatically as SELECTs run. As soon as a query's plan structure degrades vs its previous capture, it shows up here." })] })) : (_jsx("div", { className: "space-y-3", children: items.map((s) => (_jsx(RegressionCard, { connectionId: connectionId, snap: s, open: expanded === s.id, onToggle: () => setExpanded(expanded === s.id ? null : s.id) }, s.id))) }))] }));
}
function RegressionCard({ connectionId, snap, open, onToggle, }) {
    const historyQ = useQuery({
        queryKey: ["plan-history", connectionId, snap.shapeHash],
        queryFn: () => api.planHistory(connectionId, snap.shapeHash, 20),
        enabled: open,
    });
    // The capture immediately before this one is the "from" side of the diff.
    const history = historyQ.data ?? [];
    const idx = history.findIndex((h) => h.id === snap.id);
    const prev = idx >= 0 && idx + 1 < history.length ? history[idx + 1] : null;
    const diffQ = useQuery({
        queryKey: ["plan-diff", connectionId, prev?.id, snap.id],
        queryFn: () => api.planDiff(connectionId, prev.id, snap.id),
        enabled: open && !!prev,
    });
    return (_jsxs("div", { className: "rounded-md border border-amber-500/30 bg-amber-500/[0.03] overflow-hidden", children: [_jsxs("button", { onClick: onToggle, className: "w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-amber-500/[0.06]", children: [_jsx(TrendingDown, { className: "h-4 w-4 text-amber-500 mt-0.5 shrink-0" }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx(Badge, { variant: "destructive", className: "text-[10px]", children: "regression" }), _jsx("span", { className: "text-xs text-muted-foreground", children: formatDistanceToNow(new Date(snap.createdAt), { addSuffix: true }) }), snap.totalCost != null && (_jsxs("span", { className: "text-[11px] font-mono text-muted-foreground", children: ["cost ", snap.totalCost.toFixed(0)] }))] }), _jsx("div", { className: "text-sm font-medium mt-1 text-amber-700 dark:text-amber-400", children: snap.regressionNote ?? "Plan structure changed" }), _jsx("pre", { className: "text-[11px] font-mono text-muted-foreground mt-1.5 whitespace-pre-wrap line-clamp-2", children: snap.normalizedSql })] })] }), open && (_jsxs("div", { className: "border-t border-amber-500/20 px-4 py-3 space-y-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2", children: "Current plan" }), _jsx(ScanList, { scans: snap.scans })] }), prev && diffQ.data && (_jsxs("div", { children: [_jsxs("div", { className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2", children: [_jsx(GitCompareArrows, { className: "h-3.5 w-3.5" }), " What changed"] }), _jsxs("div", { className: "grid grid-cols-[1fr_auto_1fr] gap-3 items-center", children: [_jsxs("div", { className: "rounded border border-border p-2 bg-background", children: [_jsxs("div", { className: "text-[10px] text-muted-foreground mb-1", children: ["before \u00B7 ", formatDistanceToNow(new Date(diffQ.data.from.createdAt), { addSuffix: true })] }), _jsx(ScanList, { scans: diffQ.data.from.scans, compact: true })] }), _jsx(ArrowRight, { className: "h-4 w-4 text-amber-500" }), _jsxs("div", { className: "rounded border border-amber-500/40 p-2 bg-amber-500/[0.04]", children: [_jsx("div", { className: "text-[10px] text-muted-foreground mb-1", children: "after \u00B7 now" }), _jsx(ScanList, { scans: diffQ.data.to.scans, compact: true })] })] }), diffQ.data.costDeltaRatio != null && diffQ.data.costDeltaRatio > 1 && (_jsxs("div", { className: "text-xs text-amber-600 dark:text-amber-400 mt-2", children: ["Planner cost rose ", diffQ.data.costDeltaRatio.toFixed(1), "\u00D7 vs the previous plan."] }))] })), historyQ.isLoading && (_jsxs("div", { className: "text-xs text-muted-foreground flex items-center gap-2", children: [_jsx(Loader2, { className: "h-3 w-3 animate-spin" }), " Loading history\u2026"] }))] }))] }));
}
function ScanList({ scans, compact }) {
    if (scans.length === 0)
        return _jsx("span", { className: "text-xs text-muted-foreground", children: "(no scans)" });
    const bad = (t) => /Seq Scan/i.test(t) || t === "ALL" || t === "Nested Loop";
    return (_jsx("div", { className: cn("flex flex-wrap gap-1.5", compact && "gap-1"), children: scans.map((s, i) => (_jsxs("span", { className: cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono border", bad(s.nodeType)
                ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                : "border-border bg-muted text-muted-foreground"), children: [s.nodeType, s.relation && _jsxs("span", { className: "opacity-60", children: ["\u00B7 ", s.relation] })] }, i))) }));
}
