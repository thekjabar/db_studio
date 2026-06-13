import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Blocks, Code2, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type QueryResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { DataGrid } from "@/components/data-grid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Filter = { column: string; op: string; value: string };

const OPS = ["=", "!=", ">", ">=", "<", "<=", "LIKE", "ILIKE", "IS NULL", "IS NOT NULL"];

/**
 * No-SQL visual query builder: pick table → columns → filters → sort → run.
 * Generates plain SELECT SQL (shown live) so it doubles as a learning tool —
 * "Open in SQL editor" hands the generated query over for refinement.
 */
export default function QueryBuilderRoute() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const ctx = useOutletContext<{ schema?: string } | null>();
  const schema = ctx?.schema ?? "public";

  const [table, setTable] = useState("");
  const [cols, setCols] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filter[]>([]);
  const [orderBy, setOrderBy] = useState("");
  const [orderDir, setOrderDir] = useState<"ASC" | "DESC">("ASC");
  const [limit, setLimit] = useState("100");
  const [result, setResult] = useState<QueryResult | null>(null);

  const tablesQ = useQuery({
    queryKey: ["tables", id, schema],
    queryFn: () => api.listTables(id!, schema),
    enabled: !!id && !!schema,
  });
  const columnsQ = useQuery({
    queryKey: ["columns", id, schema, table],
    queryFn: () => api.getTableColumns(id!, table, schema),
    enabled: !!id && !!table,
  });

  useEffect(() => {
    setCols(new Set());
    setFilters([]);
    setOrderBy("");
    setResult(null);
  }, [table]);

  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

  const sql = useMemo(() => {
    if (!table) return "";
    const colList = cols.size > 0 ? [...cols].map(q).join(", ") : "*";
    let s = `SELECT ${colList}\nFROM ${q(schema)}.${q(table)}`;
    const conds = filters
      .filter((f) => f.column && (f.op.includes("NULL") || f.value !== ""))
      .map((f) => {
        if (f.op.includes("NULL")) return `${q(f.column)} ${f.op}`;
        const v = /^-?\d+(\.\d+)?$/.test(f.value.trim())
          ? f.value.trim()
          : `'${f.value.replace(/'/g, "''")}'`;
        return `${q(f.column)} ${f.op} ${v}`;
      });
    if (conds.length) s += `\nWHERE ${conds.join("\n  AND ")}`;
    if (orderBy) s += `\nORDER BY ${q(orderBy)} ${orderDir}`;
    const lim = parseInt(limit, 10);
    if (lim > 0) s += `\nLIMIT ${Math.min(lim, 10000)}`;
    return s + ";";
  }, [table, cols, filters, orderBy, orderDir, limit, schema]);

  const run = useMutation({
    mutationFn: () => api.runQuery(id!, { sql, maxRows: 1000 }),
    onSuccess: (r) => {
      setResult(r);
      toast.success(`${r.rowCount ?? r.rows.length} rows · ${r.durationMs}ms`);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Blocks className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Query builder</div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!sql}
            onClick={() => nav(`/c/${id}/sql?sql=${encodeURIComponent(sql)}`)}
          >
            <Code2 className="h-3.5 w-3.5" /> Open in SQL editor
          </Button>
          <Button size="sm" onClick={() => run.mutate()} disabled={!sql || run.isPending}>
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[340px_1fr]">
        <div className="border-r border-border p-3 space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <Label>Table</Label>
            <Select value={table} onValueChange={setTable}>
              <SelectTrigger>
                <SelectValue placeholder={tablesQ.isLoading ? "Loading…" : "Pick a table"} />
              </SelectTrigger>
              <SelectContent>
                {(tablesQ.data ?? []).map((t) => (
                  <SelectItem key={t.name} value={t.name} className="font-mono">{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {table && (
            <>
              <div className="space-y-1.5">
                <Label>Columns <span className="text-muted-foreground font-normal">(none = all)</span></Label>
                <div className="max-h-44 overflow-y-auto rounded border border-border p-2 space-y-1">
                  {(columnsQ.data ?? []).map((c) => (
                    <label key={c.name} className="flex items-center gap-2 text-xs cursor-pointer px-1 py-0.5 hover:bg-accent rounded">
                      <Checkbox
                        checked={cols.has(c.name)}
                        onCheckedChange={(v) => {
                          const next = new Set(cols);
                          v ? next.add(c.name) : next.delete(c.name);
                          setCols(next);
                        }}
                      />
                      <span className="font-mono">{c.name}</span>
                      <span className="text-muted-foreground ml-auto">{c.type}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Filters</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5"
                    onClick={() => setFilters((f) => [...f, { column: "", op: "=", value: "" }])}
                  >
                    <Plus className="h-3 w-3" /> Add
                  </Button>
                </div>
                {filters.map((f, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <Select value={f.column || undefined} onValueChange={(v) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, column: v } : x)))}>
                      <SelectTrigger className="h-8 text-xs flex-1"><SelectValue placeholder="column" /></SelectTrigger>
                      <SelectContent>
                        {(columnsQ.data ?? []).map((c) => (
                          <SelectItem key={c.name} value={c.name} className="font-mono">{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={f.op} onValueChange={(v) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, op: v } : x)))}>
                      <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {OPS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {!f.op.includes("NULL") && (
                      <Input
                        className="h-8 text-xs flex-1"
                        value={f.value}
                        onChange={(e) => setFilters((xs) => xs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                        placeholder="value"
                      />
                    )}
                    <button
                      onClick={() => setFilters((xs) => xs.filter((_, j) => j !== i))}
                      className="p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-[1fr_90px_80px] gap-2">
                <div className="space-y-1.5">
                  <Label>Order by</Label>
                  <Select value={orderBy || "__none__"} onValueChange={(v) => setOrderBy(v === "__none__" ? "" : v)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">—</SelectItem>
                      {(columnsQ.data ?? []).map((c) => (
                        <SelectItem key={c.name} value={c.name} className="font-mono">{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Dir</Label>
                  <Select value={orderDir} onValueChange={(v: "ASC" | "DESC") => setOrderDir(v)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ASC">ASC</SelectItem>
                      <SelectItem value="DESC">DESC</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Limit</Label>
                  <Input className="h-8 text-xs" value={limit} onChange={(e) => setLimit(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {sql && (
            <div className="space-y-1">
              <Label>Generated SQL</Label>
              <pre className="text-[11px] font-mono bg-muted rounded p-2 whitespace-pre-wrap">{sql}</pre>
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-auto">
          {result ? (
            <DataGrid
              columns={result.fields.map((f) => ({ name: f.name, type: f.dataType }))}
              rows={result.rows}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Pick a table, add filters, hit Run.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
