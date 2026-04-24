import { useQuery } from '@tanstack/react-query';
import { DollarSign, Users, Briefcase, Sparkles, AlertOctagon, TrendingUp, Loader2 } from 'lucide-react';
import { api, money } from '@/lib/api';
import { Card } from '@/components/ui/card';

export default function Dashboard() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.dashboard(), refetchInterval: 30_000 });

  if (q.isLoading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (q.error || !q.data) return <div className="p-6 text-sm text-destructive">Failed to load dashboard.</div>;

  const d = q.data;
  const tiles = [
    { label: 'MRR', value: money(d.mrrCents, d.currency), icon: DollarSign, hint: `${d.activeSubscriptions} active subs` },
    { label: 'Active seats', value: d.activeSeats.toLocaleString(), icon: Users, hint: `${d.activeTopUpPacks} AI top-up packs` },
    { label: 'Users', value: d.totalUsers.toLocaleString(), icon: Users, hint: `${d.usersThisWeek} this week · ${d.usersThisMonth} this month` },
    { label: 'Workspaces', value: d.totalWorkspaces.toLocaleString(), icon: Briefcase },
    { label: 'Suspended users', value: d.suspendedUsers.toLocaleString(), icon: AlertOctagon, tone: d.suspendedUsers > 0 ? 'warn' : undefined },
    { label: 'Cancellations (30d)', value: d.cancelledThisMonth.toLocaleString(), icon: TrendingUp },
    { label: 'AI calls today', value: d.aiCallsToday.toLocaleString(), icon: Sparkles },
  ];

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Revenue and platform health at a glance.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground uppercase tracking-wide">{t.label}</span>
              <t.icon className={`h-4 w-4 ${t.tone === 'warn' ? 'text-amber-500' : 'text-muted-foreground'}`} />
            </div>
            <div className="mt-2 text-2xl font-semibold">{t.value}</div>
            {t.hint && <div className="mt-1 text-[11px] text-muted-foreground">{t.hint}</div>}
          </Card>
        ))}
      </div>
      <Card className="p-4">
        <div className="text-sm font-medium">Subscriptions by status</div>
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          {['ACTIVE', 'TRIALING', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].map((s) => (
            <div key={s} className="rounded-md border border-border p-2.5">
              <div className="text-[10px] uppercase text-muted-foreground tracking-wide">
                {s.toLowerCase().replace('_', ' ')}
              </div>
              <div className="text-lg font-semibold">{d.byStatus[s] ?? 0}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
