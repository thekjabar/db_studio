import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Filter, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function RowFiltersRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["row-filters", id],
    queryFn: () => api.listRowFilters(id!),
    enabled: !!id,
  });

  const upsert = useMutation({
    mutationFn: (body: {
      email: string;
      schemaName: string;
      tableName: string;
      predicate: string;
    }) => api.upsertRowFilter(id!, body),
    onSuccess: () => {
      toast.success("Filter saved");
      qc.invalidateQueries({ queryKey: ["row-filters", id] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const del = useMutation({
    mutationFn: (filterId: string) => api.deleteRowFilter(id!, filterId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["row-filters", id] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <Filter className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Row filters</div>
      </div>

      <div className="max-w-3xl mx-auto p-4 space-y-6">
        <div className="rounded-md border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Add / update a filter
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            When a user browses the named table, this predicate is AND-ed with their filters. Use{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">:userId</code> to reference
            the viewing user's id. Only the connection owner can manage filters.
          </p>
          <NewFilterForm onSubmit={(b) => upsert.mutate(b)} pending={upsert.isPending} />
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Active filters
          </div>
          {q.isLoading && (
            <div className="text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline" /> Loading...
            </div>
          )}
          {q.data?.length === 0 && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              No row filters set. Every team member sees all rows.
            </div>
          )}
          <div className="space-y-2">
            {q.data?.map((f) => (
              <div
                key={f.id}
                className="rounded-md border border-border bg-card p-3 flex items-start gap-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">
                    {f.displayName || f.email}
                    <span className="text-muted-foreground ml-2">→ {f.schemaName}.{f.tableName}</span>
                  </div>
                  <code className="block mt-1 text-xs font-mono rounded bg-muted px-2 py-1">
                    {f.predicate}
                  </code>
                </div>
                <button
                  onClick={() => del.mutate(f.id)}
                  disabled={del.isPending}
                  className="text-muted-foreground hover:text-destructive p-1"
                  title="Delete filter"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function NewFilterForm({
  onSubmit,
  pending,
}: {
  onSubmit: (b: {
    email: string;
    schemaName: string;
    tableName: string;
    predicate: string;
  }) => void;
  pending: boolean;
}) {
  const [email, setEmail] = useState("");
  const [schemaName, setSchema] = useState("public");
  const [tableName, setTable] = useState("");
  const [predicate, setPredicate] = useState("tenant_id = :userId");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !schemaName || !tableName || !predicate) {
      toast.error("All fields required");
      return;
    }
    onSubmit({ email, schemaName, tableName, predicate });
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-3">
      <div>
        <Label>User email</Label>
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@company.com"
        />
      </div>
      <div>
        <Label>Schema</Label>
        <Input value={schemaName} onChange={(e) => setSchema(e.target.value)} />
      </div>
      <div>
        <Label>Table</Label>
        <Input value={tableName} onChange={(e) => setTable(e.target.value)} placeholder="orders" />
      </div>
      <div className="col-span-2">
        <Label>Predicate (allowed: identifiers, =, &lt;, &gt;, IN, AND, OR, NOT, IS NULL, :userId)</Label>
        <Input
          value={predicate}
          onChange={(e) => setPredicate(e.target.value)}
          className="font-mono text-xs"
        />
      </div>
      <div className="col-span-2 flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Save filter
        </Button>
      </div>
    </form>
  );
}
