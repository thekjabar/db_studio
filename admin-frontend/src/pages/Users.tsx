import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, Loader2, Search, X } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected' | 'suspended';

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'pending', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'all', label: 'All users' },
];

export default function Users() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['users', q, status, offset],
    queryFn: () =>
      api.listUsers(q || undefined, status === 'all' ? undefined : status, limit, offset),
    placeholderData: (p) => p,
  });

  // Inline reject dialog state — operators need to type a reason that the
  // user will see on their next login attempt.
  const [rejectTarget, setRejectTarget] = useState<{ id: string; email: string } | null>(null);

  const approve = useMutation({
    mutationFn: (id: string) => api.approveUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Approve new signups, suspend abusers, browse account metadata. Operators never see
          connection configs, SQL, or customer data.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            size="sm"
            variant={status === opt.value ? 'default' : 'outline'}
            onClick={() => {
              setStatus(opt.value);
              setOffset(0);
            }}
          >
            {opt.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder="Search email or name"
            className="pl-9"
          />
        </div>
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
              <th className="px-3 py-2 font-medium text-right">Actions</th>
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
                    <Badge variant="outline" className="ml-2 text-amber-500 border-amber-500/30">
                      admin
                    </Badge>
                  )}
                </td>
                <td className="px-3 py-2">{u.displayName ?? '—'}</td>
                <td className="px-3 py-2">
                  <StatusBadge user={u} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {u.workspacesOwned + u.workspacesJoined}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{u.connections}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {relativeDate(u.createdAt)}
                </td>
                <td className="px-3 py-2 text-right">
                  {u.approvalStatus === 'pending' && (
                    <div className="flex gap-1.5 justify-end">
                      <Button
                        size="sm"
                        variant="default"
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(u.id)}
                      >
                        {approve.isPending && approve.variables === u.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRejectTarget({ id: u.id, email: u.email })}
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {query.data?.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
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
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + limit >= query.data.total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      <RejectDialog
        target={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onDone={() => qc.invalidateQueries({ queryKey: ['users'] })}
      />
    </div>
  );
}

function StatusBadge({
  user,
}: {
  user: {
    suspendedAt: string | null;
    approvalStatus: 'pending' | 'approved' | 'rejected';
    emailVerified: boolean;
  };
}) {
  if (user.suspendedAt) return <Badge variant="destructive">Suspended</Badge>;
  if (user.approvalStatus === 'pending')
    return (
      <Badge variant="outline" className="text-amber-500 border-amber-500/40">
        Pending review
      </Badge>
    );
  if (user.approvalStatus === 'rejected') return <Badge variant="destructive">Rejected</Badge>;
  if (!user.emailVerified)
    return (
      <Badge variant="outline" className="text-muted-foreground border-muted-foreground/40">
        Unverified
      </Badge>
    );
  return (
    <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">
      Active
    </Badge>
  );
}

function RejectDialog({
  target,
  onClose,
  onDone,
}: {
  target: { id: string; email: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const reject = useMutation({
    mutationFn: (id: string) => api.rejectUser(id, reason),
    onSuccess: () => {
      onDone();
      onClose();
      setReason('');
    },
  });
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setReason('');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject account</DialogTitle>
          <DialogDescription>
            {target?.email} will see this reason when they try to sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-reason">Reason</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. We don't accept signups from disposable email addresses."
            rows={3}
            autoFocus
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!reason.trim() || reject.isPending}
            onClick={() => target && reject.mutate(target.id)}
          >
            {reject.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Reject account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
