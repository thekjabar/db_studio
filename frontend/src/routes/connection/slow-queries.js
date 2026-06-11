import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Timer } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
const WINDOWS = [
    { value: 1, label: "Last hour" },
    { value: 24, label: "Last 24h" },
    { value: 168, label: "Last 7d" },
    { value: 720, label: "Last 30d" },
];
export default function SlowQueriesRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(SlowQueriesInner, { connectionId: id });
}
function SlowQueriesInner({ connectionId }) {
    const [hours, setHours] = useState(168);
    const [expanded, setExpanded] = useState(null);
    const groupsQ = useQuery({
        queryKey: ["slow-queries", connectionId, hours],
        queryFn: () => api.listSlowQueries(connectionId, hours, 100),
        refetchInterval: 30_000,
    });
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-6xl mx-auto", children: [_jsxs("div", { className: "flex items-start justify-between gap-4 flex-wrap", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-lg font-semibold flex items-center gap-2", children: [_jsx(Timer, { className: "h-5 w-5" }), " Slow queries"] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Queries that took longer than the configured threshold, grouped by shape. Failed queries are tracked too \u2014 useful for spotting repeated timeouts." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Select, { value: String(hours), onValueChange: (v) => setHours(parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "w-40", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: WINDOWS.map((w) => (_jsx(SelectItem, { value: String(w.value), children: w.label }, w.value))) })] }), _jsx(Button, { variant: "outline", size: "sm", onClick: () => groupsQ.refetch(), disabled: groupsQ.isFetching, children: groupsQ.isFetching ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : "Refresh" })] })] }), groupsQ.isLoading ? (_jsxs("div", { className: "rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading\u2026"] })) : !groupsQ.data || groupsQ.data.length === 0 ? (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center", children: [_jsx("div", { className: "text-sm font-medium mb-1", children: "No slow queries recorded" }), _jsxs("div", { className: "text-xs text-muted-foreground", children: ["Queries under the threshold aren't logged. Run something heavy to populate this view, or lower ", _jsx("code", { className: "bg-muted px-1 rounded", children: "SLOW_QUERY_THRESHOLD_MS" }), "."] })] })) : (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "w-6 px-2 py-2" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Shape" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-20", children: "Runs" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-24", children: "Avg" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-24", children: "Max" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-28", children: "Total time" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-28", children: "Last seen" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: groupsQ.data.map((g) => (_jsx(GroupRow, { group: g, connectionId: connectionId, expanded: expanded === g.shapeHash, onToggle: () => setExpanded(expanded === g.shapeHash ? null : g.shapeHash) }, g.shapeHash))) })] }) }))] }));
}
function GroupRow({ group, connectionId, expanded, onToggle, }) {
    return (_jsxs(_Fragment, { children: [_jsxs("tr", { className: cn("cursor-pointer hover:bg-muted/30", group.erroredCount > 0 && "bg-destructive/5"), onClick: onToggle, children: [_jsx("td", { className: "px-2 py-2 align-top", children: expanded ? _jsx(ChevronDown, { className: "h-4 w-4" }) : _jsx(ChevronRight, { className: "h-4 w-4" }) }), _jsxs("td", { className: "px-3 py-2 font-mono text-xs max-w-0", children: [_jsx("div", { className: "truncate", title: group.normalizedSql, children: group.normalizedSql }), group.erroredCount > 0 && (_jsxs("div", { className: "mt-0.5 flex items-center gap-1 text-xs text-destructive", children: [_jsx(AlertTriangle, { className: "h-3 w-3" }), group.erroredCount, " errored"] }))] }), _jsx("td", { className: "px-3 py-2 text-right font-mono text-xs", children: group.count }), _jsxs("td", { className: "px-3 py-2 text-right font-mono text-xs", children: [group.avgDurationMs, "ms"] }), _jsxs("td", { className: "px-3 py-2 text-right font-mono text-xs", children: [group.maxDurationMs, "ms"] }), _jsxs("td", { className: "px-3 py-2 text-right font-mono text-xs", children: [(group.totalDurationMs / 1000).toFixed(1), "s"] }), _jsx("td", { className: "px-3 py-2 text-xs text-muted-foreground", children: formatDistanceToNow(new Date(group.lastSeen), { addSuffix: true }) })] }), expanded && (_jsxs("tr", { children: [_jsx("td", {}), _jsx("td", { colSpan: 6, className: "p-0", children: _jsx(GroupDetails, { group: group, connectionId: connectionId }) })] }))] }));
}
function GroupDetails({ group, connectionId, }) {
    const runsQ = useQuery({
        queryKey: ["slow-queries-runs", connectionId, group.shapeHash],
        queryFn: () => api.listSlowQueryRuns(connectionId, group.shapeHash, 50),
    });
    return (_jsxs("div", { className: "border-t border-border bg-muted/20 p-3 space-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs uppercase text-muted-foreground mb-1", children: "Example SQL" }), _jsx("pre", { className: "rounded bg-background border border-border p-2 text-xs font-mono overflow-x-auto max-h-48", children: group.exampleSql })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs uppercase text-muted-foreground mb-1", children: "Recent runs" }), runsQ.isLoading ? (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx(Loader2, { className: "h-3 w-3 animate-spin" }), " Loading\u2026"] })) : runsQ.data && runsQ.data.length > 0 ? (_jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { className: "text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left py-1 font-normal", children: "When" }), _jsx("th", { className: "text-left py-1 font-normal", children: "User" }), _jsx("th", { className: "text-right py-1 font-normal w-20", children: "Duration" }), _jsx("th", { className: "text-right py-1 font-normal w-16", children: "Rows" }), _jsx("th", { className: "text-left py-1 font-normal", children: "Status" })] }) }), _jsx("tbody", { children: runsQ.data.map((r) => (_jsxs("tr", { className: "border-t border-border/50", children: [_jsx("td", { className: "py-1 font-mono", children: formatDistanceToNow(new Date(r.createdAt), { addSuffix: true }) }), _jsx("td", { className: "py-1", children: r.user?.email ?? "—" }), _jsxs("td", { className: "py-1 text-right font-mono", children: [r.durationMs, "ms"] }), _jsx("td", { className: "py-1 text-right font-mono", children: r.rowCount ?? r.rowsAffected ?? "—" }), _jsxs("td", { className: "py-1", children: [r.errored ? (_jsx(Badge, { variant: "destructive", className: "text-[10px]", children: "error" })) : (_jsx(Badge, { variant: "secondary", className: "text-[10px]", children: "ok" })), r.errorMessage && (_jsx("span", { className: "ml-1 text-destructive font-mono", children: r.errorMessage.slice(0, 80) }))] })] }, r.id))) })] })) : (_jsx("div", { className: "text-xs text-muted-foreground", children: "No recent runs." }))] })] }));
}
