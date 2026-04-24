import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Flag, Plus, Trash2, Pencil } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useModal } from '@/components/modal-provider';

interface Draft {
  key: string;
  description: string;
  rolloutPercent: number;
  enabledUsers: string;
  enabledWorkspaces: string;
  disabledUsers: string;
  disabledWorkspaces: string;
  isNew: boolean;
}

const empty: Draft = {
  key: '', description: '', rolloutPercent: 0,
  enabledUsers: '', enabledWorkspaces: '', disabledUsers: '', disabledWorkspaces: '',
  isNew: true,
};

export default function Flags() {
  const qc = useQueryClient();
  const modal = useModal();
  const q = useQuery({ queryKey: ['flags'], queryFn: () => api.listFlags() });
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (!draft) return Promise.reject(new Error('no draft'));
      const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
      return api.upsertFlag({
        key: draft.key,
        description: draft.description || undefined,
        rolloutPercent: draft.rolloutPercent,
        enabledUserIds: split(draft.enabledUsers),
        enabledWorkspaceIds: split(draft.enabledWorkspaces),
        disabledUserIds: split(draft.disabledUsers),
        disabledWorkspaceIds: split(draft.disabledWorkspaces),
      });
    },
    onSuccess: () => {
      toast.success('Flag saved');
      qc.invalidateQueries({ queryKey: ['flags'] });
      setDraft(null);
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Save failed');
    },
  });

  const del = useMutation({
    mutationFn: (key: string) => api.deleteFlag(key),
    onSuccess: () => {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['flags'] });
    },
  });

  const onDelete = async (key: string) => {
    const ok = await modal.confirm({
      title: `Delete flag "${key}"?`,
      description: 'Any code referencing this flag will return false.',
      destructive: true,
    });
    if (ok) del.mutate(key);
  };

  const startEdit = (f: NonNullable<typeof q.data>[number]) => {
    setDraft({
      key: f.key,
      description: f.description ?? '',
      rolloutPercent: f.rolloutPercent,
      enabledUsers: f.enabledUserIds.join(', '),
      enabledWorkspaces: f.enabledWorkspaceIds.join(', '),
      disabledUsers: f.disabledUserIds.join(', '),
      disabledWorkspaces: f.disabledWorkspaceIds.join(', '),
      isNew: false,
    });
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Flag className="h-5 w-5 text-primary" /> Feature flags
          </h1>
          <p className="text-sm text-muted-foreground">
            Gradual rollouts with percent bucketing + per-user/workspace overrides.
          </p>
        </div>
        <Button onClick={() => setDraft(empty)}><Plus className="h-4 w-4" /> New flag</Button>
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium text-right">Rollout</th>
              <th className="px-3 py-2 font-medium">Overrides</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium text-right"></th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((f) => {
              const overrides = f.enabledUserIds.length + f.enabledWorkspaceIds.length
                + f.disabledUserIds.length + f.disabledWorkspaceIds.length;
              return (
                <tr key={f.key} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{f.key}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-md">
                    {f.description ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{f.rolloutPercent}%</td>
                  <td className="px-3 py-2 text-xs">{overrides}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(f.updatedAt)}</td>
                  <td className="px-3 py-2 text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => startEdit(f)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onDelete(f.key)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {q.data?.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">No flags.</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-lg">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>{draft.isNew ? 'New flag' : `Edit ${draft.key}`}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Key</Label>
                  <Input
                    value={draft.key}
                    onChange={(e) => setDraft({ ...draft, key: e.target.value })}
                    disabled={!draft.isNew}
                    placeholder="new_editor_ui"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Description</Label>
                  <Textarea
                    rows={2}
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Rollout percent: {draft.rolloutPercent}%</Label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.rolloutPercent}
                    onChange={(e) => setDraft({ ...draft, rolloutPercent: parseInt(e.target.value, 10) })}
                    className="w-full"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Force-on user IDs</Label>
                    <Textarea rows={2} value={draft.enabledUsers}
                      onChange={(e) => setDraft({ ...draft, enabledUsers: e.target.value })}
                      placeholder="comma-separated" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Force-on workspace IDs</Label>
                    <Textarea rows={2} value={draft.enabledWorkspaces}
                      onChange={(e) => setDraft({ ...draft, enabledWorkspaces: e.target.value })}
                      placeholder="comma-separated" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Force-off user IDs</Label>
                    <Textarea rows={2} value={draft.disabledUsers}
                      onChange={(e) => setDraft({ ...draft, disabledUsers: e.target.value })}
                      placeholder="comma-separated" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Force-off workspace IDs</Label>
                    <Textarea rows={2} value={draft.disabledWorkspaces}
                      onChange={(e) => setDraft({ ...draft, disabledWorkspaces: e.target.value })}
                      placeholder="comma-separated" />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending || !draft.key}>Save</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
