import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { BarChart3, BookOpen, Code2, Loader2, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type ChartConfig, type SavedQuery } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { EmptyState } from "@/components/empty-state";
import { ChartConfigDialog } from "@/components/chart-config-dialog";
import { QueryChart } from "@/components/query-chart";

export default function SavedRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const modal = useModal();

  const q = useQuery({
    queryKey: ["saved-queries", id],
    queryFn: () => api.listSavedQueries(id!),
    enabled: !!id,
  });

  const del = useMutation({
    mutationFn: (qid: string) => api.deleteSavedQuery(id!, qid),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["saved-queries", id] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="h-full overflow-auto p-6">
      <h2 className="text-lg font-semibold mb-4">Saved queries</h2>
      {q.isLoading && <div className="text-sm text-muted-foreground">Loading...</div>}
      {q.data?.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card/50">
          <EmptyState
            icon={BookOpen}
            title="No saved queries yet"
            description="Run a query in the SQL editor and click Save to keep it here for later."
            action={
              <Button asChild>
                <Link to={`/c/${id}/sql`}>
                  <Code2 className="h-4 w-4" /> Open SQL editor
                </Link>
              </Button>
            }
          />
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {q.data?.map((s) => (
          <SavedQueryCard
            key={s.id}
            connectionId={id!}
            query={s}
            onDelete={async () => {
              const ok = await modal.confirm({
                title: `Delete "${s.name}"?`,
                description: "This removes the saved query.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) del.mutate(s.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function SavedQueryCard({
  connectionId,
  query,
  onDelete,
}: {
  connectionId: string;
  query: SavedQuery;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const [configOpen, setConfigOpen] = useState(false);

  const runQ = useQuery({
    queryKey: ["saved-result", query.id, query.sqlText, query.updatedAt],
    queryFn: () => api.runQuery(connectionId, { sql: query.sqlText }),
    enabled: !!query.chartConfig,
    retry: false,
    staleTime: 60_000,
  });

  const saveConfig = useMutation({
    mutationFn: (next: ChartConfig | null) =>
      api.updateSavedQuery(connectionId, query.id, { chartConfig: next }),
    onSuccess: () => {
      toast.success("Chart saved");
      qc.invalidateQueries({ queryKey: ["saved-queries", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const fieldNames = runQ.data?.fields.map((f) => f.name) ?? [];

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="font-semibold text-sm truncate">{query.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {query.createdAt ? format(new Date(query.createdAt), "yyyy-MM-dd HH:mm") : ""}
          </div>
        </div>
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" title="Open in SQL editor" asChild>
            <Link to={`/c/${connectionId}/sql`} state={{ sql: query.sqlText }}>
              <Code2 className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title={query.chartConfig ? "Edit chart" : "Add chart"}
            onClick={async () => {
              // If we don't yet have a result, run the query once to discover columns.
              if (!fieldNames.length) {
                try {
                  const r = await api.runQuery(connectionId, { sql: query.sqlText });
                  qc.setQueryData(["saved-result", query.id, query.sqlText, query.updatedAt], r);
                } catch (e) {
                  toast.error(extractErrorMessage(e));
                  return;
                }
              }
              setConfigOpen(true);
            }}
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {query.chartConfig && runQ.data ? (
        <QueryChart config={query.chartConfig} rows={runQ.data.rows} />
      ) : query.chartConfig && runQ.isLoading ? (
        <div className="h-48 flex items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Running query...
        </div>
      ) : query.chartConfig && runQ.error ? (
        <div className="h-24 text-xs text-destructive flex items-center">
          {extractErrorMessage(runQ.error)}
        </div>
      ) : (
        <pre className="font-mono text-[11px] text-muted-foreground overflow-hidden text-ellipsis bg-muted rounded p-2 max-h-24">
          {query.sqlText}
        </pre>
      )}

      <ChartConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        columns={
          fieldNames.length ? fieldNames : (qc.getQueryData(["saved-result", query.id, query.sqlText, query.updatedAt]) as { fields: { name: string }[] } | undefined)?.fields.map((f) => f.name) ?? []
        }
        initial={query.chartConfig ?? undefined}
        onSave={(next) => saveConfig.mutate(next)}
      />
    </div>
  );
}
