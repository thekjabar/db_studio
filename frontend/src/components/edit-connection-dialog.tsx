import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, extractErrorMessage, type Connection, type SshTunnelInput } from "@/lib/api";
import { SshTunnelFields, defaultSshTunnel } from "@/components/ssh-tunnel-fields";

interface Props {
  connection: Connection | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Edit an existing connection. Credentials fields are blank on open — only
 * filled-in fields are sent (backend merges into stored creds). This lets the
 * user rotate just a password without re-entering host/port/db.
 */
export function EditConnectionDialog({ connection, onOpenChange }: Props) {
  const qc = useQueryClient();
  const open = !!connection;

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | "">("");
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [sslMode, setSslMode] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  // Tri-state for SSH: null = "leave unchanged" (default when dialog opens),
  //                   {…} = "set/update tunnel to this config",
  //                   {cleared: true} = "remove the tunnel".
  const [sshMode, setSshMode] = useState<"unchanged" | "set" | "clear">("unchanged");
  const [ssh, setSsh] = useState<SshTunnelInput>(defaultSshTunnel);

  const [alertMs, setAlertMs] = useState("");
  const [alertEmail, setAlertEmail] = useState("");

  useEffect(() => {
    if (!connection) return;
    setName(connection.name);
    setReadOnly(!!connection.readOnly);
    setAlertMs(connection.slowQueryAlertMs ? String(connection.slowQueryAlertMs) : "");
    setAlertEmail(connection.slowQueryAlertEmail ?? "");
    // Credentials start blank — user fills only what changes.
    setHost("");
    setPort("");
    setDatabase("");
    setUser("");
    setPassword("");
    setSslMode("");
    setSshMode("unchanged");
    setSsh(defaultSshTunnel());
  }, [connection]);

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.updateConnection>[1]) =>
      api.updateConnection(connection!.id, body),
    onSuccess: () => {
      toast.success("Connection updated");
      qc.invalidateQueries({ queryKey: ["connections"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!connection) return;
    const patch: Parameters<typeof api.updateConnection>[1] = {};
    if (name !== connection.name) patch.name = name;
    if (readOnly !== !!connection.readOnly) patch.readOnly = readOnly;
    if (host) patch.host = host;
    if (port !== "" && Number.isFinite(port)) patch.port = Number(port);
    if (database) patch.database = database;
    if (user) patch.user = user;
    if (password) patch.password = password;
    if (sslMode) patch.sslMode = sslMode;
    if (sshMode === "set") patch.ssh = ssh;
    else if (sshMode === "clear") patch.ssh = null;
    // Slow-query alert: empty = clear (null), value = set.
    const msNum = alertMs.trim() === "" ? null : parseInt(alertMs, 10) || null;
    if (msNum !== (connection.slowQueryAlertMs ?? null)) patch.slowQueryAlertMs = msNum;
    const emailVal = alertEmail.trim() || null;
    if (emailVal !== (connection.slowQueryAlertEmail ?? null)) patch.slowQueryAlertEmail = emailVal;

    if (Object.keys(patch).length === 0) {
      toast.info("Nothing to update");
      return;
    }
    update.mutate(patch);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onOpenChange(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit connection</DialogTitle>
          <DialogDescription>
            Leave credential fields blank to keep the current value. Fill in only what you want to change.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          <div className="border-t border-border pt-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Credentials
            </div>
            <div className="grid grid-cols-[1fr_140px] gap-3">
              <div className="space-y-1.5">
                <Label>Host</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="unchanged" />
              </div>
              <div className="space-y-1.5">
                <Label>Port</Label>
                <NumberInput
                  value={port === "" ? "" : String(port)}
                  onChange={(v) => setPort(v === "" ? "" : (parseInt(v, 10) || 0))}
                  integer
                />
              </div>
            </div>
            <div className="space-y-1.5 mt-3">
              <Label>Database</Label>
              <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="unchanged" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <div className="space-y-1.5">
                <Label>User</Label>
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="unchanged" />
              </div>
              <div className="space-y-1.5">
                <Label>Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="space-y-1.5 mt-3">
              <Label>SSL mode</Label>
              <Input
                value={sslMode}
                onChange={(e) => setSslMode(e.target.value)}
                placeholder="disable / require / verify-ca / verify-full"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Switch checked={readOnly} onCheckedChange={setReadOnly} />
            <div>
              <div className="text-sm font-medium">Read-only</div>
              <div className="text-xs text-muted-foreground">
                Prevent writes from this connection.
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4 space-y-2">
            <div className="text-sm font-medium">Slow-query alert</div>
            <p className="text-xs text-muted-foreground">
              Email when a query exceeds the threshold (max one alert per 15 min). Leave blank to disable.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Threshold (ms)</Label>
                <Input
                  value={alertMs}
                  onChange={(e) => setAlertMs(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="e.g. 5000"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Alert email</Label>
                <Input
                  type="email"
                  value={alertEmail}
                  onChange={(e) => setAlertEmail(e.target.value)}
                  placeholder="ops@company.com"
                />
              </div>
            </div>
          </div>

          <SshTunnelFields
            enabled={sshMode === "set"}
            onEnabledChange={(on) => setSshMode(on ? "set" : "unchanged")}
            value={ssh}
            onChange={setSsh}
            keepExisting
          />
          {sshMode !== "clear" && (
            <div className="text-xs text-muted-foreground pl-1">
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setSshMode("clear")}
              >
                Remove existing SSH tunnel
              </button>
            </div>
          )}
          {sshMode === "clear" && (
            <div className="text-xs text-destructive pl-1">
              SSH tunnel will be removed on save.{" "}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => setSshMode("unchanged")}
              >
                Undo
              </button>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
