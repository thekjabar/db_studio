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
  const { id } = useParams<{ id: string }>();
  const ctx = useOutletContext<{ schema?: string } | null>();
  const schema = ctx?.schema ?? "public";
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const erQ = useQuery({
    queryKey: ["er", id, schema],
    queryFn: () => api.getEr(id!, schema),
    enabled: !!id,
  });
  const tablesQ = useQuery({
    queryKey: ["tables", id, schema],
    queryFn: () => api.listTables(id!, schema),
    enabled: !!id,
  });

  const rowEstimates = useMemo(() => {
    const m = new Map<string, number | undefined>();
    for (const t of tablesQ.data ?? []) m.set(t.name, t.rowEstimate);
    return m;
  }, [tablesQ.data]);

  // FK lookup: which columns reference what, and what references this table.
  const fkOut = useMemo(() => {
    const m = new Map<string, { col: string; refTable: string; refCols: string }[]>();
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
    if (!f) return list;
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(f) ||
        t.columns.some((c) => c.name.toLowerCase().includes(f)),
    );
  }, [erQ.data, filter]);

  const current = tables.find((t) => t.id === selected) ?? tables[0] ?? null;

  if (erQ.isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Introspecting schema…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <BookOpenText className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Data dictionary</div>
        <span className="text-xs text-muted-foreground">
          {erQ.data?.nodes.length ?? 0} tables · {erQ.data?.edges.length ?? 0} relationships · schema <span className="font-mono">{schema}</span>
        </span>
        <div className="relative ml-auto w-64">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search tables or columns…"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[260px_1fr]">
        <div className="border-r border-border overflow-y-auto">
          {tables.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={cn(
                "w-full text-left px-3 py-1.5 text-xs font-mono flex items-center gap-2 hover:bg-accent",
                current?.id === t.id && "bg-accent text-primary",
              )}
            >
              <Table2 className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate flex-1">{t.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {rowEstimates.get(t.name)?.toLocaleString() ?? ""}
              </span>
            </button>
          ))}
          {tables.length === 0 && (
            <div className="p-4 text-xs text-muted-foreground">No tables match.</div>
          )}
        </div>

        <div className="overflow-y-auto p-4">
          {current ? (
            <>
              <div className="flex items-center gap-3 mb-1">
                <h2 className="font-mono font-semibold">{current.schema}.{current.name}</h2>
                <Badge variant="outline">{current.columns.length} columns</Badge>
                {rowEstimates.get(current.name) !== undefined && (
                  <Badge variant="secondary">~{rowEstimates.get(current.name)?.toLocaleString()} rows</Badge>
                )}
                <Link to={`/c/${id}/t/${encodeURIComponent(current.schema)}/${encodeURIComponent(current.name)}`} className="text-xs text-primary hover:underline ml-auto">
                  Browse data →
                </Link>
              </div>

              <table className="w-full text-sm mt-3">
                <thead className="text-xs text-muted-foreground">
                  <tr className="text-left border-b border-border">
                    <th className="py-1.5 pr-3 font-medium w-6"></th>
                    <th className="py-1.5 pr-3 font-medium">Column</th>
                    <th className="py-1.5 pr-3 font-medium">Type</th>
                    <th className="py-1.5 font-medium">References</th>
                  </tr>
                </thead>
                <tbody>
                  {current.columns.map((c) => {
                    const fk = (fkOut.get(current.id) ?? []).find((f) =>
                      f.col.split(",").includes(c.name),
                    );
                    return (
                      <tr key={c.name} className="border-b border-border/50">
                        <td className="py-1.5 pr-2">
                          {c.pk ? (
                            <Key className="h-3 w-3 text-amber-500" />
                          ) : fk ? (
                            <KeyRound className="h-3 w-3 text-sky-500" />
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-xs">{c.name}</td>
                        <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground">{c.type}</td>
                        <td className="py-1.5 text-xs text-muted-foreground font-mono">
                          {fk ? `→ ${fk.refTable}(${fk.refCols})` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">Select a table.</div>
          )}
        </div>
      </div>
    </div>
  );
}
