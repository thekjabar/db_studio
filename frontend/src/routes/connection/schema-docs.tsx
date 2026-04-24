import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { BookMarked, Loader2, Pencil, Trash2, User } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { renderMarkdown } from "@/lib/markdown";

type Doc = {
  id: string;
  schemaName: string;
  tableName: string;
  columnName: string;
  description: string | null;
  tags: string | null;
  ownerEmail: string | null;
  updatedAt: string;
  updatedBy: { email: string; displayName: string | null } | null;
};

export default function SchemaDocsRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Doc | "new" | null>(null);

  const q = useQuery({
    queryKey: ["schema-docs", id],
    queryFn: () => api.listSchemaDocs(id!),
    enabled: !!id,
  });

  const del = useMutation({
    mutationFn: (docId: string) => api.deleteSchemaDoc(id!, docId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schema-docs", id] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, Doc[]>();
    for (const d of q.data ?? []) {
      const k = `${d.schemaName}.${d.tableName}`;
      const list = map.get(k) ?? [];
      list.push(d);
      map.set(k, list);
    }
    // Sort each group so table-level (columnName = '') comes first.
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.columnName === "" && b.columnName !== "") return -1;
        if (b.columnName === "" && a.columnName !== "") return 1;
        return a.columnName.localeCompare(b.columnName);
      });
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [q.data]);

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <BookMarked className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Schema docs</div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setEdit("new")}>
            <Pencil className="h-3.5 w-3.5" /> New doc
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 space-y-6">
        {q.isLoading && <div className="text-muted-foreground">Loading…</div>}
        {q.data?.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No documentation yet. Add descriptions, tags, and owners for your tables and columns.
          </div>
        )}

        {grouped.map(([key, docs]) => (
          <section key={key}>
            <h2 className="text-sm font-semibold mb-2">{key}</h2>
            <div className="space-y-2">
              {docs.map((d) => (
                <div
                  key={d.id}
                  className="rounded-md border border-border bg-card p-3 flex items-start gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {d.columnName || <span className="text-muted-foreground">(table)</span>}
                      {d.ownerEmail && (
                        <span className="inline-flex items-center gap-1 ml-2 text-[11px] text-muted-foreground">
                          <User className="h-3 w-3" /> {d.ownerEmail}
                        </span>
                      )}
                    </div>
                    {d.tags && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.tags.split(",").map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {d.description && (
                      <div
                        className="prose prose-sm max-w-none dark:prose-invert mt-2 text-sm"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(d.description) }}
                      />
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1.5">
                      Updated {format(new Date(d.updatedAt), "MMM d HH:mm")}
                      {d.updatedBy && ` by ${d.updatedBy.displayName || d.updatedBy.email}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setEdit(d)}
                      className="text-muted-foreground hover:text-foreground p-1"
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => del.mutate(d.id)}
                      disabled={del.isPending}
                      className="text-muted-foreground hover:text-destructive p-1"
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      {edit && (
        <DocDialog
          connectionId={id!}
          initial={edit === "new" ? null : edit}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}

function DocDialog({
  connectionId,
  initial,
  onClose,
}: {
  connectionId: string;
  initial: Doc | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [schemaName, setSchema] = useState(initial?.schemaName ?? "public");
  const [tableName, setTable] = useState(initial?.tableName ?? "");
  const [columnName, setColumn] = useState(initial?.columnName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [tags, setTags] = useState(initial?.tags ?? "");
  const [ownerEmail, setOwnerEmail] = useState(initial?.ownerEmail ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.upsertSchemaDoc(connectionId, {
        schemaName: schemaName.trim(),
        tableName: tableName.trim(),
        columnName: columnName.trim() || undefined,
        description: description || undefined,
        tags: tags || undefined,
        ownerEmail: ownerEmail || undefined,
      }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["schema-docs", connectionId] });
      onClose();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit doc" : "New doc"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>Schema</Label>
              <Input value={schemaName} onChange={(e) => setSchema(e.target.value)} disabled={!!initial} />
            </div>
            <div>
              <Label>Table</Label>
              <Input value={tableName} onChange={(e) => setTable(e.target.value)} disabled={!!initial} />
            </div>
            <div>
              <Label>Column (blank for table-level)</Label>
              <Input value={columnName} onChange={(e) => setColumn(e.target.value)} disabled={!!initial} />
            </div>
          </div>
          <div>
            <Label>Owner email</Label>
            <Input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div>
            <Label>Tags (comma-separated, e.g. pii,regulated)</Label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
          <div>
            <Label>Description (markdown)</Label>
            <Textarea
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
