import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, UserPlus, KeyRound, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import {
  api, extractErrorMessage,
  type DbUser, type GrantInput, type PrivilegeLevel,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";

const LEVEL_PRIVS: Record<PrivilegeLevel, string[]> = {
  database: ["CONNECT", "CREATE", "TEMPORARY"],
  schema: ["USAGE", "CREATE"],
  table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
};

export default function DbUsersRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <DbUsersInner connectionId={id} />;
}

function DbUsersInner({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const modal = useModal();
  const [privFor, setPrivFor] = useState<string | null>(null);

  const users = useQuery({
    queryKey: ["db-users", connectionId],
    queryFn: () => api.listDbUsers(connectionId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["db-users", connectionId] });

  const dropUser = useMutation({
    mutationFn: (role: string) => api.dropDbUser(connectionId, role),
    onSuccess: () => { toast.success("User dropped"); invalidate(); },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const onDrop = async (role: string) => {
    const ok = await modal.confirm({
      title: `Drop user "${role}"?`,
      description:
        "This permanently removes the role from the database. It will fail if the role still owns objects or has privileges that depend on it.",
      confirmLabel: "Drop user",
      destructive: true,
    });
    if (ok) dropUser.mutate(role);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-5 w-5" /> Database users
        </h1>
        <p className="text-sm text-muted-foreground">
          Create and manage roles directly on this PostgreSQL server, and grant or revoke their privileges.
        </p>
      </div>

      <CreateUserForm connectionId={connectionId} onCreated={invalidate} />

      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Role</th>
              <th className="px-3 py-2 text-left font-medium">Attributes</th>
              <th className="px-3 py-2 text-left font-medium">Member of</th>
              <th className="px-3 py-2 w-28" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.isLoading && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </td></tr>
            )}
            {users.data?.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">No roles found.</td></tr>
            )}
            {users.data?.map((u) => (
              <tr key={u.name}>
                <td className="px-3 py-2">
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {u.can_login ? "Login role" : "Group role (no login)"}
                    {u.connection_limit >= 0 && u.connection_limit !== -1 ? ` · limit ${u.connection_limit}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <AttributeBadges u={u} />
                </td>
                <td className="px-3 py-2">
                  {u.member_of.length === 0
                    ? <span className="text-muted-foreground">—</span>
                    : <div className="flex flex-wrap gap-1">
                        {u.member_of.map((m) => <Badge key={m} variant="secondary">{m}</Badge>)}
                      </div>}
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" title="Privileges"
                      onClick={() => setPrivFor(u.name)}>
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" title="Drop user"
                      onClick={() => onDrop(u.name)} disabled={dropUser.isPending}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {privFor && (
        <PrivilegesDialog
          connectionId={connectionId}
          role={privFor}
          onClose={() => setPrivFor(null)}
        />
      )}
    </div>
  );
}

function AttributeBadges({ u }: { u: DbUser }) {
  const flags: { label: string; on: boolean; variant: "default" | "warning" | "secondary" }[] = [
    { label: "SUPERUSER", on: u.superuser, variant: "warning" },
    { label: "CREATEDB", on: u.create_db, variant: "secondary" },
    { label: "CREATEROLE", on: u.create_role, variant: "secondary" },
    { label: "REPLICATION", on: u.replication, variant: "secondary" },
  ];
  const active = flags.filter((f) => f.on);
  if (active.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((f) => <Badge key={f.label} variant={f.variant}>{f.label}</Badge>)}
    </div>
  );
}

function CreateUserForm({ connectionId, onCreated }: { connectionId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [login, setLogin] = useState(true);
  const [superuser, setSuperuser] = useState(false);
  const [createDb, setCreateDb] = useState(false);
  const [createRole, setCreateRole] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createDbUser(connectionId, {
        name: name.trim(),
        password: password || undefined,
        login, superuser, createDb, createRole,
      }),
    onSuccess: () => {
      toast.success(`User "${name.trim()}" created`);
      setName(""); setPassword(""); setSuperuser(false); setCreateDb(false); setCreateRole(false); setLogin(true);
      onCreated();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast.error("Role name is required");
    if (login && !password) return toast.error("A login role needs a password");
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="text-sm font-medium">Create a new user</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">Role name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="app_user" autoCapitalize="none" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Password {login ? "" : "(optional)"}</Label>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 pt-1">
        <CheckOpt label="Can log in" checked={login} onChange={setLogin} />
        <CheckOpt label="Superuser" checked={superuser} onChange={setSuperuser} />
        <CheckOpt label="Create databases" checked={createDb} onChange={setCreateDb} />
        <CheckOpt label="Create roles" checked={createRole} onChange={setCreateRole} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          Create user
        </Button>
      </div>
    </form>
  );
}

function CheckOpt({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(Boolean(v))} />
      {label}
    </label>
  );
}

function PrivilegesDialog({ connectionId, role, onClose }: { connectionId: string; role: string; onClose: () => void }) {
  const qc = useQueryClient();
  const privQ = useQuery({
    queryKey: ["db-user-privs", connectionId, role],
    queryFn: () => api.getDbUserPrivileges(connectionId, role),
  });
  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["db-user-privs", connectionId, role] });
  };

  const grant = useMutation({
    mutationFn: (body: GrantInput) => api.grantDbPrivilege(connectionId, body),
    onSuccess: () => { toast.success("Privilege granted"); refresh(); },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (body: GrantInput) => api.revokeDbPrivilege(connectionId, body),
    onSuccess: () => { toast.success("Privilege revoked"); refresh(); },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  // grant form state
  const [level, setLevel] = useState<PrivilegeLevel>("schema");
  const [schema, setSchema] = useState("");
  const [table, setTable] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [withGrant, setWithGrant] = useState(false);

  const tablesQ = useQuery({
    queryKey: ["tables", connectionId, schema],
    queryFn: () => api.listTables(connectionId, schema),
    enabled: level === "table" && !!schema,
  });

  const togglePriv = (p: string) =>
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));

  const doGrant = () => {
    if (selected.length === 0) return toast.error("Pick at least one privilege");
    if (level !== "database" && !schema) return toast.error("Choose a schema");
    if (level === "table" && !table) return toast.error("Choose a table");
    grant.mutate({
      role, level, privileges: selected,
      schema: level === "database" ? undefined : schema,
      table: level === "table" ? table : undefined,
      withGrantOption: withGrant,
    });
    setSelected([]);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Privileges · {role}
          </DialogTitle>
        </DialogHeader>

        {/* Grant form */}
        <div className="space-y-3 rounded-md border border-border bg-card p-3">
          <div className="text-sm font-medium">Grant a privilege</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Level</Label>
              <Select value={level} onValueChange={(v) => { setLevel(v as PrivilegeLevel); setSelected([]); setTable(""); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="database">Database</SelectItem>
                  <SelectItem value="schema">Schema</SelectItem>
                  <SelectItem value="table">Table</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {level !== "database" && (
              <div className="space-y-1">
                <Label className="text-xs">Schema</Label>
                <Select value={schema} onValueChange={(v) => { setSchema(v); setTable(""); }}>
                  <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
                  <SelectContent>
                    {schemasQ.data?.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {level === "table" && (
              <div className="space-y-1">
                <Label className="text-xs">Table</Label>
                <Select value={table} onValueChange={setTable} disabled={!schema}>
                  <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
                  <SelectContent>
                    {tablesQ.data?.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {LEVEL_PRIVS[level].map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-2 text-xs">
                <Checkbox checked={selected.includes(p)} onCheckedChange={() => togglePriv(p)} />
                {p}
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <CheckOpt label="With grant option" checked={withGrant} onChange={setWithGrant} />
            <Button size="sm" onClick={doGrant} disabled={grant.isPending}>
              {grant.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Grant
            </Button>
          </div>
        </div>

        {/* Current privileges */}
        <div className="max-h-72 space-y-3 overflow-auto">
          {privQ.isLoading && <div className="py-4 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></div>}
          {privQ.data && (
            <>
              <PrivGroup
                title="Database"
                rows={privQ.data.database.map((d) => ({ key: `db-${d.privilege_type}`, label: `${d.database}`, priv: d.privilege_type, level: "database" as PrivilegeLevel }))}
                onRevoke={(r) => revoke.mutate({ role, level: "database", privileges: [r.priv] })}
                busy={revoke.isPending}
              />
              <PrivGroup
                title="Schema"
                rows={privQ.data.schema.map((d) => ({ key: `sc-${d.schema}-${d.privilege_type}`, label: d.schema, priv: d.privilege_type, level: "schema" as PrivilegeLevel, schema: d.schema }))}
                onRevoke={(r) => revoke.mutate({ role, level: "schema", privileges: [r.priv], schema: r.schema })}
                busy={revoke.isPending}
              />
              <PrivGroup
                title="Table"
                rows={privQ.data.table.map((d) => ({ key: `tb-${d.schema}-${d.table}-${d.privilege_type}`, label: `${d.schema}.${d.table}`, priv: d.privilege_type, level: "table" as PrivilegeLevel, schema: d.schema, table: d.table }))}
                onRevoke={(r) => revoke.mutate({ role, level: "table", privileges: [r.priv], schema: r.schema, table: r.table })}
                busy={revoke.isPending}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PrivRow = { key: string; label: string; priv: string; level: PrivilegeLevel; schema?: string; table?: string };

function PrivGroup({ title, rows, onRevoke, busy }: { title: string; rows: PrivRow[]; onRevoke: (r: PrivRow) => void; busy: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">No {title.toLowerCase()}-level privileges.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((r) => (
            <span key={r.key} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-medium">{r.priv}</span>
              <button
                className="rounded-full p-0.5 text-muted-foreground hover:text-destructive"
                title="Revoke" onClick={() => onRevoke(r)} disabled={busy}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
