import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Database, GitBranch, Loader2, Play, Plus, Trash2, Workflow } from "lucide-react";
import {
  api,
  extractErrorMessage,
  type Connection,
  type FederatedPlan,
  type FederatedQueryResult,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataGrid } from "@/components/data-grid";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";

interface SourceRow {
  alias: string;
  connectionId: string;
}

const EXAMPLE_SQL = `-- Join tables across connections using your chosen aliases
-- Example: SELECT u.email, o.total
--          FROM src1.public.users u
--          JOIN src2.main.orders o ON u.id = o.user_id
SELECT 1 AS hello;`;

export default function FederatedRoute() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [sources, setSources] = useState<SourceRow[]>([{ alias: "src1", connectionId: "" }]);
  const [sql, setSql] = useState(EXAMPLE_SQL);
  const [maxRows, setMaxRows] = useState(1000);
  const [result, setResult] = useState<FederatedQueryResult | null>(null);
  const [plan, setPlan] = useState<FederatedPlan | null>(null);

  const connectionsQ = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.listConnections(),
  });

  const usable = (connectionsQ.data ?? []).filter((c) => c.dialect !== "MSSQL");

  const run = useMutation({
    mutationFn: () =>
      api.federatedQuery({
        sources: sources.filter((s) => s.alias && s.connectionId),
        sql,
        maxRows,
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.truncated) {
        toast.warning(`Showed first ${r.rowCount} rows — result is larger.`);
      } else {
        toast.success(`${r.rowCount} rows · ${r.durationMs}ms`);
      }
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const explain = useMutation({
    mutationFn: () =>
      api.federatedExplain({
        sources: sources.filter((s) => s.alias && s.connectionId),
        sql,
      }),
    onSuccess: (p) => setPlan(p),
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const addSource = () => {
    setSources([...sources, { alias: `src${sources.length + 1}`, connectionId: "" }]);
  };
  const removeSource = (i: number) => {
    setSources(sources.filter((_, idx) => idx !== i));
  };
  const updateSource = (i: number, patch: Partial<SourceRow>) => {
    setSources(sources.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const valid = sources.filter((s) => s.alias && s.connectionId);
    if (valid.length === 0) {
      toast.error("Add at least one source with a connection selected");
      return;
    }
    const dupes = new Set<string>();
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

  return (
    <div className="min-h-screen gradient-bg flex flex-col">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          DB Studio
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <span className="hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50">
            {user?.email}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="max-w-6xl w-full mx-auto px-6 py-6 flex-1 flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Workflow className="h-5 w-5" /> Multi-DB query
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Join tables across connections. DuckDB runs the query in memory on the backend, pulling
            rows from each source on demand.
          </p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div className="rounded-md border border-border bg-card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">Sources</div>
                <div className="text-xs text-muted-foreground">
                  Pick up to 5 connections and give each an alias. Reference them as{" "}
                  <code className="bg-muted px-1 rounded">alias.schema.table</code> in the SQL.
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addSource}
                disabled={sources.length >= 5}
              >
                <Plus className="h-3.5 w-3.5" /> Add source
              </Button>
            </div>
            <div className="space-y-2">
              {sources.map((s, i) => (
                <div key={i} className="grid grid-cols-[140px_1fr_auto] gap-2 items-end">
                  <div className="space-y-1">
                    <Label className="text-xs">Alias</Label>
                    <Input
                      value={s.alias}
                      onChange={(e) => updateSource(i, { alias: e.target.value })}
                      placeholder="src1"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Connection</Label>
                    <Select
                      value={s.connectionId || "__none__"}
                      onValueChange={(v) => updateSource(i, { connectionId: v === "__none__" ? "" : v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Pick a connection" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__" disabled>— Pick —</SelectItem>
                        {usable.map((c: Connection) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name} ({c.dialect.toLowerCase()})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive"
                    onClick={() => removeSource(i)}
                    disabled={sources.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border border-border bg-card p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>SQL</Label>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Row cap</span>
                <Select value={String(maxRows)} onValueChange={(v) => setMaxRows(parseInt(v, 10))}>
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="1000">1,000</SelectItem>
                    <SelectItem value="10000">10,000</SelectItem>
                    <SelectItem value="100000">100,000</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={8}
              className="font-mono text-xs"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Postgres / MySQL / SQLite only. MSSQL sources and SSH-tunnelled connections aren't
              supported here — DuckDB needs a direct network path.
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={explain.isPending || run.isPending}
                onClick={() => {
                  const valid = sources.filter((s) => s.alias && s.connectionId);
                  if (valid.length === 0 || !sql.trim()) {
                    toast.error("Add a source and SQL first");
                    return;
                  }
                  explain.mutate();
                }}
                title="Show how the planner distributes this query — what runs on each source vs. locally"
              >
                {explain.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
                Show plan
              </Button>
              <Button type="submit" disabled={run.isPending}>
                {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run
              </Button>
            </div>
          </div>
        </form>

        {plan && (
          <div className="rounded-md border border-border bg-card p-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium flex items-center gap-2">
                <GitBranch className="h-4 w-4" /> Distributed plan
              </div>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setPlan(null)}
              >
                Hide
              </button>
            </div>

            {plan.warnings.length > 0 && (
              <div className="space-y-1.5">
                {plan.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              {plan.sources.map((s) => (
                <div key={s.alias} className="rounded border border-border p-2.5 text-xs space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{s.alias}</span>
                    <span className="text-muted-foreground">{s.dialect.toLowerCase()}</span>
                    {s.fullScan ? (
                      <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                        full scan
                      </span>
                    ) : (
                      <span className="ml-auto rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                        pushed down
                      </span>
                    )}
                  </div>
                  {s.pushedFilters.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">Filters at source: </span>
                      <span className="font-mono">{s.pushedFilters.join(", ")}</span>
                    </div>
                  )}
                  {s.projectedColumns.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">Columns fetched: </span>
                      <span className="font-mono">{s.projectedColumns.slice(0, 8).join(", ")}{s.projectedColumns.length > 8 ? "…" : ""}</span>
                    </div>
                  )}
                  {s.estimatedRows != null && (
                    <div className="text-muted-foreground">
                      Est. rows: <span className="font-mono">{s.estimatedRows.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {plan.localOperations.length > 0 && (
              <div className="text-xs">
                <span className="text-muted-foreground">Runs locally (DuckDB): </span>
                <span className="font-mono">{plan.localOperations.join(", ")}</span>
              </div>
            )}

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw plan</summary>
              <pre className="mt-1 bg-muted rounded p-2 overflow-auto max-h-60 whitespace-pre">{plan.raw}</pre>
            </details>
          </div>
        )}

        <div className="flex-1 min-h-80 rounded-md border border-border bg-card flex flex-col">
          {result ? (
            <>
              <div className="px-3 py-2 border-b border-border text-xs flex items-center gap-4 flex-wrap">
                <span className="font-mono">
                  {result.rowCount}
                  {result.truncated && "+"} rows · {result.durationMs}ms
                </span>
                <span className="text-muted-foreground">
                  Sources: {result.sources.map((s) => `${s.alias} (${s.dialect.toLowerCase()})`).join(", ")}
                </span>
                {result.truncated && (
                  <span className="text-amber-600 dark:text-amber-400">
                    Result capped at {result.appliedLimit}. Add LIMIT to narrow, or raise the cap.
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0">
                <DataGrid
                  columns={result.fields.map((f) => ({ name: f.name, type: f.dataType }))}
                  rows={result.rows}
                  emptyMessage="Query returned no rows"
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Run a query to see results.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
