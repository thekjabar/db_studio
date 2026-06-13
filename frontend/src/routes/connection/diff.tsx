import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitCompare, Loader2, Play } from "lucide-react";
import { api, extractErrorMessage, type QueryResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DataGrid } from "@/components/data-grid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Run the same (or different) SQL against two connections and diff the
 * result sets — the classic "does prod match staging?" check. Rows are
 * compared by full JSON identity; differences are listed as only-in-A /
 * only-in-B.
 */
export default function DiffRoute() {
  const { id } = useParams<{ id: string }>();
  const [connB, setConnB] = useState("");
  const [sqlA, setSqlA] = useState("SELECT 1 AS x;");
  const [sqlB, setSqlB] = useState("");
  const [resA, setResA] = useState<QueryResult | null>(null);
  const [resB, setResB] = useState<QueryResult | null>(null);
  const [view, setView] = useState<"onlyA" | "onlyB">("onlyA");

  const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });

  const run = useMutation({
    mutationFn: async () => {
      const [a, b] = await Promise.all([
        api.runQuery(id!, { sql: sqlA, maxRows: 5000 }),
        api.runQuery(connB || id!, { sql: sqlB.trim() || sqlA, maxRows: 5000 }),
      ]);
      return { a, b };
    },
    onSuccess: ({ a, b }) => {
      setResA(a);
      setResB(b);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const diff = useMemo(() => {
    if (!resA || !resB) return null;
    const keyOf = (r: Record<string, unknown>) => JSON.stringify(r);
    const setA = new Map(resA.rows.map((r) => [keyOf(r), r]));
    const setB = new Map(resB.rows.map((r) => [keyOf(r), r]));
    const onlyA = [...setA.entries()].filter(([k]) => !setB.has(k)).map(([, r]) => r);
    const onlyB = [...setB.entries()].filter(([k]) => !setA.has(k)).map(([, r]) => r);
    return { onlyA, onlyB, same: resA.rows.length - onlyA.length };
  }, [resA, resB]);

  const shownRows = view === "onlyA" ? diff?.onlyA ?? [] : diff?.onlyB ?? [];
  const shownFields = view === "onlyA" ? resA?.fields ?? [] : resB?.fields ?? [];

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <GitCompare className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Compare results</div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || !sqlA.trim()}>
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run both
          </Button>
        </div>
      </div>

      <div className="p-3 grid grid-cols-1 lg:grid-cols-2 gap-3 border-b border-border">
        <div className="space-y-1.5">
          <Label>A — this connection</Label>
          <Textarea rows={4} value={sqlA} onChange={(e) => setSqlA(e.target.value)} className="font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label>B —</Label>
            <Select value={connB || id!} onValueChange={setConnB}>
              <SelectTrigger className="h-7 text-xs w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(connsQ.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            rows={4}
            value={sqlB}
            onChange={(e) => setSqlB(e.target.value)}
            placeholder="Leave blank to reuse query A"
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {diff ? (
          <>
            <div className="px-4 py-2 border-b border-border flex items-center gap-3 text-xs">
              <Badge variant="outline">{diff.same} identical</Badge>
              <button onClick={() => setView("onlyA")} className={view === "onlyA" ? "text-primary font-medium" : "text-muted-foreground"}>
                Only in A: {diff.onlyA.length}
              </button>
              <button onClick={() => setView("onlyB")} className={view === "onlyB" ? "text-primary font-medium" : "text-muted-foreground"}>
                Only in B: {diff.onlyB.length}
              </button>
              {diff.onlyA.length === 0 && diff.onlyB.length === 0 && (
                <span className="text-emerald-500 font-medium">Result sets are identical ✓</span>
              )}
            </div>
            {shownRows.length > 0 ? (
              <DataGrid
                columns={shownFields.map((f) => ({ name: f.name, type: f.dataType }))}
                rows={shownRows}
              />
            ) : (
              <div className="p-6 text-sm text-muted-foreground">No rows unique to this side.</div>
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Write a query, pick connection B, run both.
          </div>
        )}
      </div>
    </div>
  );
}
