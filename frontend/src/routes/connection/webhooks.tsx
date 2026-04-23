import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Plus, Play, Trash2, Webhook as WebhookIcon } from "lucide-react";
import {
  api,
  extractErrorMessage,
  type CreateWebhookInput,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";

const ALL_EVENTS: WebhookEvent[] = ["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"];

export default function WebhooksRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <Inner connectionId={id} />;
}

function Inner({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const modal = useModal();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<{ hookName: string; secret: string } | null>(null);

  const listQ = useQuery({
    queryKey: ["webhooks", connectionId],
    queryFn: () => api.listWebhooks(connectionId),
  });

  const toggle = useMutation({
    mutationFn: ({ webhookId, enabled }: { webhookId: string; enabled: boolean }) =>
      api.updateWebhook(connectionId, webhookId, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", connectionId] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (webhookId: string) => api.deleteWebhook(connectionId, webhookId),
    onSuccess: () => {
      toast.success("Webhook deleted");
      qc.invalidateQueries({ queryKey: ["webhooks", connectionId] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const test = useMutation({
    mutationFn: (webhookId: string) => api.testWebhook(connectionId, webhookId),
    onSuccess: () => toast.success("Test delivery queued"),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <WebhookIcon className="h-5 w-5" /> Webhooks
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            POST JSON to a URL when rows in a watched table change through DB Studio.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" /> New webhook
        </Button>
      </div>

      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          <strong>Scope:</strong> Webhooks fire on row changes made through DB Studio's row APIs
          (Table view, bulk edit/delete). External writes to the target DB are not detected — that
          would require DB-native CDC (triggers / logical replication).
        </div>
      </div>

      {listQ.isLoading ? (
        <div className="rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : !listQ.data || listQ.data.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-10 text-center">
          <div className="text-sm font-medium mb-1">No webhooks yet</div>
          <div className="text-xs text-muted-foreground mb-4">
            Create one to be notified when a specific table changes.
          </div>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" /> New webhook
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {listQ.data.map((w) => (
            <WebhookCard
              key={w.id}
              webhook={w}
              connectionId={connectionId}
              expanded={expandedId === w.id}
              onExpand={() => setExpandedId(expandedId === w.id ? null : w.id)}
              onToggle={(enabled) => toggle.mutate({ webhookId: w.id, enabled })}
              onTest={() => test.mutate(w.id)}
              onDelete={async () => {
                const ok = await modal.confirm({
                  title: "Delete webhook",
                  description: `Remove "${w.name}"? Delivery history will be kept for a short time, then purged.`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (ok) remove.mutate(w.id);
              }}
              busy={toggle.isPending || test.isPending || remove.isPending}
            />
          ))}
        </div>
      )}

      <NewWebhookDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connectionId={connectionId}
        onCreated={(hookName, secret) => setNewSecret({ hookName, secret })}
      />

      {/* One-shot secret reveal. Secrets are only shown on create + on explicit rotate. */}
      <Dialog open={!!newSecret} onOpenChange={(v) => !v && setNewSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this secret</DialogTitle>
            <DialogDescription>
              Use it to verify the <code className="bg-muted px-1 rounded">X-DBStudio-Signature</code>{" "}
              header on incoming payloads. You won't see it again.
            </DialogDescription>
          </DialogHeader>
          {newSecret && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">Webhook: {newSecret.hookName}</div>
              <div className="flex items-stretch gap-2">
                <Input
                  readOnly
                  value={newSecret.secret}
                  className="font-mono text-xs flex-1"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(newSecret.secret);
                      toast.success("Copied");
                    } catch {
                      toast.error("Copy failed");
                    }
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="rounded bg-muted/50 p-2 text-xs font-mono">
                signature := HMAC-SHA256(secret, request.body).hex()
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setNewSecret(null)}>I saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusVariant(s: Webhook["lastStatus"]) {
  if (s === "SUCCESS") return "default" as const;
  if (s === "FAILED") return "destructive" as const;
  if (s === "PENDING") return "info" as const;
  return "secondary" as const;
}

function WebhookCard({
  webhook: w,
  connectionId,
  expanded,
  onExpand,
  onToggle,
  onTest,
  onDelete,
  busy,
}: {
  webhook: Webhook;
  connectionId: string;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="p-3 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium">{w.name}</div>
            {w.lastStatus && (
              <Badge variant={statusVariant(w.lastStatus)} className="text-[10px]">
                {w.lastStatus}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground font-mono truncate">
              {w.schemaName}.{w.tableName}
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground flex flex-wrap gap-2 items-center">
            <span className="font-mono truncate max-w-lg" title={w.url}>
              {w.url}
            </span>
            <span>·</span>
            <span>{w.events.map((e) => e.replace("ROW_", "")).join(", ").toLowerCase()}</span>
            <span>·</span>
            <span>
              {w.lastFiredAt
                ? `last fired ${formatDistanceToNow(new Date(w.lastFiredAt), { addSuffix: true })}`
                : "never fired"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-2 pr-2">
            <Switch checked={w.enabled} onCheckedChange={onToggle} disabled={busy} />
            <span className="text-xs text-muted-foreground">{w.enabled ? "on" : "off"}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onTest} disabled={busy}>
            <Play className="h-3.5 w-3.5" /> Test
          </Button>
          <Button variant="ghost" size="sm" onClick={onExpand}>
            {expanded ? "Hide" : "History"}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete} disabled={busy}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {expanded && <DeliveryHistory connectionId={connectionId} webhookId={w.id} />}
    </div>
  );
}

function DeliveryHistory({ connectionId, webhookId }: { connectionId: string; webhookId: string }) {
  const q = useQuery({
    queryKey: ["webhook-deliveries", connectionId, webhookId],
    queryFn: () => api.listWebhookDeliveries(connectionId, webhookId, 30),
    refetchInterval: 5_000,
  });

  if (q.isLoading) {
    return <div className="border-t border-border p-4 text-xs text-muted-foreground">Loading…</div>;
  }
  if (!q.data || q.data.length === 0) {
    return (
      <div className="border-t border-border p-4 text-xs text-muted-foreground">
        No deliveries yet. Click Test above to send a synthetic payload.
      </div>
    );
  }
  return (
    <div className="border-t border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">When</th>
            <th className="text-left px-3 py-2 font-medium w-24">Event</th>
            <th className="text-left px-3 py-2 font-medium w-20">Attempt</th>
            <th className="text-left px-3 py-2 font-medium w-20">Status</th>
            <th className="text-right px-3 py-2 font-medium w-20">HTTP</th>
            <th className="text-right px-3 py-2 font-medium w-20">Time</th>
            <th className="text-left px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {q.data.map((d: WebhookDelivery) => (
            <tr key={d.id}>
              <td className="px-3 py-1.5 font-mono">
                {formatDistanceToNow(new Date(d.startedAt), { addSuffix: true })}
              </td>
              <td className="px-3 py-1.5">{d.event.replace("ROW_", "").toLowerCase()}</td>
              <td className="px-3 py-1.5 font-mono">{d.attempt}</td>
              <td className="px-3 py-1.5">
                {d.status === "SUCCESS" ? (
                  <span className="flex items-center gap-1 text-emerald-500">
                    <CheckCircle2 className="h-3 w-3" /> success
                  </span>
                ) : d.status === "FAILED" ? (
                  <span className="text-destructive">failed</span>
                ) : (
                  <span className="text-muted-foreground">pending</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right font-mono">{d.httpStatus ?? "—"}</td>
              <td className="px-3 py-1.5 text-right font-mono">
                {d.durationMs != null ? `${d.durationMs}ms` : "—"}
              </td>
              <td
                className={cn(
                  "px-3 py-1.5 font-mono text-xs max-w-md truncate",
                  d.status === "FAILED" && "text-destructive",
                )}
                title={d.errorMessage ?? d.responseBody ?? ""}
              >
                {d.errorMessage ?? d.responseBody ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewWebhookDialog({
  open,
  onOpenChange,
  connectionId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connectionId: string;
  onCreated: (name: string, secret: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [schemaName, setSchemaName] = useState("");
  const [tableName, setTableName] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);
  const [submitting, setSubmitting] = useState(false);

  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
    enabled: open,
  });

  const tablesQ = useQuery({
    queryKey: ["tables", connectionId, schemaName],
    queryFn: () => api.listTables(connectionId, schemaName),
    enabled: open && !!schemaName,
  });

  const reset = () => {
    setName("");
    setUrl("");
    setSchemaName("");
    setTableName("");
    setEvents(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (events.length === 0) {
      toast.error("Pick at least one event");
      return;
    }
    setSubmitting(true);
    try {
      const payload: CreateWebhookInput = {
        name,
        url,
        schemaName,
        tableName,
        events,
        enabled: true,
      };
      const created = await api.createWebhook(connectionId, payload);
      toast.success("Webhook created");
      qc.invalidateQueries({ queryKey: ["webhooks", connectionId] });
      onCreated(created.name, created.secret);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleEvent = (e: WebhookEvent) => {
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : (reset(), onOpenChange(false)))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New webhook</DialogTitle>
          <DialogDescription>
            Fire a POST request to a URL when rows change in a specific table.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Notify orders service" />
          </div>
          <div className="space-y-1.5">
            <Label>Target URL</Label>
            <Input required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/hook" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Schema</Label>
              <Select value={schemaName || "__none__"} onValueChange={(v) => { setSchemaName(v === "__none__" ? "" : v); setTableName(""); }}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick…" />
                </SelectTrigger>
                <SelectContent>
                  {(schemasQ.data ?? []).map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Table</Label>
              <Select value={tableName || "__none__"} onValueChange={(v) => setTableName(v === "__none__" ? "" : v)} disabled={!schemaName}>
                <SelectTrigger>
                  <SelectValue placeholder={schemaName ? "Pick…" : "Pick schema first"} />
                </SelectTrigger>
                <SelectContent>
                  {(tablesQ.data ?? []).map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Events</Label>
            <div className="flex gap-2 flex-wrap">
              {ALL_EVENTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggleEvent(e)}
                  className={cn(
                    "px-2 py-1 rounded text-xs border",
                    events.includes(e)
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {e.replace("ROW_", "").toLowerCase()}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !schemaName || !tableName}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
