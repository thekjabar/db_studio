import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const REFRESH_MS = 20_000;

export default function DbHealthRoute() {
  const { id } = useParams<{ id: string }>();
  const [autoRefresh, setAutoRefresh] = useState(true);

  const q = useQuery({
    queryKey: ["db-health", id],
    queryFn: () => api.dbHealthSnapshot(id!),
    enabled: !!id,
    refetchInterval: autoRefresh ? REFRESH_MS : false,
  });

  // Re-render a relative "X seconds ago" every few seconds without refetching.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, []);

  const snap = q.data;
  const ageSec = useMemo(() => {
    if (!snap) return 0;
    return Math.max(0, Math.floor((Date.now() - new Date(snap.at).getTime()) / 1000));
  }, [snap]);

  if (q.isLoading && !snap) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (q.error && !snap) {
    return <div className="p-6 text-destructive">{extractErrorMessage(q.error)}</div>;
  }
  if (!snap) return null;

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <Activity className="h-4 w-4 text-primary" />
        <div>
          <div className="text-sm font-semibold">Database health · {snap.dialect}</div>
          <div className="text-[11px] text-muted-foreground">
            Snapshot {format(new Date(snap.at), "HH:mm:ss")} · {ageSec}s ago
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh((a) => !a)}
            className={cn(
              "text-xs px-2 py-1 rounded border border-border",
              autoRefresh ? "bg-primary/10 text-primary border-primary/30" : "text-muted-foreground",
            )}
          >
            Auto-refresh: {autoRefresh ? "on" : "off"}
          </button>
          <Button size="sm" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", q.isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        {snap.metrics.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-6 text-center text-muted-foreground text-sm">
            No health metrics available for this dialect yet.
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {snap.metrics.map((m) => (
              <MetricCard key={m.key} metric={m} />
            ))}
          </div>
        )}

        {snap.errors.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" /> Some probes failed
            </div>
            <ul className="mt-1 text-[11px] font-mono text-amber-700/80 dark:text-amber-400/80 space-y-0.5">
              {snap.errors.map((e, i) => (
                <li key={i}>· {e}</li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="text-xs font-semibold mb-2 flex items-center gap-2">
            Long-running queries
            {snap.longRunning.length === 0 && (
              <span className="inline-flex items-center gap-1 text-muted-foreground font-normal">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" /> none detected
              </span>
            )}
          </div>
          {snap.longRunning.length > 0 && (
            <div className="rounded-md border border-border bg-card overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-2 py-1 font-medium">PID</th>
                    <th className="text-left px-2 py-1 font-medium">User</th>
                    <th className="text-left px-2 py-1 font-medium">DB</th>
                    <th className="text-left px-2 py-1 font-medium">Duration</th>
                    <th className="text-left px-2 py-1 font-medium">State</th>
                    <th className="text-left px-2 py-1 font-medium">Query</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.longRunning.map((r, i) => (
                    <tr key={i} className="border-b border-border last:border-b-0 align-top">
                      <td className="px-2 py-1 font-mono">{String(r.pid ?? "")}</td>
                      <td className="px-2 py-1">{r.user ?? "—"}</td>
                      <td className="px-2 py-1">{r.database ?? "—"}</td>
                      <td className="px-2 py-1 font-mono">
                        {r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : "—"}
                      </td>
                      <td className="px-2 py-1">
                        {r.state}
                        {r.waitEvent ? ` · ${r.waitEvent}` : ""}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px] max-w-lg">
                        <code className="block whitespace-pre-wrap break-all">
                          {r.query ?? ""}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  metric,
}: {
  metric: {
    key: string;
    label: string;
    value: number | string | null;
    unit?: string;
    severity?: "ok" | "warn" | "crit";
    hint?: string;
  };
}) {
  const severityClass =
    metric.severity === "crit"
      ? "border-destructive/50 bg-destructive/5"
      : metric.severity === "warn"
        ? "border-amber-500/40 bg-amber-500/5"
        : "border-border bg-card";
  const valueClass =
    metric.severity === "crit"
      ? "text-destructive"
      : metric.severity === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "";
  return (
    <div className={cn("rounded-md border p-3", severityClass)}>
      <div className="text-[11px] text-muted-foreground">{metric.label}</div>
      <div className={cn("text-xl font-semibold mt-0.5", valueClass)}>
        {metric.value ?? "—"}
        {metric.unit && <span className="text-xs font-normal ml-1">{metric.unit}</span>}
      </div>
      {metric.hint && <div className="text-[10px] text-muted-foreground mt-1">{metric.hint}</div>}
    </div>
  );
}
