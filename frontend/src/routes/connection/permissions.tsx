import { useState, type FormEvent, useMemo } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api, extractErrorMessage, type ConnectionMember, type MemberRole, type TableGrant } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModal } from "@/components/modal-provider";

const ROLES: MemberRole[] = ["VIEWER", "EDITOR", "OWNER"];

function roleBadgeVariant(role: MemberRole) {
  switch (role) {
    case "OWNER":
      return "default" as const;
    case "EDITOR":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

export default function PermissionsRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <PermissionsInner connectionId={id} />;
}

function PermissionsInner({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const modal = useModal();

  const members = useQuery({
    queryKey: ["conn-members", connectionId],
    queryFn: () => api.listConnectionMembers(connectionId),
  });

  const grants = useQuery({
    queryKey: ["table-grants", connectionId],
    queryFn: () => api.listTableGrants(connectionId),
  });

  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["conn-members", connectionId] });
    qc.invalidateQueries({ queryKey: ["table-grants", connectionId] });
  };

  const addMember = useMutation({
    mutationFn: (input: { email: string; role: MemberRole }) =>
      api.addConnectionMember(connectionId, input),
    onSuccess: () => {
      toast.success("Member added");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const updateMember = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: MemberRole }) =>
      api.updateConnectionMember(connectionId, memberId, role),
    onSuccess: () => {
      toast.success("Role updated");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const removeMember = useMutation({
    mutationFn: (memberId: string) => api.removeConnectionMember(connectionId, memberId),
    onSuccess: () => {
      toast.success("Member removed");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const upsertGrant = useMutation({
    mutationFn: (input: {
      email: string;
      schemaName: string;
      tableName: string;
      role: MemberRole;
    }) => api.upsertTableGrant(connectionId, input),
    onSuccess: () => {
      toast.success("Table grant saved");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const removeGrant = useMutation({
    mutationFn: (grantId: string) => api.removeTableGrant(connectionId, grantId),
    onSuccess: () => {
      toast.success("Table grant removed");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="p-6 space-y-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-lg font-semibold">Permissions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Control who can access this connection and which tables they can modify.
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Connection members</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Members get the role below on every table by default. Table-level grants below override it.
          </p>
        </div>

        <AddMemberForm onAdd={(email, role) => addMember.mutate({ email, role })} busy={addMember.isPending} />

        <MembersTable
          members={members.data ?? []}
          loading={members.isLoading}
          onUpdate={(memberId, role) => updateMember.mutate({ memberId, role })}
          onRemove={async (memberId, email) => {
            const ok = await modal.confirm({
              title: "Remove member",
              description: `Remove ${email} from this connection? All table grants for this user will also be removed.`,
              confirmLabel: "Remove",
              destructive: true,
            });
            if (ok) removeMember.mutate(memberId);
          }}
          busy={updateMember.isPending || removeMember.isPending}
        />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Per-table grants</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Give a member a different role on a specific table — e.g. promote a VIEWER to EDITOR on one table, or demote an EDITOR to VIEWER on a sensitive one.
          </p>
        </div>

        <UpsertGrantForm
          members={members.data ?? []}
          schemas={schemasQ.data ?? []}
          onSubmit={(v) => upsertGrant.mutate(v)}
          busy={upsertGrant.isPending}
        />

        <GrantsTable
          grants={grants.data ?? []}
          loading={grants.isLoading}
          onRemove={(grantId) => removeGrant.mutate(grantId)}
          busy={removeGrant.isPending}
        />
      </section>
    </div>
  );
}

function AddMemberForm({
  onAdd,
  busy,
}: {
  onAdd: (email: string, role: MemberRole) => void;
  busy: boolean;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("VIEWER");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    onAdd(email.trim(), role);
    setEmail("");
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex-1 space-y-1">
        <Label className="text-xs">Email</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
      </div>
      <div className="w-32 space-y-1">
        <Label className="text-xs">Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
        Add member
      </Button>
    </form>
  );
}

function MembersTable({
  members,
  loading,
  onUpdate,
  onRemove,
  busy,
}: {
  members: ConnectionMember[];
  loading: boolean;
  onUpdate: (memberId: string, role: MemberRole) => void;
  onRemove: (memberId: string, email: string) => void;
  busy: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading members…
      </div>
    );
  }
  if (members.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground text-center">
        No members yet. Only the connection owner has access.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">User</th>
            <th className="text-left px-3 py-2 font-medium w-40">Role</th>
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {members.map((m) => (
            <tr key={m.id}>
              <td className="px-3 py-2">
                <div className="font-medium">{m.displayName ?? m.email}</div>
                {m.displayName && <div className="text-xs text-muted-foreground">{m.email}</div>}
              </td>
              <td className="px-3 py-2">
                <Select value={m.role} onValueChange={(v) => onUpdate(m.id, v as MemberRole)} disabled={busy}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => onRemove(m.id, m.email)}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UpsertGrantForm({
  members,
  schemas,
  onSubmit,
  busy,
}: {
  members: ConnectionMember[];
  schemas: string[];
  onSubmit: (v: { email: string; schemaName: string; tableName: string; role: MemberRole }) => void;
  busy: boolean;
}) {
  const [email, setEmail] = useState("");
  const [schemaName, setSchemaName] = useState("");
  const [tableName, setTableName] = useState("");
  const [role, setRole] = useState<MemberRole>("VIEWER");

  const memberEmails = useMemo(() => members.map((m) => m.email), [members]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email || !schemaName || !tableName) return;
    onSubmit({ email, schemaName: schemaName.trim(), tableName: tableName.trim(), role });
    setTableName("");
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-[1.3fr_0.8fr_0.8fr_0.7fr_auto] gap-2 rounded-md border border-border bg-card p-3">
      <div className="space-y-1">
        <Label className="text-xs">Member email</Label>
        <Input
          list="grant-member-emails"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
        />
        <datalist id="grant-member-emails">
          {memberEmails.map((e) => (
            <option key={e} value={e} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Schema</Label>
        <Input
          list="grant-schemas"
          value={schemaName}
          onChange={(e) => setSchemaName(e.target.value)}
          placeholder="public"
        />
        <datalist id="grant-schemas">
          {schemas.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Table</Label>
        <Input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="users" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Role</Label>
        <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-end">
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save grant"}
        </Button>
      </div>
    </form>
  );
}

function GrantsTable({
  grants,
  loading,
  onRemove,
  busy,
}: {
  grants: TableGrant[];
  loading: boolean;
  onRemove: (grantId: string) => void;
  busy: boolean;
}) {
  if (loading) {
    return (
      <div className="rounded-md border border-border p-6 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading grants…
      </div>
    );
  }
  if (grants.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground text-center">
        No per-table grants. Members use their connection-level role on every table.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">User</th>
            <th className="text-left px-3 py-2 font-medium">Table</th>
            <th className="text-left px-3 py-2 font-medium w-28">Role</th>
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {grants.map((g) => (
            <tr key={g.id}>
              <td className="px-3 py-2">
                <div className="font-medium">{g.displayName ?? g.email}</div>
                {g.displayName && <div className="text-xs text-muted-foreground">{g.email}</div>}
              </td>
              <td className="px-3 py-2 font-mono text-xs">
                {g.schemaName}.{g.tableName}
              </td>
              <td className="px-3 py-2">
                <Badge variant={roleBadgeVariant(g.role)}>{g.role}</Badge>
              </td>
              <td className="px-3 py-2 text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => onRemove(g.id)}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
