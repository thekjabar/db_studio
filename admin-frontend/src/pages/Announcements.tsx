import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Megaphone, Plus, Pencil, Trash2 } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useModal } from '@/components/modal-provider';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

interface Editing {
  id: string | null;
  title: string;
  body: string;
  severity: Severity;
  startsAt: string;
  endsAt: string;
  workspaceIdsText: string;
  userIdsText: string;
}

const emptyDraft: Editing = {
  id: null, title: '', body: '', severity: 'INFO',
  startsAt: '', endsAt: '', workspaceIdsText: '', userIdsText: '',
};

export default function Announcements() {
  const qc = useQueryClient();
  const modal = useModal();
  const q = useQuery({ queryKey: ['announcements'], queryFn: () => api.listAnnouncements(100, 0) });
  const [draft, setDraft] = useState<Editing | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (!draft) return;
      const targeting = {
        workspaceIds: draft.workspaceIdsText.split(',').map((s) => s.trim()).filter(Boolean),
        userIds: draft.userIdsText.split(',').map((s) => s.trim()).filter(Boolean),
      };
      const hasTargeting = targeting.workspaceIds.length > 0 || targeting.userIds.length > 0;
      const body = {
        title: draft.title,
        body: draft.body,
        severity: draft.severity,
        targeting: hasTargeting ? targeting : undefined,
        startsAt: draft.startsAt || undefined,
        endsAt: draft.endsAt || undefined,
      };
      if (draft.id) return api.updateAnnouncement(draft.id, body);
      return api.createAnnouncement(body);
    },
    onSuccess: () => {
      toast.success('Announcement saved');
      qc.invalidateQueries({ queryKey: ['announcements'] });
      setDraft(null);
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Save failed');
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteAnnouncement(id),
    onSuccess: () => {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['announcements'] });
    },
  });

  const startNew = () => setDraft(emptyDraft);
  const startEdit = (a: NonNullable<typeof q.data>['rows'][number]) => {
    setDraft({
      id: a.id,
      title: a.title,
      body: a.body,
      severity: a.severity,
      startsAt: a.startsAt.slice(0, 16),
      endsAt: a.endsAt ? a.endsAt.slice(0, 16) : '',
      workspaceIdsText: a.targeting?.workspaceIds?.join(', ') ?? '',
      userIdsText: a.targeting?.userIds?.join(', ') ?? '',
    });
  };

  const onDelete = async (id: string, title: string) => {
    const ok = await modal.confirm({
      title: 'Delete announcement?',
      description: `"${title}" will be removed for everyone immediately.`,
      destructive: true,
    });
    if (ok) del.mutate(id);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Megaphone className="h-5 w-5 text-primary" /> Announcements
          </h1>
          <p className="text-sm text-muted-foreground">
            In-app banners for customers. Targets entire userbase by default.
          </p>
        </div>
        <Button onClick={startNew}><Plus className="h-4 w-4" /> New announcement</Button>
      </div>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Severity</th>
              <th className="px-3 py-2 font-medium">Starts</th>
              <th className="px-3 py-2 font-medium">Ends</th>
              <th className="px-3 py-2 font-medium">Targeting</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.rows.map((a) => {
              const targeted = a.targeting
                && ((a.targeting.userIds?.length ?? 0) + (a.targeting.workspaceIds?.length ?? 0)) > 0;
              return (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-3 py-2 font-medium">{a.title}</td>
                  <td className="px-3 py-2">
                    <Badge variant={a.severity === 'CRITICAL' ? 'destructive' : 'outline'}>
                      {a.severity}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{relativeDate(a.startsAt)}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{a.endsAt ? relativeDate(a.endsAt) : 'forever'}</td>
                  <td className="px-3 py-2 text-xs">
                    {targeted
                      ? `${(a.targeting?.userIds?.length ?? 0) + (a.targeting?.workspaceIds?.length ?? 0)} target(s)`
                      : 'Everyone'}
                  </td>
                  <td className="px-3 py-2 text-right space-x-1">
                    <Button size="sm" variant="outline" onClick={() => startEdit(a)}>
                      <Pencil className="h-3 w-3" /> Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onDelete(a.id, a.title)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {q.data?.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                  No announcements yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="max-w-lg">
          {draft && (
            <>
              <DialogHeader>
                <DialogTitle>{draft.id ? 'Edit announcement' : 'New announcement'}</DialogTitle>
                <DialogDescription>
                  Appears as a dismissible banner in the customer app.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Title</Label>
                  <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Body</Label>
                  <Textarea
                    rows={4}
                    value={draft.body}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                    placeholder="Supports plain text and simple markdown."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Severity</Label>
                    <Select
                      value={draft.severity}
                      onValueChange={(v: Severity) => setDraft({ ...draft, severity: v })}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="INFO">INFO</SelectItem>
                        <SelectItem value="WARNING">WARNING</SelectItem>
                        <SelectItem value="CRITICAL">CRITICAL</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Starts</Label>
                    <Input
                      type="datetime-local"
                      value={draft.startsAt}
                      onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Ends (optional)</Label>
                  <Input
                    type="datetime-local"
                    value={draft.endsAt}
                    onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Targeting (optional)</Label>
                  <Input
                    placeholder="Workspace IDs, comma-separated"
                    value={draft.workspaceIdsText}
                    onChange={(e) => setDraft({ ...draft, workspaceIdsText: e.target.value })}
                  />
                  <Input
                    placeholder="User IDs, comma-separated"
                    value={draft.userIdsText}
                    onChange={(e) => setDraft({ ...draft, userIdsText: e.target.value })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Leave both blank to target everyone.
                  </p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending || !draft.title.trim() || !draft.body.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
