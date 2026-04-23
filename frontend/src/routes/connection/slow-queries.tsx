import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Timer } from "lucide-react";
import { api, type SlowQueryGroup } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const WINDOWS: { value: number; label: string }[] = [
  { value: 1, label: "Last hour" },
  { value: 24, label: "Last 24h" },
  { value: 168, label: "Last 7d" },
  { value: 720, label: "Last 30d" },
];

export default function SlowQueriesRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <SlowQueriesInner connectionId={id} />;
}

function SlowQueriesInner({ connectionId }: { connectionId: string }) {
  const [hours, setHours] = useState(168);
  const [expanded, setExpanded] = useState<string | null>(null);

  const groupsQ = useQuery({
    queryKey: ["slow-queries", connectionId, hours],
    queryFn: () => api.listSlowQueries(connectionId, hours, 100),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Timer className="h-5 w-5" /> Slow queries
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Queries that took longer than the configured threshold, grouped by shape. Failed queries
            are tracked too — useful for spotting repeated timeouts.
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
          <Button variant="outline" size="sm" onClick={() => groupsQ.refetch()} disabled={groupsQ.isFetching}>
            {groupsQ.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
          </Button>
        </div>
      </div>

      {groupsQ.isLoading ? (
        <div className="rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !groupsQ.data || groupsQ.data.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-10 text-center">
          <div className="text-sm font-medium mb-1">No slow queries recorded</div>
          <div className="text-xs text-muted-foreground">
            Queries under the threshold aren't logged. Run something heavy to populate this view, or
            lower <code className="bg-muted px-1 rounded">SLOW_QUERY_THRESHOLD_MS</code>.
          </div>
        </div>
      ) : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-6 px-2 py-2" />
                <th className="text-left px-3 py-2 font-medium">Shape</th>
                <th className="text-right px-3 py-2 font-medium w-20">Runs</th>
                <th className="text-right px-3 py-2 font-medium w-24">Avg</th>
                <th className="text-right px-3 py-2 font-medium w-24">Max</th>
                <th className="text-right px-3 py-2 font-medium w-28">Total time</th>
                <th className="text-left px-3 py-2 font-medium w-28">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {groupsQ.data.map((g) => (
                <GroupRow
                  key={g.shapeHash}
                  group={g}
                  connectionId={connectionId}
                  expanded={expanded === g.shapeHash}
                  onToggle={() =>
                    setExpanded(expanded === g.shapeHash ? null : g.shapeHash)
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function GroupRow({
  group,
  connectionId,
  expanded,
  onToggle,
}: {
  group: SlowQueryGroup;
  connectionId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={cn(
          "cursor-pointer hover:bg-muted/30",
          group.erroredCount > 0 && "bg-destructive/5",
        )}
        onClick={onToggle}
      >
        <td className="px-2 py-2 align-top">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-2 font-mono text-xs max-w-0">
          <div className="truncate" title={group.normalizedSql}>
            {group.normalizedSql}
          </div>
          {group.erroredCount > 0 && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {group.erroredCount} errored
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs">{group.count}</td>
        <td className="px-3 py-2 text-right font-mono text-xs">{group.avgDurationMs}ms</td>
        <td className="px-3 py-2 text-right font-mono text-xs">{group.maxDurationMs}ms</td>
        <td className="px-3 py-2 text-right font-mono text-xs">
          {(group.totalDurationMs / 1000).toFixed(1)}s
        </td>
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(group.lastSeen), { addSuffix: true })}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td />
          <td colSpan={6} className="p-0">
            <GroupDetails group={group} connectionId={connectionId} />
          </td>
        </tr>
      )}
    </>
  );
}

function GroupDetails({
  group,
  connectionId,
}: {
  group: SlowQueryGroup;
  connectionId: string;
}) {
  const runsQ = useQuery({
    queryKey: ["slow-queries-runs", connectionId, group.shapeHash],
    queryFn: () => api.listSlowQueryRuns(connectionId, group.shapeHash, 50),
  });

  return (
    <div className="border-t border-border bg-muted/20 p-3 space-y-3">
      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Example SQL</div>
        <pre className="rounded bg-background border border-border p-2 text-xs font-mono overflow-x-auto max-h-48">
          {group.exampleSql}
        </pre>
      </div>
      <div>
        <div className="text-xs uppercase text-muted-foreground mb-1">Recent runs</div>
        {runsQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : runsQ.data && runsQ.data.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left py-1 font-normal">When</th>
                <th className="text-left py-1 font-normal">User</th>
                <th className="text-right py-1 font-normal w-20">Duration</th>
                <th className="text-right py-1 font-normal w-16">Rows</th>
                <th className="text-left py-1 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {runsQ.data.map((r) => (
                <tr key={r.id} className="border-t border-border/50">
                  <td className="py-1 font-mono">
                    {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                  </td>
                  <td className="py-1">{r.user?.email ?? "—"}</td>
                  <td className="py-1 text-right font-mono">{r.durationMs}ms</td>
                  <td className="py-1 text-right font-mono">
                    {r.rowCount ?? r.rowsAffected ?? "—"}
                  </td>
                  <td className="py-1">
                    {r.errored ? (
                      <Badge variant="destructive" className="text-[10px]">error</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">ok</Badge>
                    )}
                    {r.errorMessage && (
                      <span className="ml-1 text-destructive font-mono">{r.errorMessage.slice(0, 80)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-muted-foreground">No recent runs.</div>
        )}
      </div>
    </div>
  );
}
