import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, Loader2 } from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from 'recharts';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const BRAND = {
  signups: '#3ECF8E',
  uniqueUsers: 'hsl(152 61% 52%)',
  logins: 'hsl(220 15% 55%)',
};

/**
 * Platform-level analytics. Area chart with axes, tooltip on hover, and
 * a legend that also serves as a color key. Tick density scales with the
 * range so 7/30/90/180-day views all stay readable.
 */
export default function Analytics() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['analytics-platform', days], queryFn: () => api.platformSeries(days) });

  const data = q.data ?? [];
  const totals = useMemo(() => {
    return data.reduce(
      (acc, d) => ({
        signups: acc.signups + d.signups,
        logins: acc.logins + d.logins,
        peakDAU: Math.max(acc.peakDAU, d.uniqueUsers),
      }),
      { signups: 0, logins: 0, peakDAU: 0 },
    );
  }, [data]);

  // Show at most ~10 date labels so the X axis never gets crowded.
  const tickInterval = Math.max(0, Math.ceil(data.length / 10) - 1);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" /> Analytics
          </h1>
          <p className="text-sm text-muted-foreground">Platform signups, logins, unique active users.</p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="180">Last 180 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatTile label="Signups" value={totals.signups} tone="brand" />
        <StatTile label="Logins" value={totals.logins} tone="muted" />
        <StatTile label="Peak daily active users" value={totals.peakDAU} tone="brand" />
      </div>

      <Card className="p-4">
        {q.isLoading ? (
          <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : data.length === 0 ? (
          <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
            No data for this range.
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 10, right: 16, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="ag-signups" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND.signups} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={BRAND.signups} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ag-uniq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND.uniqueUsers} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={BRAND.uniqueUsers} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ag-logins" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={BRAND.logins} stopOpacity={0.25} />
                    <stop offset="100%" stopColor={BRAND.logins} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="day"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  interval={tickInterval}
                  tickFormatter={shortDate}
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
                  labelFormatter={(v) => fullDate(String(v ?? ''))}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="circle" />
                <Area
                  type="monotone"
                  dataKey="logins"
                  name="Logins"
                  stroke={BRAND.logins}
                  fill="url(#ag-logins)"
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="uniqueUsers"
                  name="Unique active users"
                  stroke={BRAND.uniqueUsers}
                  fill="url(#ag-uniq)"
                  strokeWidth={2}
                />
                <Area
                  type="monotone"
                  dataKey="signups"
                  name="Signups"
                  stroke={BRAND.signups}
                  fill="url(#ag-signups)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number; tone: 'brand' | 'muted' }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tabular-nums ${tone === 'brand' ? 'text-primary' : ''}`}>
        {value.toLocaleString()}
      </div>
    </Card>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fullDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
