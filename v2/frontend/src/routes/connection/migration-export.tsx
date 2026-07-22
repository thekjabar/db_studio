import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, Copy, Download, FileCode2, GitCompare, Loader2, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModal } from "@/components/modal-provider";

type Target = "prisma" | "drizzle" | "sql";

const TARGET_LABELS: Record<Target, string> = {
  prisma: "Prisma (schema.prisma)",
  drizzle: "Drizzle ORM (schema.ts)",
  sql: "Raw SQL (CREATE TABLE)",
};

const HINTS: Record<Target, string> = {
  prisma:
    "Drop into your Prisma project's prisma/ folder. Run `prisma format` and `prisma migrate dev --create-only` to integrate.",
  drizzle:
    "Drop into src/db/schema.ts in a Drizzle project. Wire relations() manually for each FK comment.",
  sql:
    "Plain DDL. Good for bootstrapping a clean DB or diffing by hand.",
};

export default function MigrationExportRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <Inner connectionId={id} />;
}

function Inner({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const modal = useModal();
  const [target, setTarget] = useState<Target>("prisma");
  const [schema, setSchema] = useState<string>("");
  const [output, setOutput] = useState<{ filename: string; content: string } | null>(null);
  const [snapshotName, setSnapshotName] = useState("");
  const [diffOutput, setDiffOutput] = useState<{
    sql: string;
    summary: {
      addedTables: string[];
      droppedTables: string[];
      addedColumns: string[];
      droppedColumns: string[];
      changedColumns: string[];
      addedFks: string[];
      droppedFks: string[];
    };
  } | null>(null);

  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });
  const snapshotsQ = useQuery({
    queryKey: ["snapshots", connectionId],
    queryFn: () => api.listSchemaSnapshots(connectionId),
  });

  const createSnap = useMutation({
    mutationFn: () =>
      api.createSchemaSnapshot(connectionId, {
        name: snapshotName,
        schema: schema || undefined,
      }),
    onSuccess: () => {
      toast.success("Snapshot saved");
      setSnapshotName("");
      qc.invalidateQueries({ queryKey: ["snapshots", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const deleteSnap = useMutation({
    mutationFn: (id: string) => api.deleteSchemaSnapshot(connectionId, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["snapshots", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const diffMut = useMutation({
    mutationFn: (id: string) => api.diffSchemaSnapshot(connectionId, id),
    onSuccess: (r) => {
      setDiffOutput({ sql: r.sql, summary: r.summary });
      toast.success("Diff generated");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const mut = useMutation({
    mutationFn: () => api.migrationExport(connectionId, target, schema || undefined),
    onSuccess: (r) => {
      setOutput({ filename: r.filename, content: r.content });
      toast.success(`Generated ${r.filename}`);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.content);
      toast.success("Copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const download = () => {
    if (!output) return;
    const blob = new Blob([output.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = output.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <FileCode2 className="h-5 w-5" /> Migration export
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Generate a schema file for Prisma, Drizzle, or raw SQL based on this database's current
          structure. This is a snapshot, not a diff — regenerate after schema changes.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card p-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Target</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as Target)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="prisma">{TARGET_LABELS.prisma}</SelectItem>
                <SelectItem value="drizzle">{TARGET_LABELS.drizzle}</SelectItem>
                <SelectItem value="sql">{TARGET_LABELS.sql}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Schema (optional)</Label>
            <Select
              value={schema || "__all__"}
              onValueChange={(v) => setSchema(v === "__all__" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All schemas</SelectItem>
                {(schemasQ.data ?? []).map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="text-xs text-muted-foreground">{HINTS[target]}</div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCode2 className="h-4 w-4" />}
            Generate
          </Button>
        </div>
      </div>

      {output && (
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <div className="text-sm font-mono">{output.filename}</div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={copy}>
                <Copy className="h-3.5 w-3.5" /> Copy
              </Button>
              <Button size="sm" variant="outline" onClick={download}>
                <Download className="h-3.5 w-3.5" /> Download
              </Button>
            </div>
          </div>
          <pre className="p-3 text-xs font-mono overflow-auto max-h-[60vh] bg-muted/20">
            {output.content}
          </pre>
        </div>
      )}

      <div className="rounded-md border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Camera className="h-4 w-4" /> Snapshots &amp; diff
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Save a schema snapshot now. Later, generate an ALTER-statement diff between the snapshot and the live DB.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            placeholder="Snapshot name (e.g. 'pre v3.1 release')"
            value={snapshotName}
            onChange={(e) => setSnapshotName(e.target.value)}
            className="max-w-sm"
            maxLength={200}
          />
          <Button
            onClick={() => createSnap.mutate()}
            disabled={!snapshotName.trim() || createSnap.isPending}
            variant="outline"
          >
            {createSnap.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
            Snapshot now
          </Button>
        </div>

        <div className="border-t border-border pt-2">
          {snapshotsQ.isLoading ? (
            <div className="text-xs text-muted-foreground">Loading snapshots...</div>
          ) : (snapshotsQ.data?.length ?? 0) === 0 ? (
            <div className="text-xs text-muted-foreground">
              No snapshots yet. Save one above, then return here to compare.
            </div>
          ) : (
            <div className="space-y-1">
              {snapshotsQ.data!.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center gap-2 py-1.5 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{s.name}</div>
                    <div className="text-muted-foreground">
                      {format(new Date(s.createdAt), "PPP p")} ·{" "}
                      {s.createdBy?.displayName || s.createdBy?.email || "unknown"}
                      {s.dbSchema ? ` · schema: ${s.dbSchema}` : ""}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => diffMut.mutate(s.id)}
                    disabled={diffMut.isPending}
                  >
                    {diffMut.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <GitCompare className="h-3 w-3" />
                    )}
                    Diff
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await modal.confirm({
                        title: `Delete snapshot "${s.name}"?`,
                        description: "The snapshot can't be recovered.",
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok) deleteSnap.mutate(s.id);
                    }}
                    title="Delete snapshot"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {diffOutput && (
          <div className="mt-2 rounded border border-border bg-muted/10 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border text-xs">
              <div className="flex items-center gap-3">
                <span className="font-semibold">Diff summary</span>
                <span className="text-muted-foreground">
                  +{diffOutput.summary.addedTables.length} tables,{" "}
                  -{diffOutput.summary.droppedTables.length} tables,{" "}
                  +{diffOutput.summary.addedColumns.length} cols,{" "}
                  -{diffOutput.summary.droppedColumns.length} cols,{" "}
                  ~{diffOutput.summary.changedColumns.length} changed
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(diffOutput.sql);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-3 w-3" /> Copy
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([diffOutput.sql], { type: "text/plain" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `diff-${Date.now()}.sql`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-3 w-3" /> Download
                </Button>
              </div>
            </div>
            <pre className="p-3 text-xs font-mono overflow-auto max-h-[50vh]">
              {diffOutput.sql}
            </pre>
          </div>
        )}
      </div>

      <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="font-medium text-foreground">Scope notes</div>
        <div>• Snapshot export — no diff against a previous version. Regenerate after schema changes.</div>
        <div>• Type mapping is best-effort. Review before committing — domain types, custom precisions, and enums may need manual tuning.</div>
        <div>• Prisma: composite relations and advanced options (@map, @@unique) are emitted where detected; tune the output to match your project conventions.</div>
        <div>• Drizzle FK relations are emitted as comments. Wire them explicitly with relations() in your project.</div>
      </div>
    </div>
  );
}
