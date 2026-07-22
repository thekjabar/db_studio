import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { CheckCircle2, Copy, Download, Loader2, Plus } from "lucide-react";
import {
  AGENT_SERVER_HOST,
  api,
  extractErrorMessage,
  type AgentPairingToken,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  /** Currently selected agent id (null when none picked). */
  agentId: string | null;
  onAgentIdChange: (id: string | null) => void;
}

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} copied`),
    () => {},
  );
}

/**
 * "Connect via local agent" section for the connection form. Mirrors
 * SshTunnelFields: a toggle plus, when on, an agent picker and a pairing panel.
 * The agent runs on a machine inside the user's network and byte-pipes DB
 * traffic, so the database only needs to allow the user's own network.
 */
export function AgentTunnelFields({ enabled, onEnabledChange, agentId, onAgentIdChange }: Props) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState("");
  // The last minted pairing token for the selected agent. Cleared when the
  // selected agent changes so we never show a stale token for the wrong agent.
  const [pairing, setPairing] = useState<AgentPairingToken | null>(null);

  const agentsQ = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.listAgents(),
    enabled,
  });

  // Poll the selected agent's status every 3s so the user sees it flip to
  // "online" moments after they run agent.exe.
  const statusQ = useQuery({
    queryKey: ["agent", agentId],
    queryFn: () => api.getAgent(agentId!),
    enabled: enabled && !!agentId,
    refetchInterval: 3000,
  });

  const create = useMutation({
    mutationFn: (name: string) => api.createAgent(name),
    onSuccess: (agent) => {
      toast.success("Agent created");
      setNewName("");
      setPairing(null);
      qc.invalidateQueries({ queryKey: ["agents"] });
      onAgentIdChange(agent.id);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const mintToken = useMutation({
    mutationFn: (id: string) => api.createAgentPairingToken(id),
    onSuccess: (t) => setPairing(t),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const selectAgent = (id: string | null) => {
    onAgentIdChange(id);
    setPairing(null); // a fresh token must be minted for the newly-picked agent
  };

  const online = statusQ.data?.online ?? false;
  const command = pairing
    ? `agent.exe --token ${pairing.token} --server ${AGENT_SERVER_HOST}`
    : "";

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onCheckedChange={onEnabledChange} id="agent-toggle" />
        <div>
          <label htmlFor="agent-toggle" className="text-sm font-medium cursor-pointer">
            Connect via local agent
          </label>
          <div className="text-xs text-muted-foreground">
            The agent runs on a computer inside the network that can reach your database. Query Schema
            routes queries through it, so your database only needs to allow your own network — not
            our server's IP.
          </div>
        </div>
      </div>

      {enabled && (
        <div className="space-y-3 pl-1">
          {/* Pick an existing agent … */}
          <div className="space-y-1.5">
            <Label>Agent</Label>
            <Select
              value={agentId ?? ""}
              onValueChange={(v) => selectAgent(v || null)}
              disabled={agentsQ.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={agentsQ.isLoading ? "Loading…" : "Select an agent"} />
              </SelectTrigger>
              <SelectContent>
                {(agentsQ.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                    {a.online ? " • online" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentsQ.data && agentsQ.data.length === 0 && (
              <div className="text-xs text-muted-foreground">
                No agents yet — create one below.
              </div>
            )}
          </div>

          {/* … or create a new one. */}
          <div className="space-y-1.5">
            <Label>Or create a new agent</Label>
            <div className="flex gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Office laptop"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (newName.trim()) create.mutate(newName.trim());
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!newName.trim() || create.isPending}
                onClick={() => create.mutate(newName.trim())}
              >
                {create.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                Create agent
              </Button>
            </div>
          </div>

          {/* Pairing panel — only once an agent is selected. */}
          {agentId && (
            <div className="rounded-md border border-border bg-muted/40 p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Pair this agent</div>
                {/* Live online/offline status (polled every 3s). */}
                <div className="flex items-center gap-1.5 text-xs">
                  <span
                    className={
                      "h-2 w-2 rounded-full " +
                      (online ? "bg-emerald-500" : "bg-muted-foreground/40")
                    }
                  />
                  <span className={online ? "text-emerald-500 font-medium" : "text-muted-foreground"}>
                    Agent: {online ? "online" : "offline"}
                  </span>
                </div>
              </div>

              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={mintToken.isPending}
                onClick={() => mintToken.mutate(agentId)}
              >
                {mintToken.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Get pairing command
              </Button>

              {pairing && (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">
                    Run this on the machine inside your network:
                  </div>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 rounded bg-background border border-border px-2 py-1.5 font-mono text-xs break-all select-all">
                      {command}
                    </code>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title="Copy command"
                      onClick={() => copy(command, "Command")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Token expires {new Date(pairing.expiresAt).toLocaleString()}.
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="secondary" asChild>
                  <Link to="/download" target="_blank" rel="noopener noreferrer">
                    <Download className="h-3.5 w-3.5" />
                    Download the agent
                  </Link>
                </Button>
                {online && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-500">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Paired &amp; connected
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground">
            Host and port below are resolved from the agent's side — enter the database address as
            seen from the agent's network.
          </div>
        </div>
      )}
    </div>
  );
}
