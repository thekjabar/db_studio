import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MessageSquare, Send, Copy, Loader2 } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const STATUSES = ['NEW', 'TRIAGED', 'ANSWERED', 'CLOSED'] as const;

export default function Feedback() {
  const [status, setStatus] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['feedback', status],
    queryFn: () => api.listFeedback(status === 'all' ? undefined : status, 100, 0),
    refetchInterval: 15_000,
  });
  const current = q.data?.rows.find((r) => r.id === selected) ?? null;

  const setStatusMut = useMutation({
    mutationFn: (vars: { id: string; status: string }) => api.setFeedbackStatus(vars.id, vars.status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feedback'] }),
  });

  const saveNote = useMutation({
    mutationFn: (vars: { id: string; note: string }) => api.setFeedbackNote(vars.id, vars.note),
    onSuccess: () => {
      toast.success('Note saved');
      qc.invalidateQueries({ queryKey: ['feedback'] });
    },
  });

  const sendReply = useMutation({
    mutationFn: (vars: { id: string; body: string }) => api.replyFeedback(vars.id, vars.body),
    onSuccess: (r) => {
      if (r.sent) toast.success('Reply sent by email');
      else if (r.copyToManualEmail) toast.warning('SMTP not configured — copy the reply and send it manually.');
      else toast.error(r.error ?? 'Reply failed');
      setReply('');
      qc.invalidateQueries({ queryKey: ['feedback'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Reply failed');
    },
  });

  const pickFeedback = (id: string) => {
    setSelected(id);
    const row = q.data?.rows.find((r) => r.id === id);
    setNote(row?.internalNotes ?? '');
    setReply('');
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-primary" /> Feedback
            {q.data?.unread ? (
              <Badge variant="destructive" className="ml-2">{q.data.unread} unread</Badge>
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground">Customer messages from the in-app widget.</p>
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setSelected(null); }}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 min-h-0">
        <Card className="overflow-auto p-0 lg:col-span-1">
          {q.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : q.data?.rows.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No feedback.</div>
          ) : (
            <ul className="divide-y divide-border">
              {q.data?.rows.map((r) => (
                <li
                  key={r.id}
                  onClick={() => pickFeedback(r.id)}
                  className={cn(
                    'p-3 cursor-pointer hover:bg-muted/50',
                    selected === r.id && 'bg-muted',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono truncate text-primary">
                      {r.user?.email ?? r.email ?? '(anonymous)'}
                    </span>
                    <Badge
                      variant={r.status === 'NEW' ? 'destructive' : r.status === 'ANSWERED' ? 'secondary' : 'outline'}
                      className="text-[10px]"
                    >
                      {r.status}
                    </Badge>
                  </div>
                  <p className="text-sm mt-1 line-clamp-2">{r.message}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-[10px]">{r.category}</Badge>
                    <span className="text-[10px] text-muted-foreground">{relativeDate(r.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4 lg:col-span-2 overflow-auto">
          {!current ? (
            <div className="text-sm text-muted-foreground">Select a feedback item to view.</div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-xs text-muted-foreground">From</div>
                  <div className="font-mono text-sm">{current.user?.email ?? current.email ?? '(anonymous)'}</div>
                  {current.sourcePath && (
                    <div className="text-[11px] text-muted-foreground">
                      From URL <span className="font-mono">{current.sourcePath}</span>
                    </div>
                  )}
                </div>
                <Select
                  value={current.status}
                  onValueChange={(v) => setStatusMut.mutate({ id: current.id, status: v })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <Card className="p-3 bg-muted/30">
                <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">Message</div>
                <div className="text-sm whitespace-pre-wrap">{current.message}</div>
              </Card>

              <div className="space-y-1.5">
                <div className="text-xs font-medium">Internal notes (operator-only)</div>
                <Textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Context, triage decisions, links…"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => saveNote.mutate({ id: current.id, note })}
                    disabled={saveNote.isPending || note === (current.internalNotes ?? '')}
                  >
                    Save note
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium">Reply</div>
                <Textarea
                  rows={5}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder={`Hi ${current.user?.displayName ?? 'there'},\n\nThanks for the feedback…`}
                />
                <div className="flex justify-between items-center">
                  <span className="text-[11px] text-muted-foreground">
                    Goes to {current.user?.email ?? current.email ?? '—'}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(reply);
                        toast.success('Copied');
                      }}
                      disabled={!reply.trim()}
                    >
                      <Copy className="h-3 w-3" /> Copy
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => sendReply.mutate({ id: current.id, body: reply })}
                      disabled={sendReply.isPending || !reply.trim()}
                    >
                      <Send className="h-3 w-3" /> Send reply
                    </Button>
                  </div>
                </div>
                {current.replyText && (
                  <Card className="p-3 mt-3">
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1">
                      Last reply · {current.repliedAt && relativeDate(current.repliedAt)}
                    </div>
                    <div className="text-sm whitespace-pre-wrap">{current.replyText}</div>
                  </Card>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
