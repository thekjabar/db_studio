import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Filter, Plus, RefreshCw, Share2, Trash2, Upload, X, } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataGrid } from "@/components/data-grid";
import { Popover } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RowDrawer } from "@/components/row-drawer";
import { JsonFieldEditor } from "@/components/json-field-editor";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { useTableSubscription } from "@/lib/realtime";
import { useTheme } from "@/lib/theme-store";
import { useModal } from "@/components/modal-provider";
const PAGE_SIZES = [100, 500, 1000];
const FILTER_OPS = [
    { op: "=", label: "[ = ]  equals" },
    { op: "!=", label: "[ <> ]  not equal" },
    { op: ">", label: "[ > ]  greater than" },
    { op: "<", label: "[ < ]  less than" },
    { op: ">=", label: "[ >= ]  greater than or equal" },
    { op: "<=", label: "[ <= ]  less than or equal" },
    { op: "like", label: "[ ~~ ]  like operator" },
    { op: "ilike", label: "[ ~~* ]  ilike operator" },
    { op: "in", label: "[ in ]  one of a list of values" },
    { op: "is null", label: "[ is null ]" },
    { op: "is not null", label: "[ is not null ]" },
];
// Turn a raw user string into the correctly-typed value for the filter.
function coerceFilterValue(raw, op) {
    if (op === "is null" || op === "is not null")
        return null;
    if (op === "in") {
        return raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    if (raw === "")
        return null;
    if (raw === "true")
        return true;
    if (raw === "false")
        return false;
    if (raw === "null")
        return null;
    if (/^-?\d+(?:\.\d+)?$/.test(raw))
        return Number(raw);
    return raw;
}
export default function TableRoute() {
    const { id, schema, table } = useParams();
    const qc = useQueryClient();
    const modal = useModal();
    const [searchParams, setSearchParams] = useSearchParams();
    // Initial state hydrated from URL so links are shareable.
    const [page, setPage] = useState(() => {
        const p = Number(searchParams.get("page"));
        return Number.isFinite(p) && p >= 0 ? p : 0;
    });
    const [pageSize, setPageSize] = useState(() => {
        const n = Number(searchParams.get("size"));
        return PAGE_SIZES.includes(n) ? n : 100;
    });
    const [filters, setFilters] = useState(() => {
        const raw = searchParams.get("f");
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    });
    const [sorts, setSorts] = useState(() => {
        const raw = searchParams.get("s");
        if (!raw)
            return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    });
    const [selected, setSelected] = useState(new Set());
    // Push state to URL as a shareable link. Keep query-string compact.
    useEffect(() => {
        const next = new URLSearchParams(searchParams);
        if (page > 0)
            next.set("page", String(page));
        else
            next.delete("page");
        if (pageSize !== 100)
            next.set("size", String(pageSize));
        else
            next.delete("size");
        if (filters.length)
            next.set("f", JSON.stringify(filters));
        else
            next.delete("f");
        if (sorts.length)
            next.set("s", JSON.stringify(sorts));
        else
            next.delete("s");
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [page, pageSize, filters, sorts]);
    const filterBtnRef = useRef(null);
    const sortBtnRef = useRef(null);
    const pageSizeBtnRef = useRef(null);
    const [filterOpen, setFilterOpen] = useState(false);
    const [sortOpen, setSortOpen] = useState(false);
    const [pageSizeOpen, setPageSizeOpen] = useState(false);
    // Drafts — edits don't commit until "Apply" is clicked.
    const [filterDraft, setFilterDraft] = useState([]);
    const [sortDraft, setSortDraft] = useState([]);
    // Row drawer: -1 = closed, null = inserting new, number = editing that row idx.
    const [drawerRow, setDrawerRow] = useState(-1);
    // JSON cell editor: { rowIdx, column } when open.
    const [jsonCell, setJsonCell] = useState(null);
    const [bulkEditOpen, setBulkEditOpen] = useState(false);
    const [csvImportOpen, setCsvImportOpen] = useState(false);
    const ready = !!id && !!schema && !!table;
    // Live-update: when the backend sees a change for this (schema.table), refetch.
    useTableSubscription({ connectionId: id, schema, table, enabled: ready }, () => {
        qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
    });
    const colsQ = useQuery({
        queryKey: ["columns", id, schema, table],
        queryFn: () => api.getTableColumns(id, table, schema),
        enabled: ready,
    });
    const appliedFilters = useMemo(() => filters
        .filter((f) => f.column && f.op)
        .map((f) => ({ column: f.column, op: f.op, value: coerceFilterValue(f.value, f.op) })), [filters]);
    const dataQ = useQuery({
        queryKey: ["data", id, schema, table, page, pageSize, appliedFilters, sorts],
        queryFn: () => api.getTableData(id, table, {
            schema: schema,
            limit: pageSize,
            offset: page * pageSize,
            filters: appliedFilters,
            orderBy: sorts,
        }),
        enabled: ready,
    });
    const updateRow = useMutation({
        mutationFn: (vars) => api.updateRow(id, table, { schema: schema, pk: vars.pk, set: vars.set }),
        onSuccess: () => {
            toast.success("Row updated");
            qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const deleteRows = useMutation({
        mutationFn: (pks) => api.bulkDeleteRows(id, table, { schema: schema, pks }),
        onSuccess: (r) => {
            toast.success(`Deleted ${r.affectedRows} row${r.affectedRows === 1 ? "" : "s"}`);
            setSelected(new Set());
            qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const columns = useMemo(() => {
        const cols = colsQ.data ?? [];
        return cols.map((c) => ({ name: c.name, type: c.dataType, pk: c.isPrimaryKey }));
    }, [colsQ.data]);
    const pkCols = useMemo(() => (colsQ.data ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name), [colsQ.data]);
    // `total` may be null when the backend skipped COUNT for perf (large filtered set).
    const total = dataQ.data?.total ?? null;
    const totalIsEstimate = !!dataQ.data?.totalIsEstimate;
    const rows = dataQ.data?.rows ?? [];
    // If we don't know the total, cap pagination at the current page + (current fills? one more : self).
    const maxPage = total == null
        ? rows.length === pageSize
            ? page + 1
            : page
        : Math.max(0, Math.ceil(total / pageSize) - 1);
    const openFilter = () => {
        setFilterDraft(filters.length ? filters : [{ column: columns[0]?.name ?? "", op: "=", value: "" }]);
        setFilterOpen(true);
    };
    const openSort = () => {
        setSortDraft(sorts.length ? sorts : [{ column: columns[0]?.name ?? "", direction: "asc" }]);
        setSortOpen(true);
    };
    const applyFilters = () => {
        setFilters(filterDraft.filter((f) => f.column && f.op));
        setPage(0);
        setFilterOpen(false);
    };
    const applySorts = () => {
        setSorts(sortDraft.filter((s) => s.column));
        setPage(0);
        setSortOpen(false);
    };
    const exportCsv = () => {
        if (!rows.length)
            return;
        const cols = columns.map((c) => c.name);
        const csv = [
            cols.join(","),
            ...rows.map((r) => cols.map((c) => {
                const v = r[c];
                if (v === null || v === undefined)
                    return "";
                const s = typeof v === "object" ? JSON.stringify(v) : String(v);
                return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(",")),
        ].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${table}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const onEditCell = (rowIdx, column, value) => {
        if (pkCols.length === 0) {
            toast.error("Cannot edit: no primary key");
            return;
        }
        const row = rows[rowIdx];
        const pk = {};
        for (const c of pkCols)
            pk[c] = row[c];
        updateRow.mutate({ pk, set: { [column]: value } });
    };
    const deleteSelected = async () => {
        if (pkCols.length === 0) {
            toast.error("Cannot delete: no primary key");
            return;
        }
        const pks = [];
        selected.forEach((i) => {
            const r = rows[i];
            const pk = {};
            for (const c of pkCols)
                pk[c] = r[c];
            pks.push(pk);
        });
        const ok = await modal.confirm({
            title: `Delete ${pks.length} row(s)?`,
            description: "This permanently removes the selected rows.",
            confirmLabel: "Delete",
            destructive: true,
        });
        if (ok)
            deleteRows.mutate(pks);
    };
    if (!ready)
        return _jsx(EmptyState, {});
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs(Tabs, { defaultValue: "data", className: "flex flex-col h-full", children: [_jsxs("div", { className: "flex items-center justify-between px-4 py-2 border-b border-border", children: [_jsxs(TabsList, { children: [_jsx(TabsTrigger, { value: "data", children: "Data" }), _jsx(TabsTrigger, { value: "definition", children: "Definition" })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs(Button, { ref: filterBtnRef, size: "sm", variant: "ghost", onClick: openFilter, children: [_jsx(Filter, { className: "h-3.5 w-3.5" }), " Filter", filters.length > 0 && (_jsx(Badge, { className: "ml-1 h-4 px-1 text-[10px]", children: filters.length }))] }), _jsxs(Button, { ref: sortBtnRef, size: "sm", variant: "ghost", onClick: openSort, children: [_jsx(ArrowUpDown, { className: "h-3.5 w-3.5" }), " Sort", sorts.length > 0 && (_jsx(Badge, { className: "ml-1 h-4 px-1 text-[10px]", children: sorts.length }))] }), _jsxs(Button, { size: "sm", onClick: () => setDrawerRow(null), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Insert"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => {
                                            dataQ.refetch();
                                            colsQ.refetch();
                                            toast.success("Refreshed");
                                        }, children: [_jsx(RefreshCw, { className: cn("h-3.5 w-3.5", dataQ.isFetching && "animate-spin") }), " Refresh"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => {
                                            navigator.clipboard.writeText(window.location.href).then(() => toast.success("Link copied"), () => toast.error("Copy failed"));
                                        }, title: "Copy shareable link", children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Share"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: exportCsv, children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " CSV"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setCsvImportOpen(true), children: [_jsx(Upload, { className: "h-3.5 w-3.5" }), " Import"] }), selected.size > 0 && (_jsxs(_Fragment, { children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: () => setBulkEditOpen(true), children: ["Edit ", selected.size] }), _jsxs(Button, { size: "sm", variant: "destructive", onClick: deleteSelected, children: [_jsx(Trash2, { className: "h-3.5 w-3.5" }), " Delete ", selected.size] })] }))] })] }), _jsxs(TabsContent, { value: "data", className: "flex-1 flex flex-col min-h-0 mt-0", children: [_jsx("div", { className: "flex-1 min-h-0 relative", children: _jsx(DataGrid, { columns: columns, rows: rows, loading: dataQ.isLoading || colsQ.isLoading, selectable: true, selected: selected, onToggleSelect: (i) => {
                                        const s = new Set(selected);
                                        s.has(i) ? s.delete(i) : s.add(i);
                                        setSelected(s);
                                    }, onToggleSelectAll: (all) => setSelected(all ? new Set(rows.map((_, i) => i)) : new Set()), onEditCell: onEditCell, onEditJsonCell: (r, c) => setJsonCell({ r, c }), onExpandRow: (i) => setDrawerRow(i), widthStorageKey: ready ? `${id}.${schema}.${table}` : undefined }) }), _jsx("div", { className: "flex items-center justify-between px-4 py-2 border-t border-border text-xs text-muted-foreground font-mono", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", disabled: page === 0, onClick: () => setPage((p) => p - 1), children: _jsx(ChevronLeft, { className: "h-3.5 w-3.5" }) }), _jsx("span", { children: "Page" }), _jsx(Input, { inputMode: "numeric", value: page + 1, onChange: (e) => {
                                                const v = e.target.value.replace(/\D/g, "");
                                                const n = Number(v);
                                                if (Number.isFinite(n))
                                                    setPage(Math.max(0, Math.min(maxPage, n - 1)));
                                            }, className: "h-7 w-14 text-center font-mono text-xs" }), _jsxs("span", { children: ["of ", maxPage + 1] }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", disabled: page >= maxPage, onClick: () => setPage((p) => p + 1), children: _jsx(ChevronRight, { className: "h-3.5 w-3.5" }) }), _jsxs(Button, { ref: pageSizeBtnRef, size: "sm", variant: "outline", className: "h-7", onClick: () => setPageSizeOpen((v) => !v), children: [pageSize, " rows"] }), _jsx("span", { children: total == null
                                                ? "many records"
                                                : totalIsEstimate
                                                    ? `~${total.toLocaleString()} records (estimate)`
                                                    : `${total.toLocaleString()} records` })] }) })] }), _jsx(TabsContent, { value: "definition", className: "flex-1 overflow-auto mt-0 p-4 space-y-4", children: _jsx(DefinitionPane, { id: id, columns: colsQ.data ?? [], table: table, schema: schema, loading: colsQ.isLoading }) })] }), _jsx(Popover, { open: filterOpen, onOpenChange: setFilterOpen, anchorRef: filterBtnRef, align: "end", className: "w-140", children: _jsxs("div", { className: "space-y-2", children: [filterDraft.length === 0 && (_jsx("div", { className: "text-xs text-muted-foreground px-2 py-3", children: "No filters applied. Add one below." })), filterDraft.map((f, i) => (_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Select, { value: f.column, onValueChange: (v) => setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x))), children: [_jsx(SelectTrigger, { className: "h-8 w-40 text-xs", children: _jsx(SelectValue, { placeholder: "Column" }) }), _jsx(SelectContent, { className: "max-h-64", children: (colsQ.data ?? []).map((c) => (_jsxs(SelectItem, { value: c.name, children: [_jsx("span", { className: "font-mono", children: c.name }), _jsx("span", { className: "ml-2 text-muted-foreground text-[10px]", children: c.dataType })] }, c.name))) })] }), _jsxs(Select, { value: f.op, onValueChange: (v) => setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, op: v } : x))), children: [_jsx(SelectTrigger, { className: "h-8 w-24 text-xs", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { className: "max-h-72", children: FILTER_OPS.map((o) => (_jsx(SelectItem, { value: o.op, children: _jsx("span", { className: "font-mono text-xs", children: o.label }) }, o.op))) })] }), _jsx(Input, { value: f.value, onChange: (e) => setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x))), disabled: f.op === "is null" || f.op === "is not null", placeholder: f.op === "in" ? "a, b, c" : "Enter a value", className: "h-8 text-xs font-mono flex-1" }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", onClick: () => setFilterDraft((xs) => xs.filter((_, j) => j !== i)), children: _jsx(X, { className: "h-3.5 w-3.5" }) })] }, i))), _jsxs("div", { className: "flex items-center justify-between pt-2 border-t border-border", children: [_jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setFilterDraft((xs) => [
                                        ...xs,
                                        { column: colsQ.data?.[0]?.name ?? "", op: "=", value: "" },
                                    ]), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add filter"] }), _jsx(Button, { size: "sm", onClick: applyFilters, children: "Apply filter" })] })] }) }), _jsx(Popover, { open: sortOpen, onOpenChange: setSortOpen, anchorRef: sortBtnRef, align: "end", className: "w-110", children: _jsxs("div", { className: "space-y-2", children: [sortDraft.length === 0 && (_jsx("div", { className: "text-xs text-muted-foreground px-2 py-3", children: "No sorts applied. Add one below." })), sortDraft.map((s, i) => (_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Select, { value: s.column, onValueChange: (v) => setSortDraft((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x))), children: [_jsx(SelectTrigger, { className: "h-8 flex-1 text-xs", children: _jsx(SelectValue, { placeholder: "Column" }) }), _jsx(SelectContent, { className: "max-h-64", children: (colsQ.data ?? []).map((c) => (_jsxs(SelectItem, { value: c.name, children: [_jsx("span", { className: "font-mono", children: c.name }), _jsx("span", { className: "ml-2 text-muted-foreground text-[10px]", children: c.dataType })] }, c.name))) })] }), _jsxs(Button, { size: "sm", variant: "outline", className: "h-8", onClick: () => setSortDraft((xs) => xs.map((x, j) => (j === i ? { ...x, direction: x.direction === "asc" ? "desc" : "asc" } : x))), children: [s.direction === "asc" ? _jsx(ArrowUp, { className: "h-3.5 w-3.5" }) : _jsx(ArrowDown, { className: "h-3.5 w-3.5" }), s.direction.toUpperCase()] }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", onClick: () => setSortDraft((xs) => xs.filter((_, j) => j !== i)), children: _jsx(X, { className: "h-3.5 w-3.5" }) })] }, i))), _jsxs("div", { className: "flex items-center justify-between pt-2 border-t border-border", children: [_jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setSortDraft((xs) => [
                                        ...xs,
                                        { column: colsQ.data?.[0]?.name ?? "", direction: "asc" },
                                    ]), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add sort"] }), _jsx(Button, { size: "sm", onClick: applySorts, children: "Apply sort" })] })] }) }), _jsx(Popover, { open: pageSizeOpen, onOpenChange: setPageSizeOpen, anchorRef: pageSizeBtnRef, align: "center", side: "top", className: "w-40 p-1", children: _jsx("div", { className: "flex flex-col", children: PAGE_SIZES.map((n) => (_jsxs("button", { onClick: () => {
                            setPageSize(n);
                            setPage(0);
                            setPageSizeOpen(false);
                        }, className: `px-3 py-1.5 text-left text-xs rounded hover:bg-accent ${pageSize === n ? "font-semibold" : ""}`, children: [n, " rows"] }, n))) }) }), drawerRow !== -1 && (_jsx(RowDrawer, { connectionId: id, schema: schema, table: table, columns: colsQ.data ?? [], row: drawerRow === null ? null : rows[drawerRow] ?? null, onClose: () => setDrawerRow(-1), onSaved: () => {
                    dataQ.refetch();
                } })), jsonCell && (_jsx(JsonFieldEditor, { open: true, fieldName: jsonCell.c, value: rows[jsonCell.r]?.[jsonCell.c] ?? null, onClose: () => setJsonCell(null), onSave: async (next) => {
                    onEditCell(jsonCell.r, jsonCell.c, next);
                } })), ready && (_jsx(BulkEditDialog, { open: bulkEditOpen, onOpenChange: setBulkEditOpen, connectionId: id, schema: schema, table: table, columns: colsQ.data ?? [], pks: Array.from(selected).map((i) => {
                    const row = rows[i];
                    const pk = {};
                    for (const c of pkCols)
                        pk[c] = row[c];
                    return pk;
                }), onApplied: () => {
                    setSelected(new Set());
                    qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
                } })), ready && (_jsx(CsvImportDialog, { open: csvImportOpen, onOpenChange: setCsvImportOpen, connectionId: id, schema: schema, table: table, tableColumns: colsQ.data ?? [], onCommitted: () => qc.invalidateQueries({ queryKey: ["data", id, schema, table] }) }))] }));
}
function DefinitionPane({ id, columns, table, schema, loading }) {
    const isDark = useTheme((s) => s.theme === "dark");
    const defQ = useQuery({
        queryKey: ["definition", id, schema, table],
        queryFn: () => api.getTableDefinition(id, table, schema),
        enabled: !!id && !!table && !!schema,
    });
    const ddl = defQ.data?.sql ?? "";
    if (loading || defQ.isLoading)
        return _jsx("div", { className: "text-sm text-muted-foreground", children: "Loading..." });
    if (columns.length === 0)
        return _jsx("div", { className: "text-sm text-muted-foreground", children: "No column data" });
    return (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold mb-2", children: "Columns" }), _jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-xs font-mono", children: [_jsx("thead", { className: "bg-muted", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Name" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Type" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Nullable" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Default" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Key" })] }) }), _jsx("tbody", { children: columns.map((c) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "px-3 py-2", children: c.name }), _jsx("td", { className: "px-3 py-2 text-primary", children: c.dataType }), _jsx("td", { className: "px-3 py-2", children: c.nullable ? "YES" : "NO" }), _jsx("td", { className: "px-3 py-2 text-muted-foreground", children: c.defaultValue ?? "" }), _jsxs("td", { className: "px-3 py-2 flex gap-1", children: [c.isPrimaryKey && _jsx(Badge, { children: "PK" }), c.isUnique && _jsx(Badge, { variant: "info", children: "UQ" }), c.fk && _jsxs(Badge, { variant: "warning", children: ["FK \u2192 ", c.fk.table, ".", c.fk.column] })] })] }, c.name))) })] }) })] }), _jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold mb-2", children: "CREATE TABLE" }), _jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsx(Editor, { height: `${Math.max(ddl.split("\n").length, 1) * 19 + 16}px`, defaultLanguage: "sql", theme: isDark ? "vs-dark" : "vs", value: ddl, options: {
                                readOnly: true,
                                minimap: { enabled: false },
                                fontSize: 12,
                                fontFamily: "JetBrains Mono, monospace",
                                scrollBeyondLastLine: false,
                                scrollbar: { vertical: "hidden", handleMouseWheel: false, alwaysConsumeMouseWheel: false },
                            } }) })] })] }));
}
function EmptyState() {
    return (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Select a table from the sidebar to view its data." }));
}
