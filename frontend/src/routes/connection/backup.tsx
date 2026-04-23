import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Download, Loader2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export default function BackupRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <BackupInner connectionId={id} />;
}

function BackupInner({ connectionId }: { connectionId: string }) {
  const [format, setFormat] = useState<"sql" | "custom">("sql");
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [schema, setSchema] = useState<string>("");

  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });

  const download = useMutation({
    mutationFn: () =>
      api.downloadBackup(connectionId, {
        format,
        schemaOnly,
        schema: schema || undefined,
      }),
    onSuccess: () => toast.success("Download started"),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Archive className="h-5 w-5" /> Backup
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Download a <code className="text-xs bg-muted px-1 rounded">pg_dump</code> snapshot of this
          database. Runs as the connection's stored user — make sure it has access to the objects
          you want included.
        </p>
      </div>

      <div className="rounded-md border border-border bg-card p-4 space-y-4">
        <div className="space-y-1.5">
          <Label>Format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as "sql" | "custom")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sql">Plain SQL (.sql)</SelectItem>
              <SelectItem value="custom">Postgres custom (.dump, restore with pg_restore)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Plain SQL is readable and portable. Custom format is smaller and supports selective
            restore via pg_restore.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Schema (optional)</Label>
          <Select value={schema || "__all__"} onValueChange={(v) => setSchema(v === "__all__" ? "" : v)}>
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

        <div className="flex items-center gap-3">
          <Switch checked={schemaOnly} onCheckedChange={setSchemaOnly} />
          <div>
            <div className="text-sm font-medium">Schema only</div>
            <div className="text-xs text-muted-foreground">
              Skip row data. Useful for migrations and diffing structure.
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-border flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Large databases stream directly to your browser — no server-side temp files.
          </div>
          <Button onClick={() => download.mutate()} disabled={download.isPending}>
            {download.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Starting…</>
            ) : (
              <><Download className="h-4 w-4" /> Download</>
            )}
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="font-medium text-foreground">Heads up</div>
        <div>• Backup is supported for PostgreSQL connections today. MySQL/MSSQL return 501.</div>
        <div>• Only connection owners can run backups.</div>
        <div>
          • If the remote Postgres major version is newer than the server's bundled pg_dump, the
          dump may fail. Install a matching client binary on the API host when upgrading.
        </div>
      </div>
    </div>
  );
}
