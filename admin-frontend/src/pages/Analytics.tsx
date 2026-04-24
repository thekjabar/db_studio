import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function Analytics() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['analytics-platform', days], queryFn: () => api.platformSeries(days) });

  const max = (q.data ?? []).reduce((m, d) => Math.max(m, d.signups, d.logins, d.uniqueUsers), 1);

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
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="90">90 days</SelectItem>
            <SelectItem value="180">180 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="p-4">
        <div className="flex items-end gap-px h-48">
          {(q.data ?? []).map((d) => (
            <div key={d.day} className="flex-1 flex flex-col justify-end items-stretch h-full" title={
              `${d.day}\nsignups: ${d.signups}\nlogins: ${d.logins}\nunique: ${d.uniqueUsers}`
            }>
              <div className="flex flex-col justify-end items-stretch h-full gap-px">
                <div style={{ height: `${(d.signups / max) * 100}%` }} className="bg-emerald-500/70 min-h-[1px]" />
                <div style={{ height: `${(d.uniqueUsers / max) * 100}%` }} className="bg-primary/60 min-h-[1px]" />
                <div style={{ height: `${(d.logins / max) * 100}%` }} className="bg-primary/30 min-h-[1px]" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
          <Legend color="bg-emerald-500/70" label="Signups" />
          <Legend color="bg-primary/60" label="Unique active users" />
          <Legend color="bg-primary/30" label="Logins" />
        </div>
      </Card>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />
      {label}
    </span>
  );
}
