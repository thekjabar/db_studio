import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, Fragment } from "react";
import { useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Download, Loader2, Undo2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";
const ACTION_COLORS = {
    LOGIN: "info",
    LOGIN_FAILED: "destructive",
    LOGOUT: "secondary",
    SIGNUP: "info",
    TOTP_ENABLED: "default",
    TOTP_DISABLED: "warning",
    CONNECTION_CREATED: "default",
    CONNECTION_UPDATED: "warning",
    CONNECTION_DELETED: "destructive",
    CONNECTION_TESTED: "secondary",
    QUERY_RUN: "info",
    ROW_INSERT: "default",
    ROW_UPDATE: "warning",
    ROW_DELETE: "destructive",
    SCHEMA_CHANGE: "warning",
    MEMBER_ADDED: "default",
    MEMBER_REMOVED: "destructive",
};
const PAGE_SIZE = 100;
// Actions whose audit entries can be reverted via the UI.
const REVERTABLE_ACTIONS = new Set(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);
export default function AuditRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const modal = useModal();
    const [filter, setFilter] = useState("");
    const [expanded, setExpanded] = useState(null);
    const q = useInfiniteQuery({
        queryKey: ["audit", id],
        queryFn: ({ pageParam }) => api.listAudit(id, { limit: PAGE_SIZE, cursor: pageParam }),
        getNextPageParam: (last) => last.nextCursor,
        initialPageParam: undefined,
        enabled: !!id,
    });
    const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
    const filtered = useMemo(() => {
        if (!filter)
            return items;
        const f = filter.toLowerCase();
        return items.filter((i) => i.action?.toLowerCase().includes(f) ||
            i.user?.toLowerCase().includes(f) ||
            i.sqlText?.toLowerCase().includes(f));
    }, [items, filter]);
    const revert = useMutation({
        mutationFn: (entryId) => api.auditRevert(id, entryId),
        onSuccess: (r) => {
            toast.success(`Reverted ${r.affected} row${r.affected === 1 ? "" : "s"}`);
            qc.invalidateQueries({ queryKey: ["audit", id] });
            // The data the user is browsing may have changed.
            qc.invalidateQueries({ queryKey: ["data"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const onRevertClick = async (e) => {
        try {
            const preview = await api.auditRevertPreview(id, e.id);
            const ok = await modal.confirm({
                title: "Revert this change?",
                description: preview.description,
                confirmLabel: "Revert",
                destructive: true,
            });
            if (ok)
                revert.mutate(e.id);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
    };
    const describe = (e) => {
        if (e.sqlText)
            return e.sqlText;
        const m = e.metadata;
        if (m?.table) {
            return m.bulk ? `${m.table} (${m.bulk} rows)` : m.table;
        }
        if (e.metadata && typeof e.metadata === "object")
            return JSON.stringify(e.metadata);
        return "";
    };
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2", children: [_jsx(Input, { placeholder: "Filter by action, user, or SQL...", value: filter, onChange: (e) => setFilter(e.target.value), className: "h-8 text-xs font-mono max-w-md" }), _jsxs("span", { className: "ml-auto text-xs text-muted-foreground", children: [filtered.length, " ", filter ? `of ${items.length}` : "", " entries", q.hasNextPage && !filter ? "+" : ""] }), _jsxs(Button, { size: "sm", variant: "outline", className: "h-8", onClick: () => api
                            .exportAuditCsv(id)
                            .then(() => toast.success("Audit log exported"))
                            .catch((e) => toast.error(extractErrorMessage(e))), title: "Download this connection's audit log as CSV (owner only)", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export CSV"] })] }), _jsxs("div", { className: "flex-1 overflow-auto", children: [q.isLoading && _jsx("div", { className: "p-6 text-sm text-muted-foreground", children: "Loading audit log..." }), q.error && _jsx("div", { className: "p-6 text-sm text-destructive", children: extractErrorMessage(q.error) }), !q.isLoading && filtered.length === 0 && (_jsx("div", { className: "p-12 text-center text-sm text-muted-foreground", children: "No audit entries" })), _jsxs("table", { className: "w-full text-xs font-mono", children: [_jsx("thead", { className: "sticky top-0 bg-card z-10", children: _jsxs("tr", { className: "border-b border-border", children: [_jsx("th", { className: "w-8" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground", children: "When" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground", children: "Action" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground", children: "User" }), _jsx("th", { className: "text-right px-4 py-2 font-medium text-muted-foreground", children: "Rows" }), _jsx("th", { className: "text-left px-4 py-2 font-medium text-muted-foreground", children: "Table / Details" }), _jsx("th", { className: "w-24" })] }) }), _jsx("tbody", { children: filtered.map((e) => {
                                    const isExpanded = expanded === e.id;
                                    const hasDetails = hasRevertDetails(e);
                                    return (_jsxs(Fragment, { children: [_jsxs("tr", { className: cn("border-b border-border hover:bg-accent/30 cursor-pointer", isExpanded && "bg-accent/30"), onClick: () => hasDetails && setExpanded(isExpanded ? null : e.id), children: [_jsx("td", { className: "pl-4 pr-1 py-2 text-muted-foreground", children: hasDetails ? (isExpanded ? _jsx(ChevronDown, { className: "h-3 w-3" }) : _jsx(ChevronRight, { className: "h-3 w-3" })) : null }), _jsx("td", { className: "px-4 py-2 text-muted-foreground whitespace-nowrap", children: e.createdAt ? format(new Date(e.createdAt), "yyyy-MM-dd HH:mm:ss") : "" }), _jsx("td", { className: "px-4 py-2", children: _jsx(Badge, { variant: ACTION_COLORS[e.action] ?? "secondary", children: e.action }) }), _jsx("td", { className: "px-4 py-2 text-muted-foreground", children: e.user || e.userId || "—" }), _jsx("td", { className: "px-4 py-2 text-right text-muted-foreground tabular-nums", children: e.affectedRows ?? "" }), _jsx("td", { className: "px-4 py-2 max-w-[600px] truncate", title: describe(e), children: describe(e) }), _jsx("td", { className: "px-4 py-2", children: hasDetails && REVERTABLE_ACTIONS.has(e.action) && (_jsxs(Button, { size: "sm", variant: "ghost", className: "h-7 text-xs", disabled: revert.isPending && revert.variables === e.id, onClick: (ev) => {
                                                                ev.stopPropagation();
                                                                onRevertClick(e);
                                                            }, children: [revert.isPending && revert.variables === e.id ? (_jsx(Loader2, { className: "h-3 w-3 animate-spin" })) : (_jsx(Undo2, { className: "h-3 w-3" })), "Revert"] })) })] }), isExpanded && (_jsxs("tr", { className: "bg-muted/30 border-b border-border", children: [_jsx("td", {}), _jsx("td", { colSpan: 6, className: "px-4 py-3", children: _jsx(DiffView, { entry: e }) })] }))] }, e.id));
                                }) })] }), q.hasNextPage && (_jsx("div", { className: "p-4 flex justify-center", children: _jsxs(Button, { size: "sm", variant: "outline", onClick: () => q.fetchNextPage(), disabled: q.isFetchingNextPage, children: [q.isFetchingNextPage && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), "Load more"] }) }))] })] }));
}
function getMeta(e) {
    return (e.metadata ?? {});
}
function hasRevertDetails(e) {
    const m = getMeta(e);
    return !!(m.before || m.after || m.beforeRows?.length);
}
function DiffView({ entry }) {
    const m = getMeta(entry);
    if (m.bulk && m.beforeRows?.length) {
        return (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "text-[11px] text-muted-foreground", children: [entry.action, " of ", m.bulk, " rows", m.afterValues && (_jsxs(_Fragment, { children: [" ", "\u2192 set", " ", _jsx("span", { className: "text-foreground font-mono", children: JSON.stringify(m.afterValues) })] }))] }), _jsxs("div", { className: "rounded border border-border bg-card overflow-auto max-h-64", children: [_jsxs("table", { className: "w-full text-[11px] font-mono", children: [_jsx("thead", { className: "bg-muted text-muted-foreground", children: _jsx("tr", { children: Object.keys(m.beforeRows[0]).map((k) => (_jsx("th", { className: "text-left px-2 py-1 font-medium", children: k }, k))) }) }), _jsx("tbody", { children: m.beforeRows.slice(0, 50).map((r, i) => (_jsx("tr", { className: "border-t border-border", children: Object.values(r).map((v, j) => (_jsx("td", { className: "px-2 py-1 whitespace-nowrap", children: v === null || v === undefined ? (_jsx("span", { className: "text-muted-foreground italic", children: "NULL" })) : typeof v === "object" ? (JSON.stringify(v)) : (String(v)) }, j))) }, i))) })] }), m.beforeRows.length > 50 && (_jsxs("div", { className: "p-2 text-[10px] text-muted-foreground text-center", children: ["showing 50 of ", m.beforeRows.length] }))] })] }));
    }
    // Single-row diff
    const before = m.before ?? null;
    const after = m.after ?? null;
    const allKeys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).sort();
    if (!allKeys.length) {
        return _jsx("div", { className: "text-[11px] text-muted-foreground italic", children: "No row snapshot available." });
    }
    return (_jsx("div", { className: "rounded border border-border bg-card overflow-auto", children: _jsxs("table", { className: "w-full text-[11px] font-mono", children: [_jsx("thead", { className: "bg-muted text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-1.5 font-medium w-40", children: "Column" }), _jsx("th", { className: "text-left px-3 py-1.5 font-medium", children: "Before" }), _jsx("th", { className: "text-left px-3 py-1.5 font-medium", children: "After" })] }) }), _jsx("tbody", { children: allKeys.map((k) => {
                        const bv = before?.[k];
                        const av = after?.[k];
                        const changed = JSON.stringify(bv) !== JSON.stringify(av);
                        return (_jsxs("tr", { className: cn("border-t border-border", changed && "bg-amber-500/10"), children: [_jsx("td", { className: "px-3 py-1.5 text-muted-foreground", children: k }), _jsx("td", { className: cn("px-3 py-1.5", changed && "text-rose-700 dark:text-rose-400"), children: _jsx(RenderValue, { v: bv }) }), _jsx("td", { className: cn("px-3 py-1.5", changed && "text-emerald-700 dark:text-emerald-400"), children: _jsx(RenderValue, { v: av }) })] }, k));
                    }) })] }) }));
}
function RenderValue({ v }) {
    if (v === null || v === undefined) {
        return _jsx("span", { className: "text-muted-foreground italic", children: "NULL" });
    }
    if (typeof v === "object") {
        return _jsx("span", { children: JSON.stringify(v) });
    }
    return _jsx("span", { children: String(v) });
}
