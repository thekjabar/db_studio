import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { type OnMount } from "@monaco-editor/react";
import { toast } from "sonner";
import { Download, Loader2, Play, Save, Sparkles, Trash2 } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/data-grid";
import { api, extractErrorMessage, type QueryResult } from "@/lib/api";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

type HistoryEntry = { sql: string; when: number };
const HISTORY_LIMIT = 50;
const historyKey = (id: string) => `dbdash.sqlHistory.${id}`;

function loadHistory(id: string): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(historyKey(id));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.sql === "string" && typeof x.when === "number");
  } catch {
    return [];
  }
}

export default function SqlRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const modal = useModal();
  const isDark = useTheme((s) => s.theme === "dark");
  const [sql, setSql] = useState("SELECT 1 AS hello;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => (id ? loadHistory(id) : []));
  const [confirmSql, setConfirmSql] = useState<string | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Re-load history whenever the connection changes (navigating between connections).
  useEffect(() => {
    if (id) setHistory(loadHistory(id));
  }, [id]);

  const pushHistory = useCallback(
    (entry: HistoryEntry) => {
      if (!id) return;
      setHistory((h) => {
        // Dedupe the most recent same-SQL so consecutive runs don't spam.
        const deduped = h[0]?.sql === entry.sql ? h : [entry, ...h];
        const next = deduped.slice(0, HISTORY_LIMIT);
        try {
          localStorage.setItem(historyKey(id), JSON.stringify(next));
        } catch {
          // Storage full / disabled — silently fall back to in-memory only.
        }
        return next;
      });
    },
    [id],
  );

  const clearHistory = () => {
    if (!id) return;
    setHistory([]);
    try {
      localStorage.removeItem(historyKey(id));
    } catch {
      // ignore
    }
  };

  const savedQ = useQuery({
    queryKey: ["saved-queries", id],
    queryFn: () => api.listSavedQueries(id!),
    enabled: !!id,
  });

  const run = useMutation({
    mutationFn: async (body: { sql: string; confirmDestructive?: boolean }) =>
      api.runQuery(id!, body),
    onSuccess: (r) => {
      setResult(r);
      pushHistory({ sql, when: Date.now() });
      toast.success(`${r.rowCount ?? r.rows.length} rows · ${r.durationMs}ms`);
    },
    onError: (err: any) => {
      const data = err?.response?.data;
      if (data?.needsConfirm || data?.confirmRequired) {
        setConfirmSql(sql);
      } else {
        toast.error(extractErrorMessage(err));
      }
    },
  });

  const saveMut = useMutation({
    mutationFn: (body: { name: string; sql: string }) => api.createSavedQuery(id!, body),
    onSuccess: () => {
      toast.success("Query saved");
      qc.invalidateQueries({ queryKey: ["saved-queries", id] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const delSaved = useMutation({
    mutationFn: (qid: string) => api.deleteSavedQuery(id!, qid),
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["saved-queries", id] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  // Keep a ref to the current run-callback so the Monaco command (bound once
  // on mount) always sees the latest `sql` without needing to re-bind.
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => {
    if (!run.isPending && sql.trim()) run.mutate({ sql });
  };

  const formatRef = useRef<() => void>(() => {});
  formatRef.current = () => {
    if (!sql.trim()) return;
    try {
      const formatted = formatSql(sql, { language: "postgresql", keywordCase: "upper", tabWidth: 2 });
      setSql(formatted);
    } catch (err) {
      toast.error(`Format failed: ${(err as Error).message}`);
    }
  };

  // Fallback window-level handler for when Monaco isn't focused.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runRef.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const doSave = async () => {
    const name = await modal.prompt({
      title: "Save query",
      description: "Give this query a name so you can find it later.",
      placeholder: "e.g. Daily active users",
      validate: (v) => (v ? null : "Name is required"),
    });
    if (name) saveMut.mutate({ name, sql });
  };

  const exportCsv = () => {
    if (!result) return;
    const cols = result.fields.map((c) => c.name);
    const csv = [
      cols.join(","),
      ...result.rows.map((r) => cols.map((c) => {
        const v = r[c];
        if (v === null || v === undefined) return "";
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `query-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex">
      {/* Saved / history */}
      <aside className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-b border-border">
          Saved queries
        </div>
        <div className="flex-1 overflow-auto p-1">
          {savedQ.isLoading && <div className="p-2 text-xs text-muted-foreground">Loading...</div>}
          {savedQ.data?.length === 0 && (
            <div className="p-3 text-[11px] text-muted-foreground text-center">
              No saved queries. Click <span className="font-medium text-foreground">Save</span> to keep one.
            </div>
          )}
          {savedQ.data?.map((q) => (
            <div key={q.id} className="group flex items-center gap-1 px-2 py-1 rounded hover:bg-accent">
              <button onClick={() => setSql(q.sql)} className="flex-1 text-left text-xs truncate">
                {q.name}
              </button>
              <button
                onClick={async () => {
                  const ok = await modal.confirm({
                    title: `Delete "${q.name}"?`,
                    description: "This removes the saved query.",
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) delSaved.mutate(q.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
        <div className="px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-t border-b border-border flex items-center justify-between">
          <span>History</span>
          {history.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              className="text-[10px] normal-case text-muted-foreground/70 hover:text-destructive"
            >
              Clear
            </button>
          )}
        </div>
        <div className="flex-1 overflow-auto p-1">
          {history.length === 0 && <div className="p-2 text-xs text-muted-foreground">No history yet</div>}
          {history.map((h, i) => (
            <button
              key={i}
              onClick={() => setSql(h.sql)}
              className="block w-full text-left px-2 py-1 rounded hover:bg-accent text-xs font-mono truncate"
              title={h.sql}
            >
              {h.sql.split("\n")[0].slice(0, 30)}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          <Button size="sm" onClick={() => sql.trim() && run.mutate({ sql })} disabled={run.isPending || !sql.trim()}>
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
            <kbd className="ml-1 rounded border border-border bg-background/30 px-1 text-[10px]">Ctrl ↵</kbd>
          </Button>
          <Button size="sm" variant="outline" onClick={doSave}>
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
          <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!result}>
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          {result && (
            <span className="ml-auto text-xs text-muted-foreground font-mono">
              {result.rowCount ?? result.rows.length} rows · {result.durationMs}ms
            </span>
          )}
        </div>

        <div className="h-2/5 min-h-45 border-b border-border">
          <Editor
            height="100%"
            defaultLanguage="sql"
            theme={isDark ? "vs-dark" : "vs"}
            value={sql}
            onChange={(v) => setSql(v ?? "")}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              editor.addCommand(
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
                () => runRef.current(),
              );
              // Shift+Alt+F = format, matching VS Code.
              editor.addCommand(
                monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
                () => formatRef.current(),
              );
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "JetBrains Mono, monospace",
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        </div>

        <div className="flex-1 min-h-0">
          {result ? (
            <DataGrid
              columns={result.fields.map((c) => ({ name: c.name, type: c.dataType }))}
              rows={result.rows}
              emptyMessage="Query returned no rows"
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Run a query to see results.
            </div>
          )}
        </div>
      </div>

      <Dialog open={!!confirmSql} onOpenChange={(v) => !v && setConfirmSql(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Destructive query detected</DialogTitle>
            <DialogDescription>
              This query modifies data without a WHERE clause. Confirm to run.
            </DialogDescription>
          </DialogHeader>
          <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-auto max-h-40">{confirmSql}</pre>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmSql(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmSql) run.mutate({ sql: confirmSql, confirmDestructive: true });
                setConfirmSql(null);
              }}
            >
              Run anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
