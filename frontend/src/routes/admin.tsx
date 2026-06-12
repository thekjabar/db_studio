import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Activity,
  ArrowLeft,
  Database,
  Loader2,
  Search,
  ShieldCheck,
  Users,
  Webhook,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DialectBadge } from "@/components/dialect-badge";
import type { Dialect } from "@/lib/api";

type Tab = "overview" | "users" | "incidents";

export default function AdminRoute() {
  const user = useAuth((s) => s.user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");

  // Gate at the component level. The backend will 403 anyway, but avoiding
  // the blank dashboard for non-admins is a nicer UX than a toast.
  if (user && !user.isAdmin) {
    return <Navigate to="/connections" replace />;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate("/connections")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" /> Back to app
          </button>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Admin
          </div>
        </div>
        <div className="text-xs text-muted-foreground">{user?.email}</div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="flex items-center gap-1 mb-6 border-b border-border">
          <TabButton active={tab === "overview"} onClick={() => setTab("overview")}>
            <Activity className="h-3.5 w-3.5" /> Overview
          </TabButton>
          <TabButton active={tab === "users"} onClick={() => setTab("users")}>
            <Users className="h-3.5 w-3.5" /> Users
          </TabButton>
          <TabButton active={tab === "incidents"} onClick={() => setTab("incidents")}>
            <Activity className="h-3.5 w-3.5" /> Incidents
          </TabButton>
        </div>

        {tab === "overview" && <OverviewTab />}
        {tab === "users" && <UsersTab />}
        {tab === "incidents" && <IncidentsTab />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

function OverviewTab() {
  const overviewQ = useQuery({ queryKey: ["admin-overview"], queryFn: () => api.adminOverview() });
  const volumeQ = useQuery({ queryKey: ["admin-volume"], queryFn: () => api.adminQueryVolume() });
  const topConnQ = useQuery({ queryKey: ["admin-top-conns"], queryFn: () => api.adminTopConnections() });
  const topUsersQ = useQuery({ queryKey: ["admin-top-users"], queryFn: () => api.adminTopUsers() });

  const o = overviewQ.data;

  return (
    <div className="space-y-6">
      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Kpi label="Users" value={o?.users} hint={`${o?.admins ?? 0} admin${o?.admins === 1 ? "" : "s"}`} />
        <Kpi label="Workspaces" value={o?.workspaces} />
        <Kpi
          label="Connections"
          value={o?.connections}
          icon={<Database className="h-4 w-4 text-primary" />}
        />
        <Kpi
          label="Active webhooks"
          value={o?.webhooksEnabled}
          icon={<Webhook className="h-4 w-4 text-primary" />}
        />
        <Kpi label="Scheduled queries" value={o?.scheduledQueriesEnabled} />
        <Kpi label="API keys" value={o?.apiKeysActive} />
        <Kpi
          label="Active users (24h)"
          value={o?.last24h.activeUsers}
          hint={`${o?.last24h.signups ?? 0} signups`}
        />
        <Kpi
          label="Failed logins (24h)"
          value={o?.last24h.failedLogins}
          tone={o && o.last24h.failedLogins > 50 ? "warn" : undefined}
        />
      </div>

      {/* Query volume chart */}
      <div className="rounded-md border border-border bg-card p-4">
        <div className="text-sm font-semibold mb-1">Query volume — last 24 hours</div>
        <p className="text-xs text-muted-foreground mb-3">
          Hourly buckets across all connections. Schema changes stacked on queries.
        </p>
        <div className="h-56">
          {volumeQ.isLoading ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (volumeQ.data ?? []).length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              No queries recorded in this window.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={volumeQ.data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="hour"
                  tickFormatter={(v: string) => format(new Date(v), "HH:mm")}
                  className="text-[10px]"
                />
                <YAxis className="text-[10px]" />
                <Tooltip
                  labelFormatter={(v) => (typeof v === "string" ? format(new Date(v), "MMM d HH:mm") : "")}
                  contentStyle={{ fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey="queries"
                  stackId="1"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.3}
                  name="Queries"
                />
                <Area
                  type="monotone"
                  dataKey="schemaChanges"
                  stackId="1"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.3}
                  name="Schema changes"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Top lists */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TopList
          title="Top connections (7d)"
          loading={topConnQ.isLoading}
          rows={(topConnQ.data ?? []).map((r) => ({
            id: r.connectionId,
            primary: r.name,
            secondary: r.dialect ? <DialectBadge dialect={r.dialect as Dialect} /> : undefined,
            count: r.queries,
          }))}
          emptyText="No query activity recorded in the last 7 days."
        />
        <TopList
          title="Top users (7d)"
          loading={topUsersQ.isLoading}
          rows={(topUsersQ.data ?? []).map((r) => ({
            id: r.userId,
            primary: r.displayName || r.email,
            secondary: r.displayName ? <span className="text-muted-foreground">{r.email}</span> : undefined,
            count: r.queries,
          }))}
          emptyText="No user activity recorded in the last 7 days."
        />
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value?: number;
  hint?: string;
  icon?: React.ReactNode;
  tone?: "warn";
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {icon}
      </div>
      <div
        className={
          "text-2xl font-semibold mt-1 " + (tone === "warn" ? "text-amber-600 dark:text-amber-400" : "")
        }
      >
        {value === undefined ? "…" : value.toLocaleString()}
      </div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function TopList({
  title,
  loading,
  rows,
  emptyText,
}: {
  title: string;
  loading: boolean;
  rows: { id: string; primary: React.ReactNode; secondary?: React.ReactNode; count: number }[];
  emptyText: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-sm font-semibold mb-3">{title}</div>
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 text-sm border-b border-border last:border-b-0 pb-2 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{r.primary}</div>
                {r.secondary && <div className="text-[11px] mt-0.5">{r.secondary}</div>}
              </div>
              <span className="text-xs font-mono text-muted-foreground">
                {r.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.user);
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["admin-users", search],
    queryFn: () => api.adminListUsers({ search: search || undefined }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isAdmin }: { id: string; isAdmin: boolean }) =>
      api.adminSetUserAdmin(id, isAdmin),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      qc.invalidateQueries({ queryKey: ["admin-overview"] });
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email or name..."
            className="pl-7 h-9 text-sm"
          />
        </div>
      </div>

      <div className="rounded-md border border-border bg-card overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-3 py-2 font-medium">User</th>
              <th className="text-left px-3 py-2 font-medium">Verified</th>
              <th className="text-left px-3 py-2 font-medium">Joined</th>
              <th className="text-right px-3 py-2 font-medium">Admin</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline" />
                </td>
              </tr>
            )}
            {q.data?.items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                  No users match the search.
                </td>
              </tr>
            )}
            {q.data?.items.map((u) => (
              <tr key={u.id} className="border-b border-border last:border-b-0">
                <td className="px-3 py-2">
                  <div className="font-medium">{u.displayName || u.email}</div>
                  {u.displayName && (
                    <div className="text-[10px] text-muted-foreground">{u.email}</div>
                  )}
                  {u.oauthProvider && (
                    <Badge variant="secondary" className="text-[9px] mt-0.5">
                      {u.oauthProvider}
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {u.emailVerifiedAt
                    ? format(new Date(u.emailVerifiedAt), "MMM d yyyy")
                    : "—"}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {format(new Date(u.createdAt), "MMM d yyyy")}
                </td>
                <td className="px-3 py-2 text-right">
                  <Switch
                    checked={u.isAdmin}
                    disabled={toggle.isPending || u.id === me?.id}
                    onCheckedChange={(next) => toggle.mutate({ id: u.id, isAdmin: next })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground">
        You can't demote yourself from this screen. To remove the last admin, promote another user
        first, then sign in as them.
      </p>
    </div>
  );
}

function IncidentsTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ["admin-incidents"],
    queryFn: () => api.adminListIncidents(),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.adminDeleteIncident(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-incidents"] });
      toast.success("Deleted");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Events shown on the public <code>/status</code> page.
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          New incident
        </Button>
      </div>
      <div className="rounded-md border border-border bg-card divide-y divide-border">
        {list.data?.map((i) => (
          <IncidentRow
            key={i.id}
            incident={i}
            onChanged={() => qc.invalidateQueries({ queryKey: ["admin-incidents"] })}
            onDelete={() => del.mutate(i.id)}
          />
        ))}
        {list.data?.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No incidents on record.
          </div>
        )}
      </div>
      {open && <NewIncidentDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function IncidentRow({
  incident,
  onChanged,
  onDelete,
}: {
  incident: {
    id: string;
    title: string;
    status: "INVESTIGATING" | "IDENTIFIED" | "MONITORING" | "RESOLVED";
    severity: "MINOR" | "MAJOR" | "CRITICAL";
    impact: string | null;
    updates: { at: string; status: string; message: string }[];
    startedAt: string;
    resolvedAt: string | null;
  };
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [updateOpen, setUpdateOpen] = useState(false);
  const [status, setStatus] = useState<typeof incident.status>(incident.status);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    if (!message.trim()) {
      toast.error("Message required");
      return;
    }
    setSending(true);
    try {
      await api.adminAddIncidentUpdate(incident.id, { status, message });
      setMessage("");
      setUpdateOpen(false);
      onChanged();
    } catch (e) {
      toast.error(extractErrorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm">
        <Badge variant={incident.severity === "CRITICAL" ? "destructive" : incident.severity === "MAJOR" ? "warning" : "secondary"}>
          {incident.severity}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          {incident.status}
        </Badge>
        <span className="font-semibold truncate flex-1">{incident.title}</span>
        <span className="text-[11px] text-muted-foreground">
          {format(new Date(incident.startedAt), "MMM d HH:mm")}
        </span>
        {!incident.resolvedAt ? (
          <Button size="sm" variant="outline" onClick={() => setUpdateOpen((v) => !v)}>
            Update
          </Button>
        ) : null}
        <button
          onClick={onDelete}
          className="text-muted-foreground hover:text-destructive p-1"
          title="Delete"
        >
          ×
        </button>
      </div>
      {incident.updates.length > 0 && (
        <div className="text-[11px] font-mono space-y-0.5">
          {incident.updates.slice().reverse().slice(0, 3).map((u, i) => (
            <div key={i}>
              <span className="text-muted-foreground">{format(new Date(u.at), "MMM d HH:mm")}</span>{" "}
              <span className="text-primary">[{u.status}]</span> {u.message}
            </div>
          ))}
        </div>
      )}
      {updateOpen && (
        <div className="flex items-center gap-2 pt-1">
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INVESTIGATING">Investigating</SelectItem>
              <SelectItem value="IDENTIFIED">Identified</SelectItem>
              <SelectItem value="MONITORING">Monitoring</SelectItem>
              <SelectItem value="RESOLVED">Resolved</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Update message"
            className="h-8 text-xs flex-1"
          />
          <Button size="sm" onClick={submit} disabled={sending}>
            {sending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Post
          </Button>
        </div>
      )}
    </div>
  );
}

function NewIncidentDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<"MINOR" | "MAJOR" | "CRITICAL">("MINOR");
  const [impact, setImpact] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!title.trim() || !message.trim()) {
      toast.error("Title + initial update required");
      return;
    }
    setSaving(true);
    try {
      await api.adminCreateIncident({
        title,
        severity,
        impact: impact || undefined,
        message,
      });
      toast.success("Created");
      qc.invalidateQueries({ queryKey: ["admin-incidents"] });
      onClose();
    } catch (e) {
      toast.error(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card rounded-md border border-border w-full max-w-md p-4 space-y-3">
        <h3 className="font-semibold">New incident</h3>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
        <div className="grid grid-cols-2 gap-2">
          <Select value={severity} onValueChange={(v) => setSeverity(v as typeof severity)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MINOR">Minor</SelectItem>
              <SelectItem value="MAJOR">Major</SelectItem>
              <SelectItem value="CRITICAL">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Input value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="Impact (optional)" />
        </div>
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Initial update — what we know"
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
