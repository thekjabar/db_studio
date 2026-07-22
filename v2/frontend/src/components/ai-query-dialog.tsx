import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, extractErrorMessage } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connectionId: string;
  schema?: string;
  onAccept: (sql: string) => void;
}

export function AiQueryDialog({ open, onOpenChange, connectionId, schema, onAccept }: Props) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ sql: string; explanation: string; tables: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPrompt("");
      setResult(null);
      setError(null);
    }
  }, [open]);

  const gen = useMutation({
    mutationFn: () => api.aiGenerateSql(connectionId, { prompt, schema }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
    },
    onError: (e) => setError(extractErrorMessage(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    gen.mutate();
  };

  const accept = () => {
    if (result?.sql) {
      onAccept(result.sql);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !gen.isPending && onOpenChange(v)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Ask AI to write SQL
          </DialogTitle>
          <DialogDescription>
            Describe what you want in plain language — the current schema is sent as context so the model
            can use your real table and column names.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Top 10 customers by revenue in the last 30 days"
            rows={3}
            disabled={gen.isPending}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={gen.isPending || !prompt.trim()}>
              {gen.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              Generate
            </Button>
          </div>
        </form>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2">
            {error}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
              {result.explanation}
              {result.tables.length > 0 && (
                <div className="mt-1 font-mono text-[10px]">
                  Tables used: {result.tables.join(", ")}
                </div>
              )}
            </div>
            <pre className="rounded-md border border-border bg-muted/60 px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-60">
              {result.sql}
            </pre>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={gen.isPending}>
            Cancel
          </Button>
          <Button onClick={accept} disabled={!result?.sql || gen.isPending}>
            Insert into editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
