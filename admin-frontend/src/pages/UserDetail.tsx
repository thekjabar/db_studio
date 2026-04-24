import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Ban, CheckCircle2, Trash2, Activity, LifeBuoy } from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import { api, relativeDate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useModal } from '@/components/modal-provider';

export default function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const modal = useModal();
  const q = useQuery({ queryKey: ['user', id], queryFn: () => api.getUser(id!), enabled: !!id });

  const onSuspend = async () => {
    const reason = await modal.prompt({
      title: 'Suspend user',
      description: 'The user will be signed out and blocked from logging in. A reason is required and audit-logged.',
      placeholder: 'e.g. payment failed 3x, ToS violation',
      confirmLabel: 'Suspend',
      validate: (v) => (v.trim().length < 3 ? 'Reason must be at least 3 characters' : null),
    });
    if (!reason) return;
    try {
      await api.suspendUser(id!, reason);
      toast.success('User suspended');
      qc.invalidateQueries({ queryKey: ['user', id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const unsuspend = useMutation({
    mutationFn: () => api.unsuspendUser(id!),
    onSuccess: () => {
      toast.success('User unsuspended');
      qc.invalidateQueries({ queryKey: ['user', id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onDelete = async () => {
    const ok = await modal.confirm({
      title: 'Permanently delete this user?',
      description:
        'This removes the account, owned workspaces, memberships, and AI usage history. Customer data in connected databases stays in place (we never had access).',
      confirmLabel: 'Delete account',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(id!);
      toast.success('User deleted');
      navigate('/users', { replace: true });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (q.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!q.data) return <div className="p-6 text-sm text-destructive">Not found.</div>;

  const { user, workspaces, aiUsageToday } = q.data;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <Link to="/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to users
      </Link>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold font-mono">{user.email}</h1>
          <p className="text-sm text-muted-foreground">{user.displayName ?? '—'}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Joined {relativeDate(user.createdAt)} · {user.emailVerified ? 'Email verified' : 'Email not verified'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {user.suspendedAt ? (
            <Button variant="outline" onClick={() => unsuspend.mutate()} disabled={unsuspend.isPending}>
              <CheckCircle2 className="h-4 w-4" /> Unsuspend
            </Button>
          ) : (
            <Button variant="outline" onClick={onSuspend}>
              <Ban className="h-4 w-4" /> Suspend
            </Button>
          )}
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </div>

      {user.suspendedAt && (
        <Card className="p-3 border-destructive/30 bg-destructive/10">
          <div className="font-medium text-destructive text-sm">
            Suspended {relativeDate(user.suspendedAt)}
          </div>
          {user.suspendedReason && (
            <div className="mt-1 text-xs text-muted-foreground">Reason: {user.suspendedReason}</div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="AI calls today" value={aiUsageToday.toString()} />
        <Stat label="Workspaces owned" value={workspaces.length.toString()} />
        <Stat
          label="Seats owned"
          value={workspaces.reduce((s, w) => s + w.seats, 0).toString()}
        />
        <Stat
          label="AI top-up packs"
          value={workspaces.reduce((s, w) => s + (w.subscription?.aiTopUpPacks ?? 0), 0).toString()}
        />
      </div>

      <div>
        <h2 className="text-sm font-medium mb-2">Owned workspaces</h2>
        <Card className="divide-y divide-border p-0">
          {workspaces.map((w) => (
            <div key={w.id} className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{w.name}</div>
                <div className="text-xs text-muted-foreground font-mono truncate">
                  {w.slug} · {w.seats} seat{w.seats === 1 ? '' : 's'}
                </div>
              </div>
              <div className="text-right text-sm shrink-0">
                {w.subscription ? (
                  <>
                    <Badge variant="secondary">{w.subscription.status}</Badge>
                    <div className="text-xs text-muted-foreground mt-1">
                      ends {relativeDate(w.subscription.periodEnd)}
                    </div>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">No subscription</span>
                )}
              </div>
            </div>
          ))}
          {workspaces.length === 0 && (
            <div className="p-3 text-sm text-muted-foreground">None.</div>
          )}
        </Card>
      </div>

      <UserAnalyticsSection userId={user.id} />
      <SupportTimelineSection userId={user.id} />
    </div>
  );
}

function UserAnalyticsSection({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ['user-series', userId], queryFn: () => api.userSeries(userId, 30) });
  if (!q.data) return null;
  const label = q.data.classification.replace('_', ' ');
  const data = q.data.series;
  const tickInterval = Math.max(0, Math.ceil(data.length / 10) - 1);

  return (
    <div>
      <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
        <Activity className="h-4 w-4" /> Activity (last 30 days)
        <Badge
          variant={q.data.classification === 'active' ? 'outline' : q.data.classification === 'dormant' ? 'destructive' : 'secondary'}
          className="ml-2 capitalize"
        >
          {label}
        </Badge>
      </h2>
      <Card className="p-4">
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="day"
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                interval={tickInterval}
                tickFormatter={(iso: string) => {
                  const d = new Date(iso + 'T00:00:00Z');
                  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
                }}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
                width={36}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}
                labelFormatter={(v) => {
                  const d = new Date(String(v ?? '') + 'T00:00:00Z');
                  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
              <Line
                type="monotone"
                dataKey="logins"
                name="Logins"
                stroke="hsl(220 15% 55%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="queries"
                name="Queries"
                stroke="hsl(152 61% 52%)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="aiCalls"
                name="AI calls"
                stroke="#3ECF8E"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}

function SupportTimelineSection({ userId }: { userId: string }) {
  const q = useQuery({ queryKey: ['user-support', userId], queryFn: () => api.userSupport(userId) });
  if (!q.data) return null;
  const { failedLogins, suspendedLogins, abuseEvents } = q.data;
  const empty = failedLogins.length === 0 && suspendedLogins.length === 0 && abuseEvents.length === 0;
  return (
    <div>
      <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
        <LifeBuoy className="h-4 w-4" /> Support timeline
      </h2>
      {empty ? (
        <Card className="p-4 text-sm text-muted-foreground">No recent issues for this user. 🎉</Card>
      ) : (
        <div className="space-y-3">
          {failedLogins.length > 0 && (
            <Card className="p-3">
              <div className="text-xs font-medium">Failed logins ({failedLogins.length})</div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {failedLogins.slice(0, 10).map((r) => (
                  <li key={r.id}>
                    {new Date(r.createdAt).toLocaleString()} — {r.ip ?? 'unknown IP'}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {suspendedLogins.length > 0 && (
            <Card className="p-3">
              <div className="text-xs font-medium">Attempts while suspended ({suspendedLogins.length})</div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {suspendedLogins.slice(0, 10).map((r) => (
                  <li key={r.id}>{new Date(r.createdAt).toLocaleString()}</li>
                ))}
              </ul>
            </Card>
          )}
          {abuseEvents.length > 0 && (
            <Card className="p-3">
              <div className="text-xs font-medium">Abuse/quota events ({abuseEvents.length})</div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {abuseEvents.slice(0, 10).map((r) => (
                  <li key={r.id}>
                    {new Date(r.createdAt).toLocaleString()} — <span className="font-mono">{r.rule}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
    </Card>
  );
}
