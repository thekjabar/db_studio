import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Save } from 'lucide-react';
import { api, relativeDate } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export default function EmailTemplates() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['templates'], queryFn: () => api.listEmailTemplates() });
  const [selected, setSelected] = useState<string | null>(null);
  const current = useMemo(() => q.data?.find((t) => t.name === selected) ?? null, [q.data, selected]);

  const [subject, setSubject] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');
  const [bodyText, setBodyText] = useState('');

  useEffect(() => {
    if (current) {
      setSubject(current.subject);
      setBodyHtml(current.bodyHtml);
      setBodyText(current.bodyText);
    }
  }, [current]);

  useEffect(() => {
    if (!selected && q.data?.[0]) setSelected(q.data[0].name);
  }, [q.data, selected]);

  const save = useMutation({
    mutationFn: () => {
      if (!current) return Promise.reject(new Error('no template'));
      return api.updateEmailTemplate(current.name, { subject, bodyHtml, bodyText });
    },
    onSuccess: () => {
      toast.success('Template saved');
      qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Save failed');
    },
  });

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Mail className="h-5 w-5 text-primary" /> Email templates
        </h1>
        <p className="text-sm text-muted-foreground">
          Transactional emails. Use <span className="font-mono">{'{{variable}}'}</span> placeholders from the list.
        </p>
      </div>
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-4 gap-4 min-h-0">
        <Card className="p-0 overflow-auto lg:col-span-1">
          <ul className="divide-y divide-border">
            {q.data?.map((t) => (
              <li
                key={t.name}
                onClick={() => setSelected(t.name)}
                className={cn('p-3 cursor-pointer hover:bg-muted/50', selected === t.name && 'bg-muted')}
              >
                <div className="font-mono text-sm">{t.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">{t.subject}</div>
                <div className="text-[10px] text-muted-foreground mt-1">Updated {relativeDate(t.updatedAt)}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-4 lg:col-span-3 overflow-auto">
          {!current ? (
            <div className="text-sm text-muted-foreground">Pick a template.</div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Plain-text body</Label>
                <Textarea rows={6} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>HTML body</Label>
                <Textarea rows={10} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Variables</Label>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {current.variables.map((v) => (
                    <button
                      key={v}
                      onClick={() => navigator.clipboard.writeText(`{{${v}}}`)}
                      className="font-mono px-2 py-1 rounded bg-muted hover:bg-accent border border-border"
                      title="Copy placeholder"
                    >
                      {'{{' + v + '}}'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  <Save className="h-4 w-4" /> Save template
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
