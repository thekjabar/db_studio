import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { type OnMount } from "@monaco-editor/react";
import { toast } from "sonner";
import { BarChart3, Download, Loader2, Play, Save, Send, Share2, Sparkles, Trash2 } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid } from "@/components/data-grid";
import { ExplainPanel } from "@/components/explain-panel";
import { api, extractErrorMessage, type ExplainResult, type QueryResult } from "@/lib/api";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { AiQueryDialog } from "@/components/ai-query-dialog";
import { SendResultDialog } from "@/components/send-result-dialog";
import { useOutletContext } from "react-router-dom";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [sql, setSql] = useState(() => {
    const urlSql = searchParams.get("sql");
    return urlSql ?? "SELECT 1 AS hello;";
  });

  // Push SQL to URL so it's shareable — debounced so every keystroke isn't a history event.
  // Skip anything over ~1.5KB to keep URLs reasonable (long queries should be Saved instead).
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (sql && sql !== "SELECT 1 AS hello;" && sql.length < 1500) next.set("sql", sql);
      else next.delete("sql");
      setSearchParams(next, { replace: true });
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [explainResult, setExplainResult] = useState<ExplainResult | null>(null);
  const [resultTab, setResultTab] = useState<"data" | "plan">("data");
  // Row-cap for SELECT queries. 0 means "no cap" and triggers a warning before
  // running — raw SELECT * FROM big_table is a common way to freeze the app.
  const [maxRows, setMaxRows] = useState<number>(() => {
    const stored = localStorage.getItem("dbdash.sqlMaxRows");
    const n = stored ? parseInt(stored, 10) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  });
  useEffect(() => {
    localStorage.setItem("dbdash.sqlMaxRows", String(maxRows));
  }, [maxRows]);
  const [history, setHistory] = useState<HistoryEntry[]>(() => (id ? loadHistory(id) : []));
  const [confirmSql, setConfirmSql] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const ctx = useOutletContext<{ schema?: string } | null>();
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
      api.runQuery(id!, { ...body, maxRows }),
    onSuccess: (r) => {
      setResult(r);
      setResultTab("data");
      pushHistory({ sql, when: Date.now() });
      if (r.truncated) {
        toast.warning(
          `Showed first ${r.rowCount} rows — result is larger. Add LIMIT to your query or raise the cap.`,
        );
      } else {
        toast.success(`${r.rowCount ?? r.rows.length} rows · ${r.durationMs}ms`);
      }
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

  const explainMut = useMutation({
    mutationFn: (body: { sql: string; mode: "plan" | "analyze" }) =>
      api.explain(id!, body),
    onSuccess: (r) => {
      setExplainResult(r);
      setResultTab("plan");
      toast.success(
        r.mode === "analyze"
          ? `Plan + execution analysis (${r.warnings.length} warnings)`
          : `Plan analysis (${r.warnings.length} warnings)`,
      );
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const saveMut = useMutation({
    mutationFn: (body: { name: string; sqlText: string }) => api.createSavedQuery(id!, body),
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
    if (name) saveMut.mutate({ name, sqlText: sql });
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
              <button onClick={() => setSql(q.sqlText)} className="flex-1 text-left text-xs truncate">
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
          <Button
            size="sm"
            onClick={async () => {
              if (!sql.trim()) return;
              if (maxRows === 0) {
                const ok = await modal.confirm({
                  title: "Run without a row cap?",
                  description:
                    "Unbounded SELECT on a large table can freeze the browser and stress the database. Continue?",
                  confirmLabel: "Run anyway",
                  destructive: true,
                });
                if (!ok) return;
              }
              run.mutate({ sql });
            }}
            disabled={run.isPending || !sql.trim()}
          >
            {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Run
            <kbd className="ml-1 rounded border border-border bg-background/30 px-1 text-[10px]">Ctrl ↵</kbd>
          </Button>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Limit</span>
            <Select
              value={String(maxRows)}
              onValueChange={(v) => setMaxRows(parseInt(v, 10))}
            >
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="100">100</SelectItem>
                <SelectItem value="500">500</SelectItem>
                <SelectItem value="1000">1,000</SelectItem>
                <SelectItem value="5000">5,000</SelectItem>
                <SelectItem value="10000">10,000</SelectItem>
                <SelectItem value="0">No cap</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" variant="outline" onClick={() => setAiOpen(true)}>
            <Sparkles className="h-3.5 w-3.5" /> Ask AI
          </Button>
          <Button size="sm" variant="outline" onClick={() => formatRef.current()}>
            Format
            <kbd className="ml-1 rounded border border-border bg-background/30 px-1 text-[10px]">Shift ⌥ F</kbd>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => sql.trim() && explainMut.mutate({ sql, mode: "plan" })}
            disabled={explainMut.isPending || !sql.trim()}
            title="Show plan without running"
          >
            {explainMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
            Explain
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const ok = await modal.confirm({
                title: "Run EXPLAIN ANALYZE?",
                description:
                  "This actually executes the query to measure real timings. SELECT is safe; DML runs inside a BEGIN/ROLLBACK so nothing persists.",
                confirmLabel: "Run analyze",
              });
              if (ok) explainMut.mutate({ sql, mode: "analyze" });
            }}
            disabled={explainMut.isPending || !sql.trim()}
            title="Run EXPLAIN ANALYZE (executes the query)"
          >
            Analyze
          </Button>
          <Button size="sm" variant="outline" onClick={doSave}>
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              navigator.clipboard.writeText(window.location.href).then(
                () => toast.success("Link copied"),
                () => toast.error("Copy failed"),
              );
            }}
            title="Copy shareable link (embeds the current SQL if short)"
          >
            <Share2 className="h-3.5 w-3.5" /> Share
          </Button>
          <Button size="sm" variant="ghost" onClick={exportCsv} disabled={!result}>
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSendOpen(true)}
            disabled={!sql.trim()}
            title="Send result to email / Slack / webhook"
          >
            <Send className="h-3.5 w-3.5" /> Send
          </Button>
          {result && (
            <span
              className={
                "ml-auto text-xs font-mono " +
                (result.truncated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")
              }
            >
              {result.truncated ? `${result.rowCount}+ rows (capped)` : `${result.rowCount ?? result.rows.length} rows`} ·{" "}
              {result.durationMs}ms
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

        <div className="flex-1 min-h-0 flex flex-col">
          {(result || explainResult) && (
            <div className="flex items-center gap-1 border-b border-border px-2">
              <button
                type="button"
                onClick={() => setResultTab("data")}
                className={
                  "px-3 py-1.5 text-xs border-b-2 " +
                  (resultTab === "data"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground")
                }
              >
                Data {result ? `(${result.rowCount ?? result.rows.length})` : ""}
              </button>
              <button
                type="button"
                onClick={() => setResultTab("plan")}
                className={
                  "px-3 py-1.5 text-xs border-b-2 " +
                  (resultTab === "plan"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground")
                }
                disabled={!explainResult}
              >
                Plan
                {explainResult && explainResult.warnings.length > 0 && (
                  <span className="ml-1 inline-block rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                    {explainResult.warnings.length}
                  </span>
                )}
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex flex-col">
            {resultTab === "data" && result?.truncated && (
              <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                <span>
                  Showing first <strong>{result.rowCount}</strong> rows. Real result is larger — add
                  an explicit <code className="font-mono">LIMIT</code> to your query, or raise the
                  cap above.
                </span>
              </div>
            )}
            <div className="flex-1 min-h-0">
              {resultTab === "plan" && explainResult ? (
                <ExplainPanel result={explainResult} />
              ) : result ? (
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

      <AiQueryDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        connectionId={id!}
        schema={ctx?.schema}
        onAccept={(generatedSql) => setSql(generatedSql)}
      />

      <SendResultDialog
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        connectionId={id!}
        sql={sql}
      />
    </div>
  );
}
