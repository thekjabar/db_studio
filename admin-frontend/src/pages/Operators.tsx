import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Ban, CheckCircle2 } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useModal } from '@/components/modal-provider';

export default function Operators() {
  const qc = useQueryClient();
  const modal = useModal();
  const q = useQuery({ queryKey: ['operators'], queryFn: () => api.listOperators() });
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const [createOpen, setCreateOpen] = useState(false);

  const toggle = useMutation({
    mutationFn: (vars: { id: string; disable: boolean }) =>
      vars.disable ? api.disableOperator(vars.id) : api.enableOperator(vars.id),
    onSuccess: () => {
      toast.success('Operator updated');
      qc.invalidateQueries({ queryKey: ['operators'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Failed');
    },
  });

  const onToggle = async (id: string, email: string, currentlyDisabled: boolean) => {
    const ok = await modal.confirm({
      title: currentlyDisabled ? 'Enable operator?' : 'Disable operator?',
      description: currentlyDisabled
        ? `${email} will be able to sign in again.`
        : `${email} will be signed out immediately and blocked from signing back in.`,
      confirmLabel: currentlyDisabled ? 'Enable' : 'Disable',
      destructive: !currentlyDisabled,
    });
    if (ok) toggle.mutate({ id, disable: !currentlyDisabled });
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Operators</h1>
          <p className="text-sm text-muted-foreground">
            Administrators of this console. Separate identity from customer users.
          </p>
        </div>
        {me.data?.isSuper && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New operator
          </Button>
        )}
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Email</th>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Role</th>
              <th className="px-3 py-2 font-medium">Last login</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((op) => {
              const disabled = !!(op as unknown as { disabledAt: string | null }).disabledAt;
              const self = me.data?.id === op.id;
              return (
                <tr key={op.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">
                    {op.email}
                    {self && <span className="ml-2 text-[10px] text-muted-foreground">(you)</span>}
                  </td>
                  <td className="px-3 py-2">{op.displayName ?? '—'}</td>
                  <td className="px-3 py-2">
                    {op.isSuper ? (
                      <Badge variant="outline" className="text-amber-500 border-amber-500/30">Super</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Operator</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(op.lastLoginAt)}</td>
                  <td className="px-3 py-2">
                    {disabled ? (
                      <Badge variant="destructive">Disabled</Badge>
                    ) : (
                      <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Active</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {me.data?.isSuper && !self && (
                      <Button size="sm" variant="outline" onClick={() => onToggle(op.id, op.email, disabled)}>
                        {disabled ? <><CheckCircle2 className="h-3 w-3" /> Enable</> : <><Ban className="h-3 w-3" /> Disable</>}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <CreateOperatorDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          qc.invalidateQueries({ queryKey: ['operators'] });
          setCreateOpen(false);
        }}
      />
    </div>
  );
}

function CreateOperatorDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isSuper, setIsSuper] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createOperator({
      email,
      password,
      displayName: displayName || undefined,
      isSuper,
    }),
    onSuccess: () => {
      toast.success('Operator created');
      setEmail(''); setPassword(''); setDisplayName(''); setIsSuper(false);
      onCreated();
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Create failed');
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create operator</DialogTitle>
          <DialogDescription>
            A new console administrator. Super operators can manage pricing and other operators.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="op-email">Email</Label>
            <Input
              id="op-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="op-name">Display name (optional)</Label>
            <Input
              id="op-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="op-pw">Password</Label>
            <Input
              id="op-pw"
              type="password"
              required
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">Minimum 12 characters.</p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={isSuper}
              onCheckedChange={(v) => setIsSuper(v === true)}
            />
            <span>Super operator (can manage pricing and other operators)</span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
