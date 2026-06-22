import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Blocks, Code2, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DataGrid } from "@/components/data-grid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
const OPS = ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"];
/**
 * No-SQL visual query builder: pick table → columns → filters → sort → run.
 * Generates plain SELECT SQL (shown live) so it doubles as a learning tool —
 * "Open in SQL editor" hands the generated query over for refinement.
 */
export default function QueryBuilderRoute() {
    const { id } = useParams();
    const nav = useNavigate();
    const ctx = useOutletContext();
    const schema = ctx?.schema ?? "public";
    const [table, setTable] = useState("");
    const [cols, setCols] = useState(new Set());
    const [filters, setFilters] = useState([]);
    const [orderBy, setOrderBy] = useState("");
    const [orderDir, setOrderDir] = useState("ASC");
    const [limit, setLimit] = useState("100");
    const [result, setResult] = useState(null);
    const tablesQ = useQuery({
        queryKey: ["tables", id, schema],
        queryFn: () => api.listTables(id, schema),
        enabled: !!id && !!schema,
    });
    const columnsQ = useQuery({
        queryKey: ["columns", id, schema, table],
        queryFn: () => api.getTableColumns(id, table, schema),
        enabled: !!id && !!table,
    });
    useEffect(() => {
        setCols(new Set());
        setFilters([]);
        setOrderBy("");
        setResult(null);
    }, [table]);
    const q = (s) => `"${s.replace(/"/g, '""')}"`;
    const sql = useMemo(() => {
        if (!table)
            return "";
        const colList = cols.size > 0 ? [...cols].map(q).join(", ") : "*";
        let s = `SELECT ${colList}\nFROM ${q(schema)}.${q(table)}`;
        const conds = filters
            .filter((f) => f.column && (f.op.includes("NULL") || f.value !== ""))
            .map((f) => {
            if (f.op.includes("NULL"))
                return `${q(f.column)} ${f.op}`;
            const v = /^-?\d+(\.\d+)?$/.test(f.value.trim())
                ? f.value.trim()
                : `'${f.value.replace(/'/g, "''")}'`;
            return `${q(f.column)} ${f.op} ${v}`;
        });
        if (conds.length)
            s += `\nWHERE ${conds.join("\n  AND ")}`;
        if (orderBy)
            s += `\nORDER BY ${q(orderBy)} ${orderDir}`;
        const lim = parseInt(limit, 10);
        if (lim > 0)
            s += `\nLIMIT ${Math.min(lim, 10000)}`;
        return s + ";";
    }, [table, cols, filters, orderBy, orderDir, limit, schema]);
    const run = useMutation({
        mutationFn: () => api.runQuery(id, { sql, maxRows: 1000 }),
        onSuccess: (r) => {
            setResult(r);
            toast.success(`${r.rowCount ?? r.rows.length} rows · ${r.durationMs}ms`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2", children: [_jsx(Blocks, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Query builder" }), _jsxs("div", { className: "ml-auto flex items-center gap-2", children: [_jsxs(Button, { size: "sm", variant: "outline", disabled: !sql, onClick: () => nav(`/c/${id}/sql?sql=${encodeURIComponent(sql)}`), children: [_jsx(Code2, { className: "h-3.5 w-3.5" }), " Open in SQL editor"] }), _jsxs(Button, { size: "sm", onClick: () => run.mutate(), disabled: !sql || run.isPending, children: [run.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Play, { className: "h-3.5 w-3.5" }), "Run"] })] })] }), _jsxs("div", { className: "flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_1fr]", children: [_jsxs("div", { className: "border-r border-border p-3 space-y-4 overflow-y-auto", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Table" }), _jsxs(Select, { value: table, onValueChange: setTable, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: tablesQ.isLoading ? "Loading…" : "Pick a table" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, className: "font-mono", children: t.name }, t.name))) })] })] }), table && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "space-y-1.5", children: [_jsxs(Label, { children: ["Columns ", _jsx("span", { className: "text-muted-foreground font-normal", children: "(none = all)" })] }), _jsx("div", { className: "max-h-44 overflow-y-auto rounded border border-border p-2 space-y-1", children: (columnsQ.data ?? []).map((c) => (_jsxs("label", { className: "flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 hover:bg-accent rounded", children: [_jsx(Checkbox, { checked: cols.has(c.name), onCheckedChange: (v) => {
                                                                const next = new Set(cols);
                                                                v ? next.add(c.name) : next.delete(c.name);
                                                                setCols(next);
                                                            } }), _jsx("span", { className: "font-mono", children: c.name }), _jsx("span", { className: "text-muted-foreground ml-auto", children: c.dataType })] }, c.name))) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { children: "Filters" }), _jsxs(Button, { size: "sm", variant: "ghost", className: "h-6 px-1.5", onClick: () => setFilters((f) => [...f, { column: "", op: "=", value: "" }]), children: [_jsx(Plus, { className: "h-3 w-3" }), " Add"] })] }), filters.map((f, i) => (_jsxs("div", { className: "flex items-center gap-1", children: [_jsxs(Select, { value: f.column || undefined, onValueChange: (v) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x))), children: [_jsx(SelectTrigger, { className: "h-8 text-xs flex-1", children: _jsx(SelectValue, { placeholder: "column" }) }), _jsx(SelectContent, { children: (columnsQ.data ?? []).map((c) => (_jsx(SelectItem, { value: c.name, className: "font-mono", children: c.name }, c.name))) })] }), _jsxs(Select, { value: f.op, onValueChange: (v) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, op: v } : x))), children: [_jsx(SelectTrigger, { className: "h-8 text-xs w-24", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: OPS.map((o) => _jsx(SelectItem, { value: o, children: o }, o)) })] }), !f.op.includes("NULL") && (_jsx(Input, { className: "h-8 text-xs flex-1", value: f.value, onChange: (e) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))), placeholder: "value" })), _jsx("button", { onClick: () => setFilters((xs) => xs.filter((_, j) => j !== i)), className: "p-1 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] }, i)))] }), _jsxs("div", { className: "grid grid-cols-[1fr_90px_80px] gap-2", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Order by" }), _jsxs(Select, { value: orderBy || "__none__", onValueChange: (v) => setOrderBy(v === "__none__" ? "" : v), children: [_jsx(SelectTrigger, { className: "h-8 text-xs", children: _jsx(SelectValue, { placeholder: "\u2014" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "__none__", children: "\u2014" }), (columnsQ.data ?? []).map((c) => (_jsx(SelectItem, { value: c.name, className: "font-mono", children: c.name }, c.name)))] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Dir" }), _jsxs(Select, { value: orderDir, onValueChange: (v) => setOrderDir(v), children: [_jsx(SelectTrigger, { className: "h-8 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "ASC", children: "ASC" }), _jsx(SelectItem, { value: "DESC", children: "DESC" })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Limit" }), _jsx(Input, { className: "h-8 text-xs", value: limit, onChange: (e) => setLimit(e.target.value) })] })] })] })), sql && (_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { children: "Generated SQL" }), _jsx("pre", { className: "text-[11px] font-mono bg-muted rounded p-2 whitespace-pre-wrap", children: sql })] }))] }), _jsx("div", { className: "min-h-0 overflow-auto", children: result ? (_jsx(DataGrid, { columns: result.fields.map((f) => ({ name: f.name, type: f.dataType })), rows: result.rows })) : (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Pick a table, add filters, hit Run." })) })] })] }));
}
