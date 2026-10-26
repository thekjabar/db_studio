import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, CalendarClock, Download, Loader2, Upload, X } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { ErrorCard } from "@/components/error-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useModal } from "@/components/modal-provider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useBackupJob, type BackupJob } from "@/components/backup-job-provider";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRate(bytes: number, ms: number): string {
  if (ms < 100 || bytes === 0) return "—";
  const bps = bytes / (ms / 1000);
  return `${formatBytes(bps)}/s`;
}

function formatEta(bytes: number, estimate: number | null, ms: number): string {
  if (!estimate || bytes === 0 || ms < 500) return "—";
  const rate = bytes / ms;
  const remaining = Math.max(0, estimate - bytes);
  const etaMs = remaining / rate;
  if (etaMs < 1000) return "<1s";
  if (etaMs < 60_000) return `${Math.round(etaMs / 1000)}s`;
  return `${Math.round(etaMs / 60_000)}m`;
}

export default function BackupRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <BackupInner connectionId={id} />;
}

function BackupInner({ connectionId }: { connectionId: string }) {
  const [format, setFormat] = useState<"sql" | "custom">("sql");
  const [schemaOnly, setSchemaOnly] = useState(false);
  const [schema, setSchema] = useState<string>("");
  const { current, start, cancel, clear } = useBackupJob();

  // Only show progress for a job that belongs to *this* connection — otherwise
  // the user might see a backup from another connection if they multi-task.
  const myJob = current && current.options.connectionId === connectionId ? current : null;
  const isRunningForMe = myJob?.status === "starting" || myJob?.status === "streaming";

  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });

  const estimateQ = useQuery({
    queryKey: ["backup-estimate", connectionId, schema, schemaOnly],
    queryFn: () => api.estimateBackup(connectionId, schema || undefined),
    enabled: !schemaOnly,
  });

  const connectionName = useQuery({
    queryKey: ["connection", connectionId],
    queryFn: () => api.getConnection(connectionId),
  });

  const kickoff = () => {
    start({
      connectionId,
      connectionName: connectionName.data?.name ?? "Connection",
      format,
      schemaOnly,
      schema: schema || undefined,
    });
  };

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
          <Select value={format} onValueChange={(v) => setFormat(v as "sql" | "custom")} disabled={isRunningForMe}>
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
          <Select
            value={schema || "__all__"}
            onValueChange={(v) => setSchema(v === "__all__" ? "" : v)}
            disabled={isRunningForMe}
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

        <div className="flex items-center gap-3">
          <Switch checked={schemaOnly} onCheckedChange={setSchemaOnly} disabled={isRunningForMe} />
          <div>
            <div className="text-sm font-medium">Schema only</div>
            <div className="text-xs text-muted-foreground">
              Skip row data. Useful for migrations and diffing structure.
            </div>
          </div>
        </div>

        {!schemaOnly && estimateQ.data && estimateQ.data.bytes !== null && (
          <div className="rounded border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Estimated size:{" "}
            <span className="text-foreground font-medium">{formatBytes(estimateQ.data.bytes)}</span>{" "}
            across {estimateQ.data.tables} tables.{" "}
            <span className="text-muted-foreground/70">
              Actual dump may be 50–200% of this depending on compression and column widths.
            </span>
          </div>
        )}

        <div className="pt-2 border-t border-border flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-muted-foreground">
            Backup keeps running when you change pages — watch the status in the bottom-right.
          </div>
          {isRunningForMe ? (
            <Button variant="outline" onClick={cancel}>
              <X className="h-4 w-4" /> Cancel
            </Button>
          ) : (
            <Button onClick={kickoff} disabled={!!current && current.status === "streaming"}>
              <Download className="h-4 w-4" /> Download
            </Button>
          )}
        </div>
      </div>

      {myJob && <ProgressCard job={myJob} onDismiss={clear} onCancel={cancel} />}

      <AutoBackups connectionId={connectionId} />
      <RestorePanel connectionId={connectionId} />

      <div className="rounded-md border border-border bg-card p-4 text-xs text-muted-foreground space-y-1">
        <div className="font-medium text-foreground">Heads up</div>
        <div>• PostgreSQL and MySQL can be dumped and restored. SQL Server needs sqlcmd, which isn't installed.</div>
        <div>• Only connection owners can back up or restore.</div>
        <div>
          • Dumps use the PostgreSQL 17 client, which can read older servers — a server newer than
          that would need a newer client on the API host.
        </div>
      </div>
    </div>
  );
}

