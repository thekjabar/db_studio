import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useParams, useOutletContext, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpenText, Key, KeyRound, Loader2, Search, Table2 } from "lucide-react";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
/**
 * Auto-generated data dictionary: every table, column, type, PK/FK and
 * row estimate in one searchable catalog — no manual docs required.
 * Built entirely from the existing ER introspection endpoint.
 */
export default function DictionaryRoute() {
    const { id } = useParams();
    const ctx = useOutletContext();
    const schema = ctx?.schema ?? "public";
    const [filter, setFilter] = useState("");
    const [selected, setSelected] = useState(null);
    const erQ = useQuery({
        queryKey: ["er", id, schema],
        queryFn: () => api.getEr(id, schema),
        enabled: !!id,
    });
    const tablesQ = useQuery({
        queryKey: ["tables", id, schema],
        queryFn: () => api.listTables(id, schema),
        enabled: !!id,
    });
    const rowEstimates = useMemo(() => {
        const m = new Map();
        for (const t of tablesQ.data ?? [])
            m.set(t.name, t.rowEstimate);
        return m;
    }, [tablesQ.data]);
    // FK lookup: which columns reference what, and what references this table.
    const fkOut = useMemo(() => {
        const m = new Map();
        for (const e of erQ.data?.edges ?? []) {
            const list = m.get(e.source) ?? [];
            const cols = Array.isArray(e.columns) ? e.columns.join(",") : String(e.columns ?? "");
            const refCols = Array.isArray(e.refColumns) ? e.refColumns.join(",") : String(e.refColumns ?? "");
            list.push({ col: cols, refTable: e.target, refCols });
            m.set(e.source, list);
        }
        return m;
    }, [erQ.data]);
    const tables = useMemo(() => {
        const list = erQ.data?.nodes ?? [];
        const f = filter.trim().toLowerCase();
        if (!f)
            return list;
        return list.filter((t) => t.name.toLowerCase().includes(f) ||
            t.columns.some((c) => c.name.toLowerCase().includes(f)));
    }, [erQ.data, filter]);
    const current = tables.find((t) => t.id === selected) ?? tables[0] ?? null;
    if (erQ.isLoading) {
        return (_jsxs("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Introspecting schema\u2026"] }));
    }
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2", children: [_jsx(BookOpenText, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Data dictionary" }), _jsxs("span", { className: "text-xs text-muted-foreground", children: [erQ.data?.nodes.length ?? 0, " tables \u00B7 ", erQ.data?.edges.length ?? 0, " relationships \u00B7 schema ", _jsx("span", { className: "font-mono", children: schema })] }), _jsxs("div", { className: "relative ml-auto w-64", children: [_jsx(Search, { className: "absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" }), _jsx(Input, { value: filter, onChange: (e) => setFilter(e.target.value), placeholder: "Search tables or columns\u2026", className: "h-8 pl-7 text-xs" })] })] }), _jsxs("div", { className: "flex-1 min-h-0 grid grid-cols-[260px_1fr]", children: [_jsxs("div", { className: "border-r border-border overflow-y-auto", children: [tables.map((t) => (_jsxs("button", { onClick: () => setSelected(t.id), className: cn("w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 hover:bg-accent", current?.id === t.id && "bg-accent text-primary"), children: [_jsx(Table2, { className: "h-3 w-3 shrink-0 text-muted-foreground" }), _jsx("span", { className: "truncate flex-1", children: t.name }), _jsx("span", { className: "text-[10px] text-muted-foreground", children: rowEstimates.get(t.name)?.toLocaleString() ?? "" })] }, t.id))), tables.length === 0 && (_jsx("div", { className: "p-4 text-xs text-muted-foreground", children: "No tables match." }))] }), _jsx("div", { className: "overflow-y-auto p-4", children: current ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-3 mb-1", children: [_jsxs("h2", { className: "font-mono font-semibold", children: [current.schema, ".", current.name] }), _jsxs(Badge, { variant: "outline", children: [current.columns.length, " columns"] }), rowEstimates.get(current.name) !== undefined && (_jsxs(Badge, { variant: "secondary", children: ["~", rowEstimates.get(current.name)?.toLocaleString(), " rows"] })), _jsx(Link, { to: `/c/${id}/t/${encodeURIComponent(current.schema)}/${encodeURIComponent(current.name)}`, className: "text-xs text-primary hover:underline ml-auto", children: "Browse data \u2192" })] }), _jsxs("table", { className: "w-full text-sm mt-3", children: [_jsx("thead", { className: "text-xs text-muted-foreground", children: _jsxs("tr", { className: "text-left border-b border-border", children: [_jsx("th", { className: "py-1.5 pr-3 font-medium w-6" }), _jsx("th", { className: "py-1.5 pr-3 font-medium", children: "Column" }), _jsx("th", { className: "py-1.5 pr-3 font-medium", children: "Type" }), _jsx("th", { className: "py-1.5 font-medium", children: "References" })] }) }), _jsx("tbody", { children: current.columns.map((c) => {
                                                const fk = (fkOut.get(current.id) ?? []).find((f) => f.col.split(",").includes(c.name));
                                                return (_jsxs("tr", { className: "border-b border-border/50", children: [_jsx("td", { className: "py-1.5 pr-2", children: c.pk ? (_jsx(Key, { className: "h-3 w-3 text-amber-500" })) : fk ? (_jsx(KeyRound, { className: "h-3 w-3 text-sky-500" })) : null }), _jsx("td", { className: "py-1.5 pr-3 font-mono text-xs", children: c.name }), _jsx("td", { className: "py-1.5 pr-3 font-mono text-xs text-muted-foreground", children: c.type }), _jsx("td", { className: "py-1.5 text-xs text-muted-foreground font-mono", children: fk ? `→ ${fk.refTable}(${fk.refCols})` : "" })] }, c.name));
                                            }) })] })] })) : (_jsx("div", { className: "text-sm text-muted-foreground", children: "Select a table." })) })] })] }));
}
