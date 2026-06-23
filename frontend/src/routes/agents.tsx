import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Database, Loader2, Plus, Radio, Server, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type WorkspaceAgent } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ThemeToggle } from "@/components/theme-toggle";
import { useModal } from "@/components/modal-provider";

/**
 * Network agents management. An agent runs inside the customer's network and
 * proxies DB access for databases whose IP allowlist can't include the cloud.
 * Owners create an agent (one-time pairing token shown once), run it on a box
 * inside their network, then point connections at it via "Connect through agent".
 */
export default function AgentsPage() {
  const qc = useQueryClient();
  const modal = useModal();
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const workspacesQ = useQuery({ queryKey: ["workspaces"], queryFn: () => api.listWorkspaces() });
  const effectiveWs = workspaceId || workspacesQ.data?.[0]?.id || "";

  const agentsQ = useQuery({
    queryKey: ["agents", effectiveWs],
    queryFn: () => api.listAgents(effectiveWs),
    enabled: !!effectiveWs,
    refetchInterval: 15_000, // keep online/offline status fresh
  });

  const create = useMutation({
    mutationFn: (name: string) => api.createAgent(effectiveWs, name),
    onSuccess: (a) => {
      setNewToken(a.token);
      setCreateOpen(false);
      qc.invalidateQueries({ queryKey: ["agents", effectiveWs] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAgent(effectiveWs, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", effectiveWs] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteAgent(effectiveWs, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agents", effectiveWs] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const copyToken = async () => {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen gradient-bg flex flex-col">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" /> Query Schema
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <div className="max-w-4xl w-full mx-auto px-6 py-6 flex-1 flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <Server className="h-5 w-5" /> Network agents
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Run an agent inside your network to reach databases whose firewall/IP-allowlist
              will never include our servers. The agent connects out to us (no inbound ports), and
              the database connection originates from <strong>your</strong> network.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {workspacesQ.data && workspacesQ.data.length > 1 && (
              <Select value={effectiveWs} onValueChange={setWorkspaceId}>
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {workspacesQ.data.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button onClick={() => setCreateOpen(true)} disabled={!effectiveWs}>
              <Plus className="h-4 w-4" /> New agent
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border bg-card overflow-hidden">
          {agentsQ.isLoading ? (
            <div className="p-10 flex justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (agentsQ.data ?? []).length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No agents yet. Create one, then run it inside your network.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr className="text-left">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Token</th>
                  <th className="px-4 py-2 font-medium">Last seen</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(agentsQ.data ?? []).map((a: WorkspaceAgent) => (
                  <tr key={a.id}>
                    <td className="px-4 py-2.5 font-medium">{a.name}</td>
                    <td className="px-4 py-2.5">
                      {a.revokedAt ? (
                        <span className="text-muted-foreground">revoked</span>
                      ) : (
                        <span
                          className={
                            "inline-flex items-center gap-1.5 text-xs " +
                            (a.status === "online"
                              ? "text-emerald-500"
                              : "text-muted-foreground")
                          }
                        >
                          <Radio className="h-3 w-3" />
                          {a.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{a.tokenPrefix}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        {!a.revokedAt && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={async () => {
                              const ok = await modal.confirm({
                                title: `Revoke "${a.name}"?`,
                                description:
                                  "The agent will be disconnected and can no longer authenticate. Connections using it will fail until re-pointed.",
                                confirmLabel: "Revoke",
                                destructive: true,
                              });
                              if (ok) revoke.mutate(a.id);
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-destructive"
                          onClick={async () => {
                            const ok = await modal.confirm({
                              title: `Delete "${a.name}"?`,
                              description: "Permanently removes the agent.",
                              confirmLabel: "Delete",
                              destructive: true,
                            });
                            if (ok) del.mutate(a.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-md border border-border bg-card/50 p-4 text-xs text-muted-foreground space-y-1.5">
          <div className="font-medium text-foreground">Running an agent</div>
          <p>On a machine inside your network (that can reach the database), run:</p>
          <pre className="bg-muted rounded p-2 font-mono overflow-x-auto">
{`AGENT_RELAY_URL=https://database-api.mrwari.com \\
AGENT_TOKEN=<the token shown on create> \\
npm run agent`}
          </pre>
          <p>It connects outbound only — no inbound ports to open. Then set a connection's routing to “Through agent”.</p>
        </div>
      </div>

      {/* Create dialog */}
      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={(name) => create.mutate(name)}
        pending={create.isPending}
      />

      {/* One-time token reveal */}
      <Dialog open={!!newToken} onOpenChange={(v) => !v && setNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Agent pairing token</DialogTitle>
            <DialogDescription>
              Copy this now — it's shown only once. Put it in the agent's <code>AGENT_TOKEN</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={newToken ?? ""} className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={copyToken}>
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setNewToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (name: string) => void;
  pending: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New network agent</DialogTitle>
          <DialogDescription>Give it a name to recognize it later (e.g. "Office LAN box").</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Office LAN box" autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!name.trim() || pending}
            onClick={() => {
              onCreate(name.trim());
              setName("");
            }}
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
