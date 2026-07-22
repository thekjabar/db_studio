import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Activity, ArrowRight, GitCompareArrows, Loader2, TrendingDown } from "lucide-react";
import { api, type PlanSnapshot } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const WINDOWS: { value: number; label: string }[] = [
  { value: 24, label: "Last 24h" },
  { value: 168, label: "Last 7d" },
  { value: 720, label: "Last 30d" },
  { value: 2160, label: "Last 90d" },
];

export default function PlanRegressionsRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <Inner connectionId={id} />;
}

function Inner({ connectionId }: { connectionId: string }) {
  const [hours, setHours] = useState(168);
  const [expanded, setExpanded] = useState<string | null>(null);

  const regressionsQ = useQuery({
    queryKey: ["plan-regressions", connectionId, hours],
    queryFn: () => api.planRegressions(connectionId, hours, 100),
    refetchInterval: 60_000,
  });

  const items = regressionsQ.data ?? [];

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <TrendingDown className="h-5 w-5" /> Plan regressions
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            When a query's SQL stays the same but the planner silently switches strategy — an index
            scan becoming a sequential scan, or a join flipping to a nested loop — that's the usual
            cause of a query that "suddenly got slow." We capture each query's plan structure over
            time and flag these structural downgrades here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(hours)} onValueChange={(v) => setHours(parseInt(v, 10))}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w.value} value={String(w.value)}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => regressionsQ.refetch()}
            disabled={regressionsQ.isFetching}
          >
            {regressionsQ.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Refresh"}
          </Button>
        </div>
      </div>

      {regressionsQ.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-12 text-center">
          <Activity className="h-8 w-8 text-emerald-500 mx-auto mb-3" />
          <div className="text-sm font-medium">No plan regressions detected</div>
          <div className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Plans are captured automatically as SELECTs run. As soon as a query's plan structure
            degrades vs its previous capture, it shows up here.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((s) => (
            <RegressionCard
              key={s.id}
              connectionId={connectionId}
              snap={s}
              open={expanded === s.id}
              onToggle={() => setExpanded(expanded === s.id ? null : s.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RegressionCard({
  connectionId,
  snap,
  open,
  onToggle,
}: {
  connectionId: string;
  snap: PlanSnapshot;
  open: boolean;
  onToggle: () => void;
}) {
  const historyQ = useQuery({
    queryKey: ["plan-history", connectionId, snap.shapeHash],
    queryFn: () => api.planHistory(connectionId, snap.shapeHash, 20),
    enabled: open,
  });

  // The capture immediately before this one is the "from" side of the diff.
  const history = historyQ.data ?? [];
  const idx = history.findIndex((h) => h.id === snap.id);
  const prev = idx >= 0 && idx + 1 < history.length ? history[idx + 1] : null;

  const diffQ = useQuery({
    queryKey: ["plan-diff", connectionId, prev?.id, snap.id],
    queryFn: () => api.planDiff(connectionId, prev!.id, snap.id),
    enabled: open && !!prev,
  });

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.03] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-amber-500/[0.06]"
      >
        <TrendingDown className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="destructive" className="text-[10px]">
              regression
            </Badge>
            <span className="text-xs text-muted-foreground">
              {formatDistanceToNow(new Date(snap.createdAt), { addSuffix: true })}
            </span>
            {snap.totalCost != null && (
              <span className="text-[11px] font-mono text-muted-foreground">
                cost {snap.totalCost.toFixed(0)}
              </span>
            )}
          </div>
          <div className="text-sm font-medium mt-1 text-amber-700 dark:text-amber-400">
            {snap.regressionNote ?? "Plan structure changed"}
          </div>
          <pre className="text-[11px] font-mono text-muted-foreground mt-1.5 whitespace-pre-wrap line-clamp-2">
            {snap.normalizedSql}
          </pre>
        </div>
      </button>

      {open && (
        <div className="border-t border-amber-500/20 px-4 py-3 space-y-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Current plan
            </div>
            <ScanList scans={snap.scans} />
          </div>

          {prev && diffQ.data && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-2">
                <GitCompareArrows className="h-3.5 w-3.5" /> What changed
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
                <div className="rounded border border-border p-2 bg-background">
                  <div className="text-[10px] text-muted-foreground mb-1">
                    before · {formatDistanceToNow(new Date(diffQ.data.from.createdAt), { addSuffix: true })}
                  </div>
                  <ScanList scans={diffQ.data.from.scans} compact />
                </div>
                <ArrowRight className="h-4 w-4 text-amber-500" />
                <div className="rounded border border-amber-500/40 p-2 bg-amber-500/[0.04]">
                  <div className="text-[10px] text-muted-foreground mb-1">
                    after · now
                  </div>
                  <ScanList scans={diffQ.data.to.scans} compact />
                </div>
              </div>
              {diffQ.data.costDeltaRatio != null && diffQ.data.costDeltaRatio > 1 && (
                <div className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                  Planner cost rose {diffQ.data.costDeltaRatio.toFixed(1)}× vs the previous plan.
                </div>
              )}
            </div>
          )}

          {historyQ.isLoading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading history…
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScanList({ scans, compact }: { scans: { nodeType: string; relation: string | null }[]; compact?: boolean }) {
  if (scans.length === 0) return <span className="text-xs text-muted-foreground">(no scans)</span>;
  const bad = (t: string) => /Seq Scan/i.test(t) || t === "ALL" || t === "Nested Loop";
  return (
    <div className={cn("flex flex-wrap gap-1.5", compact && "gap-1")}>
      {scans.map((s, i) => (
        <span
          key={i}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono border",
            bad(s.nodeType)
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {s.nodeType}
          {s.relation && <span className="opacity-60">· {s.relation}</span>}
        </span>
      ))}
    </div>
  );
}
