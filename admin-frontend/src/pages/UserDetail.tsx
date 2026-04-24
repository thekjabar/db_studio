import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Ban, CheckCircle2, Trash2 } from 'lucide-react';
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
