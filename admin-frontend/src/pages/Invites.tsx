import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ticket, Plus, Trash2, Send } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useModal } from '@/components/modal-provider';

export default function Invites() {
  const qc = useQueryClient();
  const modal = useModal();
  const codes = useQuery({ queryKey: ['invite-codes'], queryFn: () => api.listInviteCodes(100, 0) });
  const wait = useQuery({ queryKey: ['waitlist'], queryFn: () => api.listWaitlist(200, 0) });
  const [createOpen, setCreateOpen] = useState(false);
  const [code, setCode] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [assignedEmail, setAssignedEmail] = useState('');
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () => api.createInviteCode({
      code: code || undefined,
      maxUses,
      assignedEmail: assignedEmail || undefined,
      note: note || undefined,
    }),
    onSuccess: () => {
      toast.success('Invite code created');
      qc.invalidateQueries({ queryKey: ['invite-codes'] });
      setCreateOpen(false);
      setCode(''); setMaxUses(1); setAssignedEmail(''); setNote('');
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Failed');
    },
  });

  const del = useMutation({
    mutationFn: (c: string) => api.deleteInviteCode(c),
    onSuccess: () => {
      toast.success('Code deleted');
      qc.invalidateQueries({ queryKey: ['invite-codes'] });
    },
  });

  const inviteWaitlist = useMutation({
    mutationFn: (id: string) => api.inviteWaitlistEntry(id, 1),
    onSuccess: () => {
      toast.success('Invite code issued');
      qc.invalidateQueries({ queryKey: ['waitlist'] });
      qc.invalidateQueries({ queryKey: ['invite-codes'] });
    },
  });

  const onDelete = async (c: string) => {
    const ok = await modal.confirm({
      title: `Delete invite code ${c}?`,
      description: 'Anyone trying to use this code will be rejected.',
      destructive: true,
    });
    if (ok) del.mutate(c);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Ticket className="h-5 w-5 text-primary" /> Invites & waitlist
          </h1>
          <p className="text-sm text-muted-foreground">
            Gate signups with codes. Turn on with <span className="font-mono">REQUIRE_INVITE_CODE_ON_SIGNUP=true</span>.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New code</Button>
      </div>

      <section>
        <h2 className="text-sm font-medium mb-2">Active codes</h2>
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium">Uses left</th>
                <th className="px-3 py-2 font-medium">Assigned to</th>
                <th className="px-3 py-2 font-medium">Note</th>
                <th className="px-3 py-2 font-medium">Created</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {codes.data?.rows.map((c) => (
                <tr key={c.code} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{c.code}</td>
                  <td className="px-3 py-2">
                    {c.maxUses === 0
                      ? <Badge variant="outline">Unlimited</Badge>
                      : `${c.usesRemaining} / ${c.maxUses}`}
                  </td>
                  <td className="px-3 py-2 text-xs">{c.assignedEmail ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{c.note ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(c.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => onDelete(c.code)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
              {codes.data?.rows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No codes.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <section>
        <h2 className="text-sm font-medium mb-2">Waitlist</h2>
        <Card className="overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Code</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {wait.data?.rows.map((w) => (
                <tr key={w.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{w.email}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(w.createdAt)}</td>
                  <td className="px-3 py-2">
                    {w.invitedAt
                      ? <Badge variant="secondary">Invited</Badge>
                      : <Badge variant="outline">Waiting</Badge>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{w.inviteCode?.code ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {!w.invitedAt && (
                      <Button
                        size="sm"
                        onClick={() => inviteWaitlist.mutate(w.id)}
                        disabled={inviteWaitlist.isPending}
                      >
                        <Send className="h-3 w-3" /> Invite
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {wait.data?.rows.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">Waitlist empty.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New invite code</DialogTitle>
            <DialogDescription>Leave the code blank to auto-generate.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="space-y-3">
            <div className="space-y-1.5">
              <Label>Code (optional)</Label>
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="BETA-12345" />
            </div>
            <div className="space-y-1.5">
              <Label>Max uses (0 = unlimited)</Label>
              <Input
                type="number"
                min={0}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(0, parseInt(e.target.value) || 0))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Assigned email (optional)</Label>
              <Input type="email" value={assignedEmail} onChange={(e) => setAssignedEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Note (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
