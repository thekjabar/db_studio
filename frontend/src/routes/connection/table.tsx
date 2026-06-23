import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DataGrid } from "@/components/data-grid";
import { Popover } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, extractErrorMessage, type ColumnInfo } from "@/lib/api";
import { cn } from "@/lib/utils";
import { RowDrawer } from "@/components/row-drawer";
import { JsonFieldEditor } from "@/components/json-field-editor";
import { BulkEditDialog } from "@/components/bulk-edit-dialog";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { useTableSubscription } from "@/lib/realtime";
import { useTheme } from "@/lib/theme-store";
import { useModal } from "@/components/modal-provider";

const PAGE_SIZES = [100, 500, 1000] as const;
type PageSize = (typeof PAGE_SIZES)[number];

type FilterRow = { column: string; op: string; value: string };
type SortRow = { column: string; direction: "asc" | "desc" };

const FILTER_OPS: { op: string; label: string }[] = [
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
function coerceFilterValue(raw: string, op: string): unknown {
  if (op === "is null" || op === "is not null") return null;
  if (op === "in") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (raw === "") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export default function TableRoute() {
  const { id, schema, table } = useParams<{ id: string; schema: string; table: string }>();
  const qc = useQueryClient();
  const modal = useModal();
  const [searchParams, setSearchParams] = useSearchParams();

  // Initial state hydrated from URL so links are shareable.
  const [page, setPage] = useState(() => {
    const p = Number(searchParams.get("page"));
    return Number.isFinite(p) && p >= 0 ? p : 0;
  });
  const [pageSize, setPageSize] = useState<PageSize>(() => {
    const n = Number(searchParams.get("size"));
    return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : 100;
  });
  const [filters, setFilters] = useState<FilterRow[]>(() => {
    const raw = searchParams.get("f");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [sorts, setSorts] = useState<SortRow[]>(() => {
    const raw = searchParams.get("s");
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Push state to URL as a shareable link. Keep query-string compact.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (page > 0) next.set("page", String(page)); else next.delete("page");
    if (pageSize !== 100) next.set("size", String(pageSize)); else next.delete("size");
    if (filters.length) next.set("f", JSON.stringify(filters)); else next.delete("f");
    if (sorts.length) next.set("s", JSON.stringify(sorts)); else next.delete("s");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, filters, sorts]);

  const filterBtnRef = useRef<HTMLButtonElement | null>(null);
  const sortBtnRef = useRef<HTMLButtonElement | null>(null);
  const pageSizeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [pageSizeOpen, setPageSizeOpen] = useState(false);

  // Drafts — edits don't commit until "Apply" is clicked.
  const [filterDraft, setFilterDraft] = useState<FilterRow[]>([]);
  const [sortDraft, setSortDraft] = useState<SortRow[]>([]);

  // Row drawer: -1 = closed, null = inserting new, number = editing that row idx.
  const [drawerRow, setDrawerRow] = useState<number | null | -1>(-1);
  // JSON cell editor: { rowIdx, column } when open.
  const [jsonCell, setJsonCell] = useState<{ r: number; c: string } | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);

  const ready = !!id && !!schema && !!table;

  // Live-update: when the backend sees a change for this (schema.table), refetch.
  useTableSubscription(
    { connectionId: id, schema, table, enabled: ready },
    () => {
      qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
    },
  );

  const colsQ = useQuery({
    queryKey: ["columns", id, schema, table],
    queryFn: () => api.getTableColumns(id!, table!, schema!),
    enabled: ready,
  });

  const appliedFilters = useMemo(
    () =>
      filters
        .filter((f) => f.column && f.op)
        .map((f) => ({ column: f.column, op: f.op, value: coerceFilterValue(f.value, f.op) })),
    [filters],
  );

  const dataQ = useQuery({
    queryKey: ["data", id, schema, table, page, pageSize, appliedFilters, sorts],
    queryFn: () =>
      api.getTableData(id!, table!, {
        schema: schema!,
        limit: pageSize,
        offset: page * pageSize,
        filters: appliedFilters,
        orderBy: sorts,
      }),
    enabled: ready,
  });

  const updateRow = useMutation({
    mutationFn: (vars: { pk: Record<string, unknown>; set: Record<string, unknown> }) =>
      api.updateRow(id!, table!, { schema: schema!, pk: vars.pk, set: vars.set }),
    onSuccess: () => {
      toast.success("Row updated");
      qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const deleteRows = useMutation({
    mutationFn: (pks: Record<string, unknown>[]) =>
      api.bulkDeleteRows(id!, table!, { schema: schema!, pks }),
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
  const maxPage =
    total == null
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
    if (!rows.length) return;
    const cols = columns.map((c) => c.name);
    const csv = [
      cols.join(","),
      ...rows.map((r) => cols.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return "";
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

  const onEditCell = (rowIdx: number, column: string, value: unknown) => {
    if (pkCols.length === 0) {
      toast.error("Cannot edit: no primary key");
      return;
    }
    const row = rows[rowIdx];
    const pk: Record<string, unknown> = {};
    for (const c of pkCols) pk[c] = row[c];
    updateRow.mutate({ pk, set: { [column]: value } });
  };

  const deleteSelected = async () => {
    if (pkCols.length === 0) {
      toast.error("Cannot delete: no primary key");
      return;
    }
    const pks: Record<string, unknown>[] = [];
    selected.forEach((i) => {
      const r = rows[i];
      const pk: Record<string, unknown> = {};
      for (const c of pkCols) pk[c] = r[c];
      pks.push(pk);
    });
    const ok = await modal.confirm({
      title: `Delete ${pks.length} row(s)?`,
      description: "This permanently removes the selected rows.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (ok) deleteRows.mutate(pks);
  };

  if (!ready) return <EmptyState />;

  return (
    <div className="h-full flex flex-col">
      <Tabs defaultValue="data" className="flex flex-col h-full">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border flex-wrap">
          <TabsList>
            <TabsTrigger value="data">Data</TabsTrigger>
            <TabsTrigger value="definition">Definition</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <Button ref={filterBtnRef} size="sm" variant="ghost" onClick={openFilter}>
              <Filter className="h-3.5 w-3.5" /> Filter
              {filters.length > 0 && (
                <Badge className="ml-1 h-4 px-1 text-[10px]">{filters.length}</Badge>
              )}
            </Button>
            <Button ref={sortBtnRef} size="sm" variant="ghost" onClick={openSort}>
              <ArrowUpDown className="h-3.5 w-3.5" /> Sort
              {sorts.length > 0 && (
                <Badge className="ml-1 h-4 px-1 text-[10px]">{sorts.length}</Badge>
              )}
            </Button>
            <Button size="sm" onClick={() => setDrawerRow(null)}>
              <Plus className="h-3.5 w-3.5" /> Insert
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                dataQ.refetch();
                colsQ.refetch();
                toast.success("Refreshed");
              }}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", dataQ.isFetching && "animate-spin")} /> Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(window.location.href).then(
                  () => toast.success("Link copied"),
                  () => toast.error("Copy failed"),
                );
              }}
              title="Copy shareable link"
            >
              <Share2 className="h-3.5 w-3.5" /> Share
            </Button>
            <Button size="sm" variant="ghost" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCsvImportOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Import
            </Button>
            {selected.size > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={() => setBulkEditOpen(true)}>
                  Edit {selected.size}
                </Button>
                <Button size="sm" variant="destructive" onClick={deleteSelected}>
                  <Trash2 className="h-3.5 w-3.5" /> Delete {selected.size}
                </Button>
              </>
            )}
          </div>
        </div>

        <TabsContent value="data" className="flex-1 flex flex-col min-h-0 mt-0">
          <div className="flex-1 min-h-0 relative">
            <DataGrid
              columns={columns}
              rows={rows}
              loading={dataQ.isLoading || colsQ.isLoading}
              selectable
              selected={selected}
              onToggleSelect={(i) => {
                const s = new Set(selected);
                s.has(i) ? s.delete(i) : s.add(i);
                setSelected(s);
              }}
              onToggleSelectAll={(all) => setSelected(all ? new Set(rows.map((_, i) => i)) : new Set())}
              onEditCell={onEditCell}
              onEditJsonCell={(r, c) => setJsonCell({ r, c })}
              onExpandRow={(i) => setDrawerRow(i)}
              widthStorageKey={ready ? `${id}.${schema}.${table}` : undefined}
            />
          </div>
          <div className="flex items-center justify-between px-4 py-2 border-t border-border text-xs text-muted-foreground font-mono">
            <div className="flex items-center gap-2">
              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <span>Page</span>
              <Input
                inputMode="numeric"
                value={page + 1}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  const n = Number(v);
                  if (Number.isFinite(n)) setPage(Math.max(0, Math.min(maxPage, n - 1)));
                }}
                className="h-7 w-14 text-center font-mono text-xs"
              />
              <span>of {maxPage + 1}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
              <Button
                ref={pageSizeBtnRef}
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => setPageSizeOpen((v) => !v)}
              >
                {pageSize} rows
              </Button>
              <span>
                {total == null
                  ? "many records"
                  : totalIsEstimate
                    ? `~${total.toLocaleString()} records (estimate)`
                    : `${total.toLocaleString()} records`}
              </span>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="definition" className="flex-1 overflow-auto mt-0 p-4 space-y-4">
          <DefinitionPane id={id!} columns={colsQ.data ?? []} table={table} schema={schema} loading={colsQ.isLoading} />
        </TabsContent>
      </Tabs>

      <Popover open={filterOpen} onOpenChange={setFilterOpen} anchorRef={filterBtnRef} align="end" className="w-140">
        <div className="space-y-2">
          {filterDraft.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-3">No filters applied. Add one below.</div>
          )}
          {filterDraft.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={f.column}
                onValueChange={(v) =>
                  setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x)))
                }
              >
                <SelectTrigger className="h-8 w-40 text-xs">
                  <SelectValue placeholder="Column" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(colsQ.data ?? []).map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      <span className="font-mono">{c.name}</span>
                      <span className="ml-2 text-muted-foreground text-[10px]">{c.dataType}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={f.op}
                onValueChange={(v) => setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, op: v } : x)))}
              >
                <SelectTrigger className="h-8 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {FILTER_OPS.map((o) => (
                    <SelectItem key={o.op} value={o.op}>
                      <span className="font-mono text-xs">{o.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={f.value}
                onChange={(e) =>
                  setFilterDraft((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
                }
                disabled={f.op === "is null" || f.op === "is not null"}
                placeholder={f.op === "in" ? "a, b, c" : "Enter a value"}
                className="h-8 text-xs font-mono flex-1"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setFilterDraft((xs) => xs.filter((_, j) => j !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setFilterDraft((xs) => [
                  ...xs,
                  { column: colsQ.data?.[0]?.name ?? "", op: "=", value: "" },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add filter
            </Button>
            <Button size="sm" onClick={applyFilters}>Apply filter</Button>
          </div>
        </div>
      </Popover>

      <Popover open={sortOpen} onOpenChange={setSortOpen} anchorRef={sortBtnRef} align="end" className="w-110">
        <div className="space-y-2">
          {sortDraft.length === 0 && (
            <div className="text-xs text-muted-foreground px-2 py-3">No sorts applied. Add one below.</div>
          )}
          {sortDraft.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={s.column}
                onValueChange={(v) =>
                  setSortDraft((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x)))
                }
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue placeholder="Column" />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {(colsQ.data ?? []).map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      <span className="font-mono">{c.name}</span>
                      <span className="ml-2 text-muted-foreground text-[10px]">{c.dataType}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-8"
                onClick={() =>
                  setSortDraft((xs) =>
                    xs.map((x, j) => (j === i ? { ...x, direction: x.direction === "asc" ? "desc" : "asc" } : x)),
                  )
                }
              >
                {s.direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
                {s.direction.toUpperCase()}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setSortDraft((xs) => xs.filter((_, j) => j !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSortDraft((xs) => [
                  ...xs,
                  { column: colsQ.data?.[0]?.name ?? "", direction: "asc" },
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add sort
            </Button>
            <Button size="sm" onClick={applySorts}>Apply sort</Button>
          </div>
        </div>
      </Popover>

      <Popover open={pageSizeOpen} onOpenChange={setPageSizeOpen} anchorRef={pageSizeBtnRef} align="center" side="top" className="w-40 p-1">
        <div className="flex flex-col">
          {PAGE_SIZES.map((n) => (
            <button
              key={n}
              onClick={() => {
                setPageSize(n);
                setPage(0);
                setPageSizeOpen(false);
              }}
              className={`px-3 py-1.5 text-left text-xs rounded hover:bg-accent ${
                pageSize === n ? "font-semibold" : ""
              }`}
            >
              {n} rows
            </button>
          ))}
        </div>
      </Popover>

      {drawerRow !== -1 && (
        <RowDrawer
          connectionId={id!}
          schema={schema!}
          table={table!}
          columns={colsQ.data ?? []}
          row={drawerRow === null ? null : rows[drawerRow] ?? null}
          onClose={() => setDrawerRow(-1)}
          onSaved={() => {
            dataQ.refetch();
          }}
        />
      )}

      {jsonCell && (
        <JsonFieldEditor
          open
          fieldName={jsonCell.c}
          value={rows[jsonCell.r]?.[jsonCell.c] ?? null}
          onClose={() => setJsonCell(null)}
          onSave={async (next) => {
            onEditCell(jsonCell.r, jsonCell.c, next);
          }}
        />
      )}

      {ready && (
        <BulkEditDialog
          open={bulkEditOpen}
          onOpenChange={setBulkEditOpen}
          connectionId={id!}
          schema={schema!}
          table={table!}
          columns={colsQ.data ?? []}
          pks={Array.from(selected).map((i) => {
            const row = rows[i];
            const pk: Record<string, unknown> = {};
            for (const c of pkCols) pk[c] = row[c];
            return pk;
          })}
          onApplied={() => {
            setSelected(new Set());
            qc.invalidateQueries({ queryKey: ["data", id, schema, table] });
          }}
        />
      )}

      {ready && (
        <CsvImportDialog
          open={csvImportOpen}
          onOpenChange={setCsvImportOpen}
          connectionId={id!}
          schema={schema!}
          table={table!}
          tableColumns={colsQ.data ?? []}
          onCommitted={() => qc.invalidateQueries({ queryKey: ["data", id, schema, table] })}
        />
      )}
    </div>
  );
}

function DefinitionPane({ id, columns, table, schema, loading }: { id: string; columns: ColumnInfo[]; table: string; schema: string; loading?: boolean }) {
  const isDark = useTheme((s) => s.theme === "dark");
  const defQ = useQuery({
    queryKey: ["definition", id, schema, table],
    queryFn: () => api.getTableDefinition(id, table, schema),
    enabled: !!id && !!table && !!schema,
  });

  const ddl = defQ.data?.sql ?? "";

  if (loading || defQ.isLoading) return <div className="text-sm text-muted-foreground">Loading...</div>;
  if (columns.length === 0) return <div className="text-sm text-muted-foreground">No column data</div>;

  return (
    <>
      <div>
        <h3 className="text-sm font-semibold mb-2">Columns</h3>
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs font-mono">
            <thead className="bg-muted">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Nullable</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Default</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Key</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => (
                <tr key={c.name} className="border-t border-border">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-primary">{c.dataType}</td>
                  <td className="px-3 py-2">{c.nullable ? "YES" : "NO"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{c.defaultValue ?? ""}</td>
                  <td className="px-3 py-2 flex gap-1">
                    {c.isPrimaryKey && <Badge>PK</Badge>}
                    {c.isUnique && <Badge variant="info">UQ</Badge>}
                    {c.fk && <Badge variant="warning">FK → {c.fk.table}.{c.fk.column}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">CREATE TABLE</h3>
        <div className="rounded-md border border-border overflow-hidden">
          <Editor
            height={`${Math.max(ddl.split("\n").length, 1) * 19 + 16}px`}
            defaultLanguage="sql"
            theme={isDark ? "vs-dark" : "vs"}
            value={ddl}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "JetBrains Mono, monospace",
              scrollBeyondLastLine: false,
              scrollbar: { vertical: "hidden", handleMouseWheel: false, alwaysConsumeMouseWheel: false },
            }}
          />
        </div>
      </div>
    </>
  );
}

function EmptyState() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      Select a table from the sidebar to view its data.
    </div>
  );
}
