import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Database, Download, FileJson, FileSpreadsheet, FileText, Loader2, Play, Table2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/data-grid";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { exportCsv as dlCsv, exportJson as dlJson, exportExcel as dlExcel, toMarkdownTable, toInsertStatements, toJson, copyToClipboard, } from "@/lib/result-export";
/**
 * Public, no-login viewer for a shared read-only query. Loads the frozen SQL
 * metadata, then runs it on demand against the owner's connection (read-only,
 * row-capped, server-side). The visitor can re-run and export but never edit.
 */
export default function PublicSharedQueryRoute() {
    const { token } = useParams();
    const metaQ = useQuery({
        queryKey: ["shared-query-meta", token],
        queryFn: () => api.getSharedQueryMeta(token),
        enabled: !!token,
        retry: false,
    });
    const run = useMutation({
        mutationFn: () => api.runSharedQuery(token),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const result = run.data;
    const cols = result ? result.fields.map((f) => f.name) : [];
    const copyMd = async () => {
        if (!result)
            return;
        (await copyToClipboard(toMarkdownTable(cols, result.rows)))
            ? toast.success("Markdown copied")
            : toast.error("Copy failed");
    };
    const copyJson = async () => {
        if (!result)
            return;
        (await copyToClipboard(toJson(cols, result.rows)))
            ? toast.success("JSON copied")
            : toast.error("Copy failed");
    };
    const copyInserts = async () => {
        if (!result)
            return;
        (await copyToClipboard(toInsertStatements(cols, result.rows)))
            ? toast.success("INSERTs copied")
            : toast.error("Copy failed");
    };
    if (metaQ.isLoading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin text-muted-foreground" }) }));
    }
    if (metaQ.error) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "max-w-md text-center", children: [_jsx(Database, { className: "h-10 w-10 text-muted-foreground mx-auto mb-3" }), _jsx("h1", { className: "text-lg font-semibold mb-1", children: "Link unavailable" }), _jsx("p", { className: "text-sm text-muted-foreground", children: extractErrorMessage(metaQ.error) })] }) }));
    }
    const meta = metaQ.data;
    return (_jsxs("div", { className: "min-h-screen gradient-bg flex flex-col", children: [_jsxs("header", { className: "border-b border-border bg-card/60 backdrop-blur px-4 py-3 flex items-center gap-3", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "text-sm font-semibold truncate", children: meta.title || "Shared query" }), _jsxs("div", { className: "text-[11px] text-muted-foreground truncate", children: [meta.connectionName, " \u00B7 ", meta.dialect, " \u00B7 read-only", meta.expiresAt && _jsxs(_Fragment, { children: [" \u00B7 expires ", new Date(meta.expiresAt).toLocaleDateString()] })] })] }), _jsxs("div", { className: "ml-auto flex items-center gap-2", children: [result && (_jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: "sm", variant: "outline", children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export", _jsx(ChevronDown, { className: "h-3 w-3 opacity-60" })] }) }), _jsxs(DropdownMenuContent, { align: "end", children: [_jsxs(DropdownMenuItem, { onClick: () => dlCsv(cols, result.rows), children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Download CSV"] }), _jsxs(DropdownMenuItem, { onClick: () => dlJson(cols, result.rows), children: [_jsx(FileJson, { className: "h-3.5 w-3.5" }), " Download JSON"] }), _jsxs(DropdownMenuItem, { onClick: () => dlExcel(cols, result.rows), children: [_jsx(FileSpreadsheet, { className: "h-3.5 w-3.5" }), " Download Excel"] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onClick: copyMd, children: [_jsx(FileText, { className: "h-3.5 w-3.5" }), " Copy as Markdown"] }), _jsxs(DropdownMenuItem, { onClick: copyJson, children: [_jsx(FileJson, { className: "h-3.5 w-3.5" }), " Copy as JSON"] }), _jsxs(DropdownMenuItem, { onClick: copyInserts, children: [_jsx(Table2, { className: "h-3.5 w-3.5" }), " Copy as INSERTs"] })] })] })), _jsxs(Button, { size: "sm", onClick: () => run.mutate(), disabled: run.isPending, children: [run.isPending ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(Play, { className: "h-3.5 w-3.5" })), result ? "Re-run" : "Run query"] })] })] }), _jsx("div", { className: "px-4 py-2 border-b border-border bg-card/30", children: _jsx("pre", { className: "text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-24", children: meta.sqlText }) }), _jsxs("div", { className: "flex-1 min-h-0 overflow-auto", children: [!result && !run.isPending && (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Click \u201CRun query\u201D to load the data." })), run.isPending && (_jsxs("div", { className: "h-full flex items-center justify-center gap-2 text-sm text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Running\u2026"] })), result && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border", children: [result.rowCount, " rows \u00B7 ", result.durationMs, "ms", result.truncated && (_jsxs("span", { className: "text-amber-600 dark:text-amber-400", children: [" ", "\u00B7 capped at ", result.rowCount, " rows"] }))] }), _jsx(DataGrid, { columns: result.fields.map((f) => ({ name: f.name, type: f.dataType })), rows: result.rows })] }))] }), _jsx("footer", { className: "border-t border-border bg-card/40 px-4 py-2 text-center text-[11px] text-muted-foreground", children: "Powered by DB Studio \u00B7 read-only shared query" })] }));
}
