import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Copy, Database, Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { api, extractErrorMessage, type ApiKey, type Connection } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-store";
import { useModal } from "@/components/modal-provider";

export default function ApiKeysRoute() {
  const qc = useQueryClient();
  const modal = useModal();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);

  const keysQ = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });
  const connectionsQ = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.listConnections(),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      toast.success("Key revoked");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => {
      toast.success("Key deleted");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="min-h-screen gradient-bg">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          Query Schema
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <span className="hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50">{user?.email}</span>
          <ThemeToggle />
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Key className="h-6 w-6" /> API keys
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Use these tokens to script against Query Schema. Send them as{" "}
              <code className="bg-muted px-1 rounded text-xs">Authorization: Bearer dbs_live_…</code>
              {" "}against <code className="bg-muted px-1 rounded text-xs">/api/v1/*</code>.
            </p>
          </div>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> New key
          </Button>
        </div>

        <UsageHint />

        {keysQ.isLoading ? (
          <div className="rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !keysQ.data || keysQ.data.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-10 text-center">
            <div className="text-sm font-medium mb-1">No API keys yet</div>
            <div className="text-xs text-muted-foreground mb-4">
              Create one to run queries from scripts or CI.
            </div>
            <Button onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> New key
            </Button>
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Token</th>
                  <th className="text-left px-3 py-2 font-medium">Scope</th>
                  <th className="text-left px-3 py-2 font-medium">Last used</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keysQ.data.map((k) => (
                  <KeyRow
                    key={k.id}
                    k={k}
                    connections={connectionsQ.data ?? []}
                    onRevoke={() => revoke.mutate(k.id)}
                    onDelete={async () => {
                      const ok = await modal.confirm({
                        title: "Delete API key",
                        description: `Permanently delete "${k.name}"? Any services still using this token will break.`,
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok) remove.mutate(k.id);
                    }}
                    busy={revoke.isPending || remove.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewKeyDialog
        open={open}
        onOpenChange={setOpen}
        connections={connectionsQ.data ?? []}
        onCreated={(name, token) => setNewToken({ name, token })}
      />

      <Dialog open={!!newToken} onOpenChange={(v) => !v && setNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save this token</DialogTitle>
            <DialogDescription>
              This is the only time you'll see the full token. Copy and store it somewhere safe
              (password manager, CI secret, etc.).
            </DialogDescription>
          </DialogHeader>
          {newToken && (
            <div className="space-y-2">
              <div className="text-xs text-muted-foreground">Name: {newToken.name}</div>
              <div className="flex items-stretch gap-2">
                <Input
                  readOnly
                  value={newToken.token}
                  className="font-mono text-xs flex-1"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(newToken.token);
                      toast.success("Copied");
                    } catch {
                      toast.error("Copy failed");
                    }
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setNewToken(null)}>I saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UsageHint() {
  const apiUrl = (import.meta.env.VITE_API_URL ?? window.location.origin + "/api") as string;
  const exampleCurl = `curl -H "Authorization: Bearer dbs_live_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sql":"SELECT 1"}' \\\n  ${apiUrl}/v1/connections/<connectionId>/query`;
  return (
    <div className="rounded-md border border-border bg-card p-3 text-xs text-muted-foreground space-y-1">
      <div className="font-medium text-foreground">Endpoints (all under <code>/v1</code>)</div>
      <div>• <code>GET /v1/connections</code> — list connections this key can reach</div>
      <div>• <code>GET /v1/connections/:id/tables?schema=public</code> — list tables</div>
      <div>• <code>POST /v1/connections/:id/query</code> — run SQL; body <code>{"{sql, params?, maxRows?, confirmDestructive?}"}</code></div>
      <pre className="mt-2 bg-muted/40 p-2 rounded font-mono text-[11px] overflow-x-auto">{exampleCurl}</pre>
    </div>
  );
}

function KeyRow({
  k,
  connections,
  onRevoke,
  onDelete,
  busy,
}: {
  k: ApiKey;
  connections: Connection[];
  onRevoke: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const scope = k.connectionIds.length === 0
    ? "All connections"
    : k.connectionIds
        .map((id) => connections.find((c) => c.id === id)?.name ?? id)
        .join(", ");
  const revoked = !!k.revokedAt;
  const expired = k.expiresAt && new Date(k.expiresAt) < new Date();
  const statusLabel = revoked ? "revoked" : expired ? "expired" : "active";
  const statusVariant = revoked ? "destructive" : expired ? "warning" : "default";
  return (
    <tr className={revoked ? "opacity-60" : ""}>
      <td className="px-3 py-2">
        <div className="font-medium">{k.name}</div>
        <div className="text-xs text-muted-foreground">
          {k.expiresAt ? `expires ${formatDistanceToNow(new Date(k.expiresAt), { addSuffix: true })}` : "no expiry"}
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{k.tokenPrefix}</td>
      <td className="px-3 py-2 text-xs max-w-xs truncate" title={scope}>{scope}</td>
      <td className="px-3 py-2 text-xs">
        {k.lastUsedAt ? formatDistanceToNow(new Date(k.lastUsedAt), { addSuffix: true }) : "never"}
      </td>
      <td className="px-3 py-2">
        <Badge variant={statusVariant as "default" | "destructive" | "warning"}>{statusLabel}</Badge>
      </td>
      <td className="px-3 py-2 text-right">
        {!revoked && (
          <Button variant="ghost" size="sm" onClick={onRevoke} disabled={busy} title="Revoke">
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete} disabled={busy}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

function NewKeyDialog({
  open,
  onOpenChange,
  connections,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connections: Connection[];
  onCreated: (name: string, token: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"all" | "selected">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState<"never" | "30d" | "90d" | "365d">("never");
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setName("");
    setScope("all");
    setSelected(new Set());
    setExpiry("never");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const expiresAt =
        expiry === "never"
          ? undefined
          : new Date(Date.now() + expiryDays(expiry) * 24 * 60 * 60 * 1000).toISOString();
      const r = await api.createApiKey({
        name,
        connectionIds: scope === "selected" ? Array.from(selected) : [],
        expiresAt,
      });
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      onCreated(r.name, r.token);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : (reset(), onOpenChange(false)))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>Create a token your scripts can use to query the API.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Backup script" />
          </div>
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <div className="flex gap-2">
              <button
                type="button"
                className={`flex-1 rounded border px-2 py-1 text-xs ${
                  scope === "all"
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setScope("all")}
              >
                All connections
              </button>
              <button
                type="button"
                className={`flex-1 rounded border px-2 py-1 text-xs ${
                  scope === "selected"
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setScope("selected")}
              >
                Specific connections
              </button>
            </div>
          </div>
          {scope === "selected" && (
            <div className="space-y-1 max-h-40 overflow-y-auto rounded border border-border p-2">
              {connections.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-xs cursor-pointer px-1 py-1 hover:bg-accent rounded">
                  <Checkbox
                    checked={selected.has(c.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(selected);
                      if (v) next.add(c.id);
                      else next.delete(c.id);
                      setSelected(next);
                    }}
                  />
                  <span>{c.name}</span>
                  <span className="text-muted-foreground ml-auto">{c.dialect.toLowerCase()}</span>
                </label>
              ))}
              {connections.length === 0 && (
                <div className="text-xs text-muted-foreground px-1">No connections yet.</div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Expires</Label>
            <div className="flex gap-2">
              {(["never", "30d", "90d", "365d"] as const).map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`flex-1 rounded border px-2 py-1 text-xs ${
                    expiry === e
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setExpiry(e)}
                >
                  {e === "never" ? "Never" : e}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name || (scope === "selected" && selected.size === 0)}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function expiryDays(e: "30d" | "90d" | "365d"): number {
  return e === "30d" ? 30 : e === "90d" ? 90 : 365;
}
