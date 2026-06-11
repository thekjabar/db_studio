import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { BarChart3, BookOpen, Code2, Loader2, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { EmptyState } from "@/components/empty-state";
import { ChartConfigDialog } from "@/components/chart-config-dialog";
import { QueryChart } from "@/components/query-chart";
export default function SavedRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const modal = useModal();
    const q = useQuery({
        queryKey: ["saved-queries", id],
        queryFn: () => api.listSavedQueries(id),
        enabled: !!id,
    });
    const del = useMutation({
        mutationFn: (qid) => api.deleteSavedQuery(id, qid),
        onSuccess: () => {
            toast.success("Deleted");
            qc.invalidateQueries({ queryKey: ["saved-queries", id] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "h-full overflow-auto p-6", children: [_jsx("h2", { className: "text-lg font-semibold mb-4", children: "Saved queries" }), q.isLoading && _jsx("div", { className: "text-sm text-muted-foreground", children: "Loading..." }), q.data?.length === 0 && (_jsx("div", { className: "rounded-xl border border-dashed border-border bg-card/50", children: _jsx(EmptyState, { icon: BookOpen, title: "No saved queries yet", description: "Run a query in the SQL editor and click Save to keep it here for later.", action: _jsx(Button, { asChild: true, children: _jsxs(Link, { to: `/c/${id}/sql`, children: [_jsx(Code2, { className: "h-4 w-4" }), " Open SQL editor"] }) }) }) })), _jsx("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-4", children: q.data?.map((s) => (_jsx(SavedQueryCard, { connectionId: id, query: s, onDelete: async () => {
                        const ok = await modal.confirm({
                            title: `Delete "${s.name}"?`,
                            description: "This removes the saved query.",
                            confirmLabel: "Delete",
                            destructive: true,
                        });
                        if (ok)
                            del.mutate(s.id);
                    } }, s.id))) })] }));
}
function SavedQueryCard({ connectionId, query, onDelete, }) {
    const qc = useQueryClient();
    const [configOpen, setConfigOpen] = useState(false);
    const runQ = useQuery({
        queryKey: ["saved-result", query.id, query.sqlText, query.updatedAt],
        queryFn: () => api.runQuery(connectionId, { sql: query.sqlText }),
        enabled: !!query.chartConfig,
        retry: false,
        staleTime: 60_000,
    });
    const saveConfig = useMutation({
        mutationFn: (next) => api.updateSavedQuery(connectionId, query.id, { chartConfig: next }),
        onSuccess: () => {
            toast.success("Chart saved");
            qc.invalidateQueries({ queryKey: ["saved-queries", connectionId] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const fieldNames = runQ.data?.fields.map((f) => f.name) ?? [];
    return (_jsxs("div", { className: "rounded-lg border border-border bg-card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "font-semibold text-sm truncate", children: query.name }), _jsx("div", { className: "text-[11px] text-muted-foreground", children: query.createdAt ? format(new Date(query.createdAt), "yyyy-MM-dd HH:mm") : "" })] }), _jsxs("div", { className: "flex gap-1", children: [_jsx(Button, { size: "icon", variant: "ghost", title: "Open in SQL editor", asChild: true, children: _jsx(Link, { to: `/c/${connectionId}/sql`, state: { sql: query.sqlText }, children: _jsx(Code2, { className: "h-3.5 w-3.5" }) }) }), _jsx(Button, { size: "icon", variant: "ghost", title: query.chartConfig ? "Edit chart" : "Add chart", onClick: async () => {
                                    // If we don't yet have a result, run the query once to discover columns.
                                    if (!fieldNames.length) {
                                        try {
                                            const r = await api.runQuery(connectionId, { sql: query.sqlText });
                                            qc.setQueryData(["saved-result", query.id, query.sqlText, query.updatedAt], r);
                                        }
                                        catch (e) {
                                            toast.error(extractErrorMessage(e));
                                            return;
                                        }
                                    }
                                    setConfigOpen(true);
                                }, children: _jsx(BarChart3, { className: "h-3.5 w-3.5" }) }), _jsx(Button, { size: "icon", variant: "ghost", className: "text-destructive", onClick: onDelete, title: "Delete", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }), query.chartConfig && runQ.data ? (_jsx(QueryChart, { config: query.chartConfig, rows: runQ.data.rows })) : query.chartConfig && runQ.isLoading ? (_jsxs("div", { className: "h-48 flex items-center justify-center text-xs text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin mr-2" }), " Running query..."] })) : query.chartConfig && runQ.error ? (_jsx("div", { className: "h-24 text-xs text-destructive flex items-center", children: extractErrorMessage(runQ.error) })) : (_jsx("pre", { className: "font-mono text-[11px] text-muted-foreground overflow-hidden text-ellipsis bg-muted rounded p-2 max-h-24", children: query.sqlText })), _jsx(ChartConfigDialog, { open: configOpen, onOpenChange: setConfigOpen, columns: fieldNames.length ? fieldNames : qc.getQueryData(["saved-result", query.id, query.sqlText, query.updatedAt])?.fields.map((f) => f.name) ?? [], initial: query.chartConfig ?? undefined, onSave: (next) => saveConfig.mutate(next) })] }));
}