/**
 * Scheduled backups to an S3-compatible bucket.
 *
 * The credentials go to the server once, are encrypted there, and are never
 * sent back — so the form shows them only while creating a schedule.
 */
function AutoBackups({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    cron: "0 3 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    bucket: "",
    prefix: "",
    endpoint: "",
    region: "auto",
    accessKeyId: "",
    secretAccessKey: "",
    keepLast: 7,
    format: "custom" as "custom" | "plain",
    schemaOnly: false,
  });

  const listQ = useQuery({
    queryKey: ["backup-schedules", connectionId],
    queryFn: () => api.listBackupSchedules(connectionId),
  });

  const create = useMutation({
    mutationFn: () => api.createBackupSchedule(connectionId, form),
    onSuccess: () => {
      toast.success("Scheduled");
      setOpen(false);
      setForm((f) => ({ ...f, accessKeyId: "", secretAccessKey: "" }));
      qc.invalidateQueries({ queryKey: ["backup-schedules", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.runBackupSchedule(id),
    onSuccess: (r) => toast.success(`Uploaded ${formatBytes(r.sizeBytes)} → ${r.objectKey}`),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateBackupSchedule(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backup-schedules", connectionId] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteBackupSchedule(id),
    onSuccess: () => {
      toast.success("Schedule removed");
      qc.invalidateQueries({ queryKey: ["backup-schedules", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const schedules = listQ.data ?? [];

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4" /> Automatic backups
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Dump on a schedule and push it to your own S3-compatible bucket — Cloudflare R2,
            Backblaze B2, MinIO or AWS. Plain SQL is gzipped on the way out.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Add schedule"}
        </Button>
      </div>

      {open && (
        <div className="space-y-3 rounded-md border border-border bg-background/60 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cron" hint="minute hour day month weekday">
              <Input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </Field>
            <Field label="Timezone" hint="Leave as is to use your own">
              <Input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              />
            </Field>
            <Field label="Bucket">
              <Input
                value={form.bucket}
                onChange={(e) => setForm({ ...form, bucket: e.target.value })}
                placeholder="my-backups"
              />
            </Field>
            <Field label="Prefix" hint="Folder inside the bucket (optional)">
              <Input
                value={form.prefix}
                onChange={(e) => setForm({ ...form, prefix: e.target.value })}
                placeholder="queryschema/prod"
              />
            </Field>
            <Field label="Endpoint" hint="Blank for AWS S3">
              <Input
                value={form.endpoint}
                onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                placeholder="https://<account>.r2.cloudflarestorage.com"
              />
            </Field>
            <Field label="Region" hint="R2 uses auto">
              <Input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
              />
            </Field>
            <Field label="Access key id">
              <Input
                value={form.accessKeyId}
                onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Secret access key">
              <Input
                type="password"
                value={form.secretAccessKey}
                onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Keep last" hint="Older dumps are deleted after a successful run">
              <Input
                type="number"
                min={0}
                value={form.keepLast}
                onChange={(e) => setForm({ ...form, keepLast: Number(e.target.value) })}
              />
            </Field>
            <Field label="Format">
              <Select
                value={form.format}
                onValueChange={(v) => setForm({ ...form, format: v as "custom" | "plain" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">Postgres custom (.dump)</SelectItem>
                  <SelectItem value="plain">Plain SQL, gzipped (.sql.gz)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={form.schemaOnly}
              onCheckedChange={(v) => setForm({ ...form, schemaOnly: v })}
              id="auto-schema-only"
            />
            <Label htmlFor="auto-schema-only" className="text-xs">
              Schema only (no data)
            </Label>
          </div>
          <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Create schedule
          </Button>
          <p className="text-[11px] text-muted-foreground">
            The keys are encrypted on the server and never sent back to the browser. Give them
            write access to this bucket only.
          </p>
        </div>
      )}

      {schedules.length === 0 ? (
        <p className="text-xs text-muted-foreground">No automatic backups yet.</p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {schedules.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 text-xs">
              <code className="font-mono">{s.cron}</code>
              <span className="text-muted-foreground">{s.timezone ?? "UTC"}</span>
              <span className="text-muted-foreground">
                {s.bucket}
                {s.prefix ? `/${s.prefix}` : ""}
              </span>
              <span className="text-muted-foreground">keep {s.keepLast}</span>
              {s.lastStatus && (
                <span
                  className={
                    s.lastStatus === "SUCCESS"
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-destructive"
                  }
                  title={s.lastError ?? undefined}
                >
                  last: {s.lastStatus.toLowerCase()}
                  {s.lastSizeBytes ? ` · ${formatBytes(s.lastSizeBytes)}` : ""}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(v) => toggle.mutate({ id: s.id, enabled: v })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => runNow.mutate(s.id)}
                  disabled={runNow.isPending}
                >
                  {runNow.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Run now"
                  )}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Replay a dump into this connection. */
function RestorePanel({ connectionId }: { connectionId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const modal = useModal();

  const go = async () => {
    if (!file) return;
    const ok = await modal.confirm({
      title: "Restore into this database?",
      description: `${file.name} will be replayed into the connection. Existing objects it touches are replaced, and this cannot be undone.`,
      confirmLabel: "Restore",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.restoreBackup(connectionId, file);
      toast.success(`Restored ${formatBytes(r.bytes)} in ${(r.durationMs / 1000).toFixed(1)}s`);
      if (r.warnings) console.warn(r.warnings);
      setFile(null);
    } catch (e) {
      toast.error(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold flex items-center gap-2">
        <Upload className="h-4 w-4" /> Restore
      </h2>
      <p className="text-xs text-muted-foreground">
        Replay a dump taken from here (or anywhere else) into this connection. A{" "}
        <code className="rounded bg-muted px-1">.dump</code> goes through pg_restore, a{" "}
        <code className="rounded bg-muted px-1">.sql</code> through psql, and MySQL through its own
        client. The upload is streamed — it never lands on our disk.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept=".sql,.dump,.backup,text/plain,application/octet-stream"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-xs file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs"
        />
        <Button size="sm" variant="destructive" onClick={go} disabled={!file || busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Restore
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Owner only. A read-only connection refuses. The restore is recorded in the audit log before
        it starts.
      </p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ProgressCard({
  job,
  onDismiss,
  onCancel,
}: {
  job: BackupJob;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const running = job.status === "starting" || job.status === "streaming";

  // Auto-dismiss the card after a successful download so the user isn't nagged
  // to click Dismiss. Failed/cancelled jobs stay so the user can read the
  // reason. The Dismiss button is still there as an explicit override.
  useEffect(() => {
    if (job.status !== "done") return;
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
  }, [job.status, onDismiss]);
  // While streaming, cap at 99% so a bad estimate doesn't park us at "100%"
  // forever. Once the job is done, snap to 100% — the bytes-on-disk are
  // authoritative regardless of whether they matched the estimate.
  const percent = !running && job.status === "done"
    ? 100
    : job.estimateBytes
      ? Math.min(99, Math.round((job.bytes / job.estimateBytes) * 100))
      : null;

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {running ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            <Archive className="h-4 w-4 text-emerald-500" />
          )}
          <div className="text-sm font-medium">
            {!running
              ? job.status === "done"
                ? "Download complete"
                : job.status === "cancelled"
                ? "Cancelled"
                : "Failed"
              : job.bytes === 0
                ? "Starting — pg_dump is connecting…"
                : "Streaming…"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {percent !== null && job.bytes > 0 && (
            <div className="text-sm font-mono">{percent}%</div>
          )}
          {running && (
            <Button variant="outline" size="sm" onClick={onCancel}>
              <X className="h-3.5 w-3.5" /> Cancel
            </Button>
          )}
          {!running && (
            <button
              onClick={onDismiss}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          )}
        </div>
      </div>

      {percent !== null && job.bytes > 0 && (
        <div className="h-2 w-full rounded bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {percent === null && running && job.bytes > 0 && (
        <div className="h-2 w-full rounded bg-muted overflow-hidden">
          <div className="h-full w-1/3 bg-primary animate-pulse" />
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Stat label="Downloaded" value={formatBytes(job.bytes)} />
        <Stat
          label="Estimated"
          value={job.estimateBytes ? formatBytes(job.estimateBytes) : "unknown"}
        />
        <Stat label="Rate" value={formatRate(job.bytes, job.elapsedMs)} />
        <Stat
          label={running ? "ETA" : "Elapsed"}
          value={
            running
              ? formatEta(job.bytes, job.estimateBytes, job.elapsedMs)
              : `${(job.elapsedMs / 1000).toFixed(1)}s`
          }
        />
      </div>

      {job.status === "error" && job.error && (
        <ErrorCard
          title="Backup failed"
          message={job.error}
          onDismiss={onDismiss}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}
