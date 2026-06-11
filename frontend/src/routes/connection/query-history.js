import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Play, Loader2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
const PAGE_SIZE = 50;
const WINDOW_MS = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    all: undefined,
};
export default function QueryHistoryRoute() {
    const { id } = useParams();
    const [search, setSearch] = useState("");
    const [window, setWindow] = useState("7d");
    const [actionFilter, setActionFilter] = useState("all");
    const params = {
        limit: PAGE_SIZE,
        sinceMs: WINDOW_MS[window],
        search: search.trim() || undefined,
        action: actionFilter === "all" ? undefined : actionFilter,
    };
    const q = useInfiniteQuery({
        queryKey: ["query-history", id, window, actionFilter, search.trim()],
        queryFn: ({ pageParam }) => api.listQueryHistory(id, { ...params, cursor: pageParam }),
        getNextPageParam: (last) => last.nextCursor,
        initialPageParam: undefined,
        enabled: !!id,
    });
    const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap", children: [_jsx(Input, { placeholder: "Search SQL text...", value: search, onChange: (e) => setSearch(e.target.value), className: "h-8 text-xs font-mono max-w-xs" }), _jsxs(Select, { value: window, onValueChange: (v) => setWindow(v), children: [_jsx(SelectTrigger, { className: "h-8 w-32 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "24h", children: "Last 24 h" }), _jsx(SelectItem, { value: "7d", children: "Last 7 days" }), _jsx(SelectItem, { value: "30d", children: "Last 30 days" }), _jsx(SelectItem, { value: "all", children: "All time" })] })] }), _jsxs(Select, { value: actionFilter, onValueChange: (v) => setActionFilter(v), children: [_jsx(SelectTrigger, { className: "h-8 w-40 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "all", children: "Reads + Writes" }), _jsx(SelectItem, { value: "QUERY_RUN", children: "Queries only" }), _jsx(SelectItem, { value: "SCHEMA_CHANGE", children: "Schema changes" })] })] }), _jsxs("span", { className: "ml-auto text-xs text-muted-foreground", children: [items.length, " entr", items.length === 1 ? "y" : "ies", q.hasNextPage ? "+" : ""] })] }), _jsxs("div", { className: "flex-1 overflow-auto", children: [q.isLoading && (_jsx("div", { className: "p-6 text-sm text-muted-foreground", children: "Loading history..." })), q.error && (_jsx("div", { className: "p-6 text-sm text-destructive", children: extractErrorMessage(q.error) })), !q.isLoading && items.length === 0 && (_jsx("div", { className: "p-12 text-center text-sm text-muted-foreground", children: "No queries in this window. Try widening the filter above." })), _jsxs("table", { className: "w-full text-xs font-mono", children: [_jsx("thead", { className: "sticky top-0 bg-card z-10", children: _jsxs("tr", { className: "border-b border-border", children: [_jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground w-40", children: "When" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground w-24", children: "Kind" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground w-40", children: "User" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground", children: "SQL" }), _jsx("th", { className: "text-right px-4 py-2 font-medium text-muted-foreground w-20", children: "Rows" }), _jsx("th", { className: "w-16" })] }) }), _jsx("tbody", { children: items.map((e) => (_jsxs("tr", { className: "border-b border-border align-top hover:bg-accent/30", children: [_jsx("td", { className: "px-4 py-2 text-muted-foreground whitespace-nowrap", children: format(new Date(e.createdAt), "MMM d, HH:mm:ss") }), _jsx("td", { className: "px-4 py-2", children: _jsx(Badge, { variant: e.action === "SCHEMA_CHANGE" ? "warning" : "info", className: "text-[10px]", children: e.action === "SCHEMA_CHANGE" ? "Schema" : "Query" }) }), _jsx("td", { className: "px-4 py-2 text-foreground", children: e.user ?? "—" }), _jsx("td", { className: "px-4 py-2", children: _jsx("code", { className: cn("block max-h-16 overflow-hidden text-ellipsis whitespace-pre-wrap text-[11px]"), children: e.sqlText ?? "(no SQL captured)" }) }), _jsx("td", { className: "px-4 py-2 text-right text-muted-foreground", children: e.affectedRows ?? "—" }), _jsx("td", { className: "px-2 py-2", children: e.sqlText && (_jsxs(Link, { to: `/c/${id}/sql?sql=${encodeURIComponent(e.sqlText)}`, className: "inline-flex items-center gap-1 text-primary hover:underline text-[11px]", title: "Open in SQL editor", children: [_jsx(Play, { className: "h-3 w-3" }), " Open"] })) })] }, e.id))) })] }), q.hasNextPage && (_jsx("div", { className: "p-3 flex justify-center", children: _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => q.fetchNextPage(), disabled: q.isFetchingNextPage, children: [q.isFetchingNextPage ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : null, "Load more"] }) }))] })] }));
}
