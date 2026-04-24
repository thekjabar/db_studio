import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ACTIONS = [
  'USER_SUSPENDED',
  'USER_UNSUSPENDED',
  'USER_DELETED',
  'BILLING_PRICE_CHANGED',
  'SUBSCRIPTION_OVERRIDE',
  'OPERATOR_CREATED',
  'OPERATOR_DISABLED',
  'OPERATOR_ENABLED',
];

export default function Audit() {
  const [action, setAction] = useState<string>('all');
  const [offset, setOffset] = useState(0);
  const limit = 100;
  const q = useQuery({
    queryKey: ['audit', action, offset],
    queryFn: () => api.listAudit(limit, offset, action === 'all' ? undefined : action),
    placeholderData: (p) => p,
  });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every operator action. Append-only.
        </p>
      </div>
      <Select value={action} onValueChange={(v) => { setAction(v); setOffset(0); }}>
        <SelectTrigger className="w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All actions</SelectItem>
          {ACTIONS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
        </SelectContent>
      </Select>
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Operator</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Reason</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground font-mono text-xs">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{r.operator.email}</td>
                <td className="px-3 py-2">
                  <Badge variant="outline" className="font-mono text-[10px]">{r.action}</Badge>
                </td>
                <td className="px-3 py-2 text-xs font-mono">
                  {r.targetType ? `${r.targetType}:${r.targetId}` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{r.reason ?? '—'}</td>
              </tr>
            ))}
            {q.data?.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                  No audit entries.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {q.data && q.data.total > limit && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>{offset + 1}–{Math.min(offset + limit, q.data.total)} of {q.data.total}</div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              Prev
            </Button>
            <Button size="sm" variant="outline" disabled={offset + limit >= q.data.total} onClick={() => setOffset(offset + limit)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
