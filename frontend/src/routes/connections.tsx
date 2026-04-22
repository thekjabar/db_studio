import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Code2, Database, Loader2, Network, Pencil, Plus, Shield, Table2, Trash2, Zap } from "lucide-react";
import { api, extractErrorMessage, type Connection, type CreateConnectionInput, type Dialect, type SshTunnelInput } from "@/lib/api";
import { SshTunnelFields, defaultSshTunnel } from "@/components/ssh-tunnel-fields";
import { EditConnectionDialog } from "@/components/edit-connection-dialog";
import { useModal } from "@/components/modal-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DialectBadge } from "@/components/dialect-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";

const DIALECTS: { value: Dialect; label: string; port: number }[] = [
  { value: "POSTGRES", label: "PostgreSQL", port: 5432 },
  { value: "MYSQL", label: "MySQL", port: 3306 },
  { value: "SQLITE", label: "SQLite", port: 0 },
  { value: "MSSQL", label: "SQL Server", port: 1433 },
];

export default function ConnectionsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const qc = useQueryClient();
  const modal = useModal();
  const { user, clear } = useAuth();
  const nav = useNavigate();

  const [workspaceId, setWorkspaceId] = useState<string>("");
  const wsQ = useQuery({ queryKey: ["workspaces"], queryFn: () => api.listWorkspaces() });

  const q = useQuery({
    queryKey: ["connections", workspaceId],
    queryFn: () => api.listConnections(workspaceId || undefined),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      toast.success("Connection deleted");
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.testConnection(id),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Connected${r.serverVersion ? ` — ${r.serverVersion}` : ""}`);
      else toast.error(r.message || "Connection failed");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const logout = async () => {
    try {
      await api.logout();
    } catch {}
    clear();
    qc.clear();
    nav("/login");
  };

  return (
    <div className="min-h-screen gradient-bg">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          DB Studio
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/schedules" className="text-sm text-muted-foreground hover:text-foreground">
            Schedules
          </Link>
          <span className="hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50">{user?.email}</span>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout}>
            Logout
          </Button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Connections</h1>
            <p className="text-sm text-muted-foreground">Databases you have access to.</p>
          </div>
          <div className="flex items-center gap-2">
            {wsQ.data && wsQ.data.length > 0 && (
              <Select value={workspaceId || "all"} onValueChange={(v) => setWorkspaceId(v === "all" ? "" : v)}>
                <SelectTrigger className="h-9 w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All my workspaces</SelectItem>
                  {wsQ.data.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}{w.isPersonal ? " (personal)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> New connection
            </Button>
          </div>
        </div>

        {q.isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg border border-border bg-card h-40 animate-pulse" />
            ))}
          </div>
        )}

        {q.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load connections: {extractErrorMessage(q.error)}
          </div>
        )}

        {q.data && q.data.length === 0 && (
          <FirstRunGuide onCreate={() => setDialogOpen(true)} />
        )}

        {q.data && q.data.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {q.data.map((c) => (
              <div
                key={c.id}
                className="group relative rounded-lg border border-border bg-card p-5 hover:border-primary/50 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                      {c.host}:{c.port}/{c.database}
                    </div>
                  </div>
                  <DialectBadge dialect={c.dialect} />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-4">
                  <span className="font-mono">{c.user}</span>
                  {c.readOnly && (
                    <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-400">RO</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => test.mutate(c.id)}
                    disabled={test.isPending && test.variables === c.id}
                  >
                    {test.isPending && test.variables === c.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Zap className="h-3.5 w-3.5" />
                    )}
                    Test
                  </Button>
                  <Button size="sm" asChild>
                    <Link to={`/c/${c.id}/t/public/`}>
                      Connect <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Edit connection"
                    onClick={() => setEditing(c)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={async () => {
                      const ok = await modal.confirm({
                        title: `Delete "${c.name}"?`,
                        description: "This removes the connection. It cannot be undone.",
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok) del.mutate(c.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <NewConnectionDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      <EditConnectionDialog connection={editing} onOpenChange={(v) => !v && setEditing(null)} />
    </div>
  );
}

function FirstRunGuide({ onCreate }: { onCreate: () => void }) {
  const features = [
    {
      icon: Table2,
      title: "Browse tables",
      desc: "Filter, sort, edit rows and bulk-delete with PK-safe updates.",
    },
    {
      icon: Code2,
      title: "Run SQL",
      desc: "Query editor with autosave history and destructive-statement guards.",
    },
    {
      icon: Network,
      title: "Visualise relationships",
      desc: "Auto-generated ER diagram from your foreign keys.",
    },
    {
      icon: Shield,
      title: "Audit every change",
      desc: "Schema edits, inserts, updates and deletes all get logged.",
    },
  ];
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/50 p-8 md:p-12">
      <div className="max-w-2xl mx-auto text-center space-y-4">
        <div className="h-12 w-12 mx-auto rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center">
          <Database className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-xl font-semibold">Welcome to DB Studio</h2>
        <p className="text-sm text-muted-foreground">
          Connect a database to start browsing tables, running queries, editing schema, and tracking changes.
          Credentials are encrypted at rest — the dashboard never sees plain-text passwords again after save.
        </p>
        <div className="pt-2">
          <Button size="lg" onClick={onCreate}>
            <Plus className="h-4 w-4" /> Add your first connection
          </Button>
        </div>
      </div>
      <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto">
        {features.map((f) => (
          <div key={f.title} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
            <div className="h-8 w-8 shrink-0 rounded-md bg-muted flex items-center justify-center text-muted-foreground">
              <f.icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-medium">{f.title}</div>
              <div className="text-xs text-muted-foreground">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewConnectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const [dialect, setDialect] = useState<Dialect>("POSTGRES");
  const [name, setName] = useState("");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [sslMode, setSslMode] = useState("");
  const [sshEnabled, setSshEnabled] = useState(false);
  const [ssh, setSsh] = useState<SshTunnelInput>(defaultSshTunnel);
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setName("");
    setHost("localhost");
    setPort(5432);
    setDatabase("");
    setUser("");
    setPassword("");
    setReadOnly(false);
    setSslMode("");
    setSshEnabled(false);
    setSsh(defaultSshTunnel());
    setDialect("POSTGRES");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const input: CreateConnectionInput = {
        name,
        dialect,
        host,
        port,
        database,
        user,
        password,
        readOnly,
        sslMode: sslMode || undefined,
        ssh: sshEnabled ? ssh : undefined,
      };
      const created = await api.createConnection(input);
      toast.success("Connection created");
      try {
        const r = await api.testConnection(created.id);
        if (r.ok) toast.success(`Test OK${r.serverVersion ? ` — ${r.serverVersion}` : ""}`);
        else toast.warning(r.message || "Created but test failed");
      } catch (err) {
        toast.warning("Created but test failed: " + extractErrorMessage(err));
      }
      qc.invalidateQueries({ queryKey: ["connections"] });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New connection</DialogTitle>
          <DialogDescription>Connect to a database server.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="My Database" />
            </div>
            <div className="space-y-1.5">
              <Label>Dialect</Label>
              <Select
                value={dialect}
                onValueChange={(v: Dialect) => {
                  setDialect(v);
                  const d = DIALECTS.find((d) => d.value === v);
                  if (d) setPort(d.port);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DIALECTS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="space-y-1.5">
              <Label>Host</Label>
              <Input required value={host} onChange={(e) => setHost(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Port</Label>
              <NumberInput
                value={String(port)}
                onChange={(v) => setPort(parseInt(v, 10) || 0)}
                integer
                min={1}
                max={65535}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Database</Label>
            <Input required value={database} onChange={(e) => setDatabase(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>User</Label>
              <Input required value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>SSL mode</Label>
              <Input value={sslMode} onChange={(e) => setSslMode(e.target.value)} placeholder="disable | require" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <Switch checked={readOnly} onCheckedChange={setReadOnly} id="ro" />
              <label htmlFor="ro" className="text-sm">Read only</label>
            </div>
          </div>
          <SshTunnelFields
            enabled={sshEnabled}
            onEnabledChange={setSshEnabled}
            value={ssh}
            onChange={setSsh}
          />
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create & test
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
