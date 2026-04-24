import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Pencil, DollarSign } from 'lucide-react';
import { api, money, relativeDate } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

const STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;
type Status = typeof STATUSES[number];

interface OverrideTarget {
  id: string;
  name: string;
  slug: string;
  currentStatus: Status | null;
  currentPacks: number;
}

export default function Workspaces() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [offset, setOffset] = useState(0);
  const [target, setTarget] = useState<OverrideTarget | null>(null);
  const [creditTarget, setCreditTarget] = useState<{ id: string; name: string } | null>(null);
  const limit = 50;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['workspaces', q, status, offset],
    queryFn: () => api.listWorkspaces(q || undefined, status === 'all' ? undefined : status, limit, offset),
    placeholderData: (p) => p,
  });

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          Each workspace is one billing customer. The owner is billed for every seat (member).
        </p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={(e) => { setQ(e.target.value); setOffset(0); }}
            placeholder="Search name, slug, or owner email"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setOffset(0); }}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Workspace</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium text-right">Seats</th>
              <th className="px-3 py-2 font-medium text-right">Monthly</th>
              <th className="px-3 py-2 font-medium">Subscription</th>
              <th className="px-3 py-2 font-medium">Ends</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.rows.map((w) => (
              <tr key={w.id} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-medium">{w.name}</div>
                  <div className="text-xs font-mono text-muted-foreground">{w.slug}</div>
                </td>
                <td className="px-3 py-2 font-mono text-xs">{w.owner.email}</td>
                <td className="px-3 py-2 text-right tabular-nums">{w.seats}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(w.monthlyCents)}</td>
                <td className="px-3 py-2">
                  {w.subscription ? (
                    <Badge variant="secondary">{w.subscription.status}</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">None</span>
                  )}
                  {w.subscription?.aiTopUpPacks ? (
                    <span className="ml-2 text-[10px] text-muted-foreground">
                      +{w.subscription.aiTopUpPacks} AI pack{w.subscription.aiTopUpPacks === 1 ? '' : 's'}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {w.subscription ? relativeDate(w.subscription.periodEnd) : '—'}
                </td>
                <td className="px-3 py-2 text-right space-x-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCreditTarget({ id: w.id, name: w.name })}
                  >
                    <DollarSign className="h-3 w-3" /> Credit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setTarget({
                        id: w.id,
                        name: w.name,
                        slug: w.slug,
                        currentStatus: (w.subscription?.status as Status) ?? null,
                        currentPacks: w.subscription?.aiTopUpPacks ?? 0,
                      })
                    }
                  >
                    <Pencil className="h-3 w-3" /> Override
                  </Button>
                </td>
              </tr>
            ))}
            {query.data?.rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  No workspaces match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {query.data && query.data.total > limit && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div>{offset + 1}–{Math.min(offset + limit, query.data.total)} of {query.data.total}</div>
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

      <OverrideDialog
        target={target}
        onClose={() => setTarget(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['workspaces'] });
          setTarget(null);
        }}
      />

      <CreditDialog
        target={creditTarget}
        onClose={() => setCreditTarget(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['workspaces'] });
          setCreditTarget(null);
        }}
      />
    </div>
  );
}

function CreditDialog({
  target,
  onClose,
  onSaved,
}: {
  target: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [dollars, setDollars] = useState(5);
  const [reason, setReason] = useState('');
  useStateSync(target, () => { setDollars(5); setReason(''); });

  const save = useMutation({
    mutationFn: () => {
      if (!target) return Promise.reject(new Error('no target'));
      return api.issueAdjustment(target.id, {
        amountCents: -Math.round(dollars * 100),
        reason,
      });
    },
    onSuccess: () => {
      toast.success('Credit issued');
      onSaved();
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Failed');
    },
  });

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle>Issue credit</DialogTitle>
              <DialogDescription>{target.name}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Amount (USD)</Label>
                <Input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={dollars}
                  onChange={(e) => setDollars(Math.max(0.01, parseFloat(e.target.value) || 0))}
                />
                <p className="text-[11px] text-muted-foreground">
                  Subtracted from the next invoice. Recorded as a negative adjustment.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Reason</Label>
                <Textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Goodwill credit for outage on 2026-04-22"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending || !reason.trim() || dollars <= 0}>
                Issue ${dollars.toFixed(2)} credit
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OverrideDialog({
  target,
  onClose,
  onSaved,
}: {
  target: OverrideTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<Status>(target?.currentStatus ?? 'ACTIVE');
  const [packs, setPacks] = useState(target?.currentPacks ?? 0);
  const [note, setNote] = useState('');

  // Reset local state when a new target opens the dialog.
  useStateSync(target, () => {
    setStatus(target?.currentStatus ?? 'ACTIVE');
    setPacks(target?.currentPacks ?? 0);
    setNote('');
  });

  const save = useMutation({
    mutationFn: () => {
      if (!target) return Promise.reject(new Error('No target'));
      return api.overrideSubscription(target.id, {
        status,
        aiTopUpPacks: packs,
        note: note.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Subscription updated');
      onSaved();
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Update failed');
    },
  });

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        {target && (
          <>
            <DialogHeader>
              <DialogTitle>Override subscription</DialogTitle>
              <DialogDescription>
                {target.name} <span className="font-mono text-xs">({target.slug})</span>
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={(v: Status) => setStatus(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>AI top-up packs</Label>
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={packs}
                  onChange={(e) => setPacks(Math.max(0, parseInt(e.target.value) || 0))}
                />
                <p className="text-[11px] text-muted-foreground">
                  Each pack grants extra daily AI calls to every user in the workspace for one month.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Reason / note</Label>
                <Textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Comped 30 days during onboarding"
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                Save changes
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Tiny helper: re-run `effect` whenever the `value` reference changes.
function useStateSync<T>(value: T, effect: () => void) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, [value]);
}
