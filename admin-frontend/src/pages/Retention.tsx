import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Database, Save, Play } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const RESOURCE_LABELS: Record<string, string> = {
  audit_log: 'Audit log (non-query)',
  query_history: 'Query history (audit of SQL runs)',
  ai_usage_day: 'AI usage counters',
  slow_query_log: 'Slow query log',
  abuse_event: 'Abuse events',
  feedback: 'Closed feedback',
};

export default function Retention() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['retention'], queryFn: () => api.listRetention() });
  const [drafts, setDrafts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (q.data) {
      const next: Record<string, number> = {};
      for (const p of q.data) next[p.resource] = p.keepDays;
      setDrafts(next);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: (vars: { resource: string; keepDays: number }) => api.updateRetention(vars.resource, vars.keepDays),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['retention'] });
    },
  });

  const sweep = useMutation({
    mutationFn: () => api.sweepRetention(),
    onSuccess: (r) => {
      const total = Object.values(r).reduce((a, b) => a + b, 0);
      toast.success(`Sweep complete — ${total} row(s) deleted`);
      qc.invalidateQueries({ queryKey: ['retention'] });
    },
  });

  return (
    <div className="p-6 space-y-4 max-w-3xl">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" /> Data retention
          </h1>
          <p className="text-sm text-muted-foreground">
            Keep-days per resource. Nightly job deletes older rows.
          </p>
        </div>
        <Button onClick={() => sweep.mutate()} disabled={sweep.isPending}>
          <Play className="h-4 w-4" /> Run sweep now
        </Button>
      </div>

      <Card className="p-0 divide-y divide-border">
        {q.data?.map((p) => (
          <div key={p.resource} className="p-4 flex items-center gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-sm">{p.resource}</div>
              <div className="text-xs text-muted-foreground">
                {RESOURCE_LABELS[p.resource] ?? '—'}
              </div>
              {p.lastRunAt && (
                <div className="text-[11px] text-muted-foreground mt-1">
                  Last run {relativeDate(p.lastRunAt)} · {p.lastRunRowsDeleted} deleted
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={3650}
                value={drafts[p.resource] ?? p.keepDays}
                onChange={(e) => setDrafts({ ...drafts, [p.resource]: parseInt(e.target.value) || 1 })}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground">days</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => save.mutate({ resource: p.resource, keepDays: drafts[p.resource] ?? p.keepDays })}
                disabled={save.isPending || drafts[p.resource] === p.keepDays}
              >
                <Save className="h-3 w-3" /> Save
              </Button>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
