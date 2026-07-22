import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Loader2, RefreshCw } from "lucide-react";
import {
  api,
  extractErrorMessage,
  type ChartConfig,
  type PublicDashboard,
  type QueryResult,
} from "@/lib/api";
import { QueryChart } from "@/components/query-chart";

export default function PublicDashboardRoute() {
  const { token } = useParams<{ token: string }>();
  const q = useQuery({
    queryKey: ["public-dashboard", token],
    queryFn: () => api.getPublicDashboard(token!),
    enabled: !!token,
  });

  if (q.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-destructive">
        Dashboard not found or sharing was revoked.
      </div>
    );
  }
  const d = q.data;
  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 flex items-center px-6 border-b border-border bg-card/50">
        <BarChart3 className="h-5 w-5 text-primary mr-2" />
        <div className="min-w-0">
          <div className="font-semibold truncate">{d.name}</div>
          {d.description && (
            <div className="text-[11px] text-muted-foreground truncate">{d.description}</div>
          )}
        </div>
        <div className="ml-auto text-[11px] text-muted-foreground">Public view · read-only</div>
      </header>
      <div className="p-6">
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}
        >
          {d.tiles.map((t) => (
            <PublicTileCard key={t.id} token={token!} tile={t} refreshSec={d.refreshSec ?? null} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PublicTileCard({
  token,
  tile,
  refreshSec,
}: {
  token: string;
  tile: PublicDashboard["tiles"][number];
  refreshSec: number | null;
}) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());

  runRef.current = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.runPublicDashboardTile(token, tile.id);
      setResult(r);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void runRef.current();
    if (!refreshSec) return;
    const iv = setInterval(() => void runRef.current(), refreshSec * 1000);
    return () => clearInterval(iv);
  }, [refreshSec, tile.id]);

  const chart = tile.chartConfig as ChartConfig | null;

  return (
    <div
      className="rounded-md border border-border bg-card overflow-hidden flex flex-col"
      style={{ gridColumn: `span ${tile.w} / span ${tile.w}`, minHeight: tile.h * 60 + 60 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="text-sm font-medium truncate">{tile.title}</div>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground p-1"
          onClick={() => void runRef.current()}
          disabled={loading}
        >
          <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
        </button>
      </div>
      <div className="flex-1 min-h-0 p-2">
        {error && <div className="p-3 text-xs text-destructive">{error}</div>}
        {!error && !result && loading && (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!error && result && chart && <QueryChart config={chart} rows={result.rows} height={tile.h * 60} />}
        {!error && result && !chart && (
          <div className="p-3 text-xs text-muted-foreground">No chart configured for this tile.</div>
        )}
      </div>
    </div>
  );
}
