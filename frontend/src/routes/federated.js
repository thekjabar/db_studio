import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Database, GitBranch, Loader2, Play, Plus, Trash2, Workflow } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataGrid } from "@/components/data-grid";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";
const EXAMPLE_SQL = `-- Join tables across connections using your chosen aliases
-- Example: SELECT u.email, o.total
--          FROM src1.public.users u
--          JOIN src2.main.orders o ON u.id = o.user_id
SELECT 1 AS hello;`;
export default function FederatedRoute() {
    const nav = useNavigate();
    const { user } = useAuth();
    const [sources, setSources] = useState([{ alias: "src1", connectionId: "" }]);
    const [sql, setSql] = useState(EXAMPLE_SQL);
    const [maxRows, setMaxRows] = useState(1000);
    const [result, setResult] = useState(null);
    const [plan, setPlan] = useState(null);
    const connectionsQ = useQuery({
        queryKey: ["connections"],
        queryFn: () => api.listConnections(),
    });
    const usable = (connectionsQ.data ?? []).filter((c) => c.dialect !== "MSSQL");
    const run = useMutation({
        mutationFn: () => api.federatedQuery({
            sources: sources.filter((s) => s.alias && s.connectionId),
            sql,
            maxRows,
        }),
        onSuccess: (r) => {
            setResult(r);
            if (r.truncated) {
                toast.warning(`Showed first ${r.rowCount} rows — result is larger.`);
            }
            else {
                toast.success(`${r.rowCount} rows · ${r.durationMs}ms`);
            }
        },
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    const explain = useMutation({
        mutationFn: () => api.federatedExplain({
            sources: sources.filter((s) => s.alias && s.connectionId),
            sql,
        }),
        onSuccess: (p) => setPlan(p),
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    const addSource = () => {
        setSources([...sources, { alias: `src${sources.length + 1}`, connectionId: "" }]);
    };
    const removeSource = (i) => {
        setSources(sources.filter((_, idx) => idx !== i));
    };
    const updateSource = (i, patch) => {
        setSources(sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
    };
    const submit = (e) => {
        e.preventDefault();
        const valid = sources.filter((s) => s.alias && s.connectionId);
        if (valid.length === 0) {
            toast.error("Add at least one source with a connection selected");
            return;
        }
        const dupes = new Set();
        for (const s of valid) {
            if (dupes.has(s.alias)) {
                toast.error(`Duplicate alias: ${s.alias}`);
                return;
            }
            dupes.add(s.alias);
        }
        if (!sql.trim()) {
            toast.error("SQL is empty");
            return;
        }
        run.mutate();
    };
    return (_jsxs("div", { className: "min-h-screen gradient-bg flex flex-col", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm", children: [_jsxs(Link, { to: "/connections", className: "flex items-center gap-2 font-semibold", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), "DB Studio"] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { to: "/connections", className: "text-sm text-muted-foreground hover:text-foreground", children: "Connections" }), _jsx("span", { className: "hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50", children: user?.email }), _jsx(ThemeToggle, {})] })] }), _jsxs("div", { className: "max-w-6xl w-full mx-auto px-6 py-6 flex-1 flex flex-col gap-4", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-xl font-semibold flex items-center gap-2", children: [_jsx(Workflow, { className: "h-5 w-5" }), " Multi-DB query"] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Join tables across connections. DuckDB runs the query in memory on the backend, pulling rows from each source on demand." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { className: "rounded-md border border-border bg-card p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Sources" }), _jsxs("div", { className: "text-xs text-muted-foreground", children: ["Pick up to 5 connections and give each an alias. Reference them as", " ", _jsx("code", { className: "bg-muted px-1 rounded", children: "alias.schema.table" }), " in the SQL."] })] }), _jsxs(Button, { type: "button", size: "sm", variant: "outline", onClick: addSource, disabled: sources.length >= 5, children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add source"] })] }), _jsx("div", { className: "space-y-2", children: sources.map((s, i) => (_jsxs("div", { className: "grid grid-cols-[140px_1fr_auto] gap-2 items-end", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Alias" }), _jsx(Input, { value: s.alias, onChange: (e) => updateSource(i, { alias: e.target.value }), placeholder: "src1" })] }), _jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Connection" }), _jsxs(Select, { value: s.connectionId || "__none__", onValueChange: (v) => updateSource(i, { connectionId: v === "__none__" ? "" : v }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick a connection" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "__none__", disabled: true, children: "\u2014 Pick \u2014" }), usable.map((c) => (_jsxs(SelectItem, { value: c.id, children: [c.name, " (", c.dialect.toLowerCase(), ")"] }, c.id)))] })] })] }), _jsx(Button, { type: "button", variant: "ghost", size: "icon", className: "h-9 w-9 text-destructive", onClick: () => removeSource(i), disabled: sources.length === 1, children: _jsx(Trash2, { className: "h-4 w-4" }) })] }, i))) })] }), _jsxs("div", { className: "rounded-md border border-border bg-card p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx(Label, { children: "SQL" }), _jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx("span", { children: "Row cap" }), _jsxs(Select, { value: String(maxRows), onValueChange: (v) => setMaxRows(parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "h-7 w-24 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "100", children: "100" }), _jsx(SelectItem, { value: "1000", children: "1,000" }), _jsx(SelectItem, { value: "10000", children: "10,000" }), _jsx(SelectItem, { value: "100000", children: "100,000" })] })] })] })] }), _jsx(Textarea, { value: sql, onChange: (e) => setSql(e.target.value), rows: 8, className: "font-mono text-xs" })] }), _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("div", { className: "text-xs text-muted-foreground", children: "Postgres / MySQL / SQLite only. MSSQL sources and SSH-tunnelled connections aren't supported here \u2014 DuckDB needs a direct network path." }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Button, { type: "button", variant: "outline", disabled: explain.isPending || run.isPending, onClick: () => {
                                                    const valid = sources.filter((s) => s.alias && s.connectionId);
                                                    if (valid.length === 0 || !sql.trim()) {
                                                        toast.error("Add a source and SQL first");
                                                        return;
                                                    }
                                                    explain.mutate();
                                                }, title: "Show how the planner distributes this query \u2014 what runs on each source vs. locally", children: [explain.isPending ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : _jsx(GitBranch, { className: "h-4 w-4" }), "Show plan"] }), _jsxs(Button, { type: "submit", disabled: run.isPending, children: [run.isPending ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : _jsx(Play, { className: "h-4 w-4" }), "Run"] })] })] })] }), plan && (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "text-sm font-medium flex items-center gap-2", children: [_jsx(GitBranch, { className: "h-4 w-4" }), " Distributed plan"] }), _jsx("button", { className: "text-xs text-muted-foreground hover:text-foreground", onClick: () => setPlan(null), children: "Hide" })] }), plan.warnings.length > 0 && (_jsx("div", { className: "space-y-1.5", children: plan.warnings.map((w, i) => (_jsxs("div", { className: "flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-400", children: [_jsx(AlertTriangle, { className: "h-3.5 w-3.5 mt-0.5 shrink-0" }), _jsx("span", { children: w })] }, i))) })), _jsx("div", { className: "grid gap-2 sm:grid-cols-2", children: plan.sources.map((s) => (_jsxs("div", { className: "rounded border border-border p-2.5 text-xs space-y-1.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-mono font-semibold", children: s.alias }), _jsx("span", { className: "text-muted-foreground", children: s.dialect.toLowerCase() }), s.fullScan ? (_jsx("span", { className: "ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400", children: "full scan" })) : (_jsx("span", { className: "ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400", children: "pushed down" }))] }), s.pushedFilters.length > 0 && (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Filters at source: " }), _jsx("span", { className: "font-mono", children: s.pushedFilters.join(", ") })] })), s.projectedColumns.length > 0 && (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Columns fetched: " }), _jsxs("span", { className: "font-mono", children: [s.projectedColumns.slice(0, 8).join(", "), s.projectedColumns.length > 8 ? "…" : ""] })] })), s.estimatedRows != null && (_jsxs("div", { className: "text-muted-foreground", children: ["Est. rows: ", _jsx("span", { className: "font-mono", children: s.estimatedRows.toLocaleString() })] }))] }, s.alias))) }), plan.localOperations.length > 0 && (_jsxs("div", { className: "text-xs", children: [_jsx("span", { className: "text-muted-foreground", children: "Runs locally (DuckDB): " }), _jsx("span", { className: "font-mono", children: plan.localOperations.join(", ") })] })), _jsxs("details", { className: "text-xs", children: [_jsx("summary", { className: "cursor-pointer text-muted-foreground hover:text-foreground", children: "Raw plan" }), _jsx("pre", { className: "mt-1 bg-muted rounded p-2 overflow-auto max-h-60 whitespace-pre", children: plan.raw })] })] })), _jsx("div", { className: "flex-1 min-h-80 rounded-md border border-border bg-card flex flex-col", children: result ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "px-3 py-2 border-b border-border text-xs flex items-center gap-4 flex-wrap", children: [_jsxs("span", { className: "font-mono", children: [result.rowCount, result.truncated && "+", " rows \u00B7 ", result.durationMs, "ms"] }), _jsxs("span", { className: "text-muted-foreground", children: ["Sources: ", result.sources.map((s) => `${s.alias} (${s.dialect.toLowerCase()})`).join(", ")] }), result.truncated && (_jsxs("span", { className: "text-amber-600 dark:text-amber-400", children: ["Result capped at ", result.appliedLimit, ". Add LIMIT to narrow, or raise the cap."] }))] }), _jsx("div", { className: "flex-1 min-h-0", children: _jsx(DataGrid, { columns: result.fields.map((f) => ({ name: f.name, type: f.dataType })), rows: result.rows, emptyMessage: "Query returned no rows" }) })] })) : (_jsx("div", { className: "flex-1 flex items-center justify-center text-sm text-muted-foreground", children: "Run a query to see results." })) })] })] }));
}
