import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { BookOpen, Code2, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { EmptyState } from "@/components/empty-state";

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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {q.data?.map((s) => (
          <div key={s.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="font-semibold text-sm">{s.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {s.createdAt ? format(new Date(s.createdAt), "yyyy-MM-dd HH:mm") : ""}
                </div>
              </div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" asChild>
                  <Link to={`/c/${id}/sql`} state={{ sql: s.sql }}><Code2 className="h-3.5 w-3.5" /></Link>
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="text-destructive"
                  onClick={async () => {
                    const ok = await modal.confirm({
                      title: `Delete "${s.name}"?`,
                      description: "This removes the saved query.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) del.mutate(s.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <pre className="font-mono text-[11px] text-muted-foreground overflow-hidden text-ellipsis bg-muted rounded p-2 max-h-24">
              {s.sql}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
