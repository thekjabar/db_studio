import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertOctagon, Check, Ban, Plus, Trash2 } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useModal } from '@/components/modal-provider';

export default function Abuse() {
  const qc = useQueryClient();
  const modal = useModal();
  const [acked, setAcked] = useState<'open' | 'all' | 'acked'>('open');
  const ackedParam = acked === 'open' ? false : acked === 'acked' ? true : undefined;
  const events = useQuery({
    queryKey: ['abuse', acked],
    queryFn: () => api.listAbuse(ackedParam, undefined, undefined, 200, 0),
  });
  const blocked = useQuery({ queryKey: ['blocked-ips'], queryFn: () => api.listBlockedIps() });

  const [blockOpen, setBlockOpen] = useState(false);
  const [blockIp, setBlockIpInput] = useState('');
  const [blockReason, setBlockReason] = useState('');

  const ack = useMutation({
    mutationFn: (id: string) => api.ackAbuse(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['abuse'] }),
  });
  const ackIp = useMutation({
    mutationFn: (ip: string) => api.ackAbuseByIp(ip),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['abuse'] }),
  });
  const block = useMutation({
    mutationFn: () => api.blockIp(blockIp, blockReason || undefined),
    onSuccess: () => {
      toast.success('IP blocked');
      qc.invalidateQueries({ queryKey: ['blocked-ips'] });
      setBlockOpen(false);
      setBlockIpInput(''); setBlockReason('');
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Block failed');
    },
  });
  const unblock = useMutation({
    mutationFn: (ip: string) => api.unblockIp(ip),
    onSuccess: () => {
      toast.success('Unblocked');
      qc.invalidateQueries({ queryKey: ['blocked-ips'] });
    },
  });

  const onUnblock = async (ip: string) => {
    const ok = await modal.confirm({ title: `Unblock ${ip}?`, confirmLabel: 'Unblock' });
    if (ok) unblock.mutate(ip);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <AlertOctagon className="h-5 w-5 text-amber-500" /> Abuse events
          </h1>
          <p className="text-sm text-muted-foreground">
            Rate-limit hits, failed logins, quota exhaustion. Ack or block IPs.
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={acked} onValueChange={(v: 'open' | 'all' | 'acked') => setAcked(v)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Unacked</SelectItem>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="acked">Acked</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setBlockOpen(true)}><Plus className="h-4 w-4" /> Block IP</Button>
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Rule</th>
              <th className="px-3 py-2 font-medium">IP</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Path</th>
              <th className="px-3 py-2 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody>
            {events.data?.rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-3 py-2 text-xs text-muted-foreground font-mono">
                  {new Date(r.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2"><Badge variant="outline" className="font-mono">{r.rule}</Badge></td>
                <td className="px-3 py-2 font-mono text-xs">{r.ip ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{r.user?.email ?? r.userId ?? '—'}</td>
                <td className="px-3 py-2 font-mono text-xs truncate max-w-xs">{r.path ?? '—'}</td>
                <td className="px-3 py-2 text-right space-x-1">
                  {!r.ackedAt && (
                    <Button size="sm" variant="outline" onClick={() => ack.mutate(r.id)}>
                      <Check className="h-3 w-3" /> Ack
                    </Button>
                  )}
                  {r.ip && (
                    <Button size="sm" variant="outline" onClick={() => ackIp.mutate(r.ip!)}>
                      <Check className="h-3 w-3" /> Ack IP
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {events.data?.rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No events.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <section>
        <h2 className="text-sm font-medium mb-2 flex items-center gap-2">
          <Ban className="h-4 w-4" /> Blocked IPs
        </h2>
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">IP</th>
                <th className="px-3 py-2 font-medium">Reason</th>
                <th className="px-3 py-2 font-medium">Blocked</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {blocked.data?.map((b) => (
                <tr key={b.ip} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{b.ip}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{b.reason ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(b.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => onUnblock(b.ip)}>
                      <Trash2 className="h-3 w-3" /> Unblock
                    </Button>
                  </td>
                </tr>
              ))}
              {blocked.data?.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">No blocked IPs.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Block IP</DialogTitle>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); block.mutate(); }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>IP address</Label>
              <Input required value={blockIp} onChange={(e) => setBlockIpInput(e.target.value)} placeholder="203.0.113.5" />
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Input value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="Brute force login" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBlockOpen(false)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={block.isPending}>Block</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
