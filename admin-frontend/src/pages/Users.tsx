import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export default function Users() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const query = useQuery({
    queryKey: ['users', q, status, offset],
    queryFn: () => api.listUsers(q || undefined, status === 'all' ? undefined : status, limit, offset),
    placeholderData: (p) => p,
  });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Metadata only — operators never see connection configs, SQL, or customer data.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            placeholder="Search email or name"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v: 'all' | 'active' | 'suspended') => { setStatus(v); setOffset(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Workspaces</th>
              <th className="px-3 py-2 font-medium text-right">Connections</th>
              <th className="px-3 py-2 font-medium">Signed up</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.rows.map((u) => (
              <tr key={u.id} className="border-t border-border hover:bg-muted/40">
                <td className="px-3 py-2">
                  <Link to={`/users/${u.id}`} className="font-mono text-primary hover:underline">
                    {u.email}
                  </Link>
                  {u.isAdmin && (
                    <Badge variant="outline" className="ml-2 text-amber-500 border-amber-500/30">admin</Badge>
                  )}
                </td>
                <td className="px-3 py-2">{u.displayName ?? '—'}</td>
                <td className="px-3 py-2">
                  {u.suspendedAt ? (
                    <Badge variant="destructive">Suspended</Badge>
                  ) : u.emailVerified ? (
                    <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Active</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unverified</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {u.workspacesOwned + u.workspacesJoined}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{u.connections}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(u.createdAt)}</td>
              </tr>
            ))}
            {query.data?.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No users match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {query.data && query.data.total > limit && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>
            {offset + 1}–{Math.min(offset + limit, query.data.total)} of {query.data.total}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
              Prev
            </Button>
            <Button size="sm" variant="outline" disabled={offset + limit >= query.data.total} onClick={() => setOffset(offset + limit)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
