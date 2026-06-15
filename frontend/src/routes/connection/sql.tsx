import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor, { type OnMount } from "@monaco-editor/react";
import { toast } from "sonner";
import { ArrowRightLeft, BarChart3, ChevronDown, Download, FileJson, FileSpreadsheet, FileText, Layers, Loader2, Play, Save, Send, Share2, Sparkles, Table2, Trash2 } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportCsv as dlCsv,
  exportJson as dlJson,
  exportExcel as dlExcel,
  toMarkdownTable,
  toInsertStatements,
  copyToClipboard,
} from "@/lib/result-export";
import { DataGrid } from "@/components/data-grid";
import { ExplainPanel } from "@/components/explain-panel";
import { api, extractErrorMessage, type ExplainResult, type QueryResult } from "@/lib/api";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { AiQueryDialog } from "@/components/ai-query-dialog";
import { SendResultDialog } from "@/components/send-result-dialog";
import { TranspileDialog } from "@/components/transpile-dialog";
import { registerSqlCompletions } from "@/lib/sql-completions";
import type { ErGraph } from "@/lib/api";
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
  const [insights, setInsights] = useState<
    | {
        dialect: string;
        findings: { severity: "info" | "warn" | "error"; title: string; detail: string }[];
        suggestions: { table: string; columns: string[]; reason: string; sql: string }[];
      }
    | null
  >(null);
  const [resultTab, setResultTab] = useState<"data" | "plan" | "insights">("data");
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
  const [shareOpen, setShareOpen] = useState(false);
  const [transpileOpen, setTranspileOpen] = useState(false);
  const ctx = useOutletContext<{ schema?: string } | null>();

  // Connection dialect — needed as the "from" side of dialect conversion.
  const connQ = useQuery({
    queryKey: ["connection", id],
    queryFn: () => api.getConnection(id!),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Live schema context fed to Monaco's completion provider. A ref + setter
  // keeps the provider closure stable — the provider reads the latest ER
  // via the getter instead of re-registering on every fetch.
  const erRef = useRef<ErGraph | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.getEr(id, ctx?.schema ?? "public")
      .then((er) => {
        if (!cancelled) erRef.current = er;
      })
      .catch(() => {
        /* ignore — completions just stay empty */
      });
    return () => {
      cancelled = true;
    };
  }, [id, ctx?.schema]);

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

  // Personal SQL snippets — insertable text blocks, global + per-connection.
  const snippetsQ = useQuery({
    queryKey: ["snippets", id],
    queryFn: () => api.listSnippets(id!),
    enabled: !!id,
  });
  const saveSnippet = async () => {
    const name = await modal.prompt({
      title: "Save snippet",
      description: "A short name for the current SQL.",
      placeholder: "monthly revenue",
      validate: (v) => (v.trim().length < 1 ? "Name required" : null),
    });
    if (!name) return;
    try {
      await api.createSnippet({ name: name.trim(), sqlText: sql, connectionId: id });
      toast.success("Snippet saved");
      qc.invalidateQueries({ queryKey: ["snippets", id] });
    } catch (e) {
      toast.error(extractErrorMessage(e));
    }
  };
  const deleteSnippet = async () => {
    const list = snippetsQ.data ?? [];
    const pick = await modal.select({
      title: "Delete snippet",
      options: list.map((s) => ({ value: s.id, label: s.name })),
    });
    if (!pick) return;
    try {
      await api.deleteSnippet(pick);
      toast.success("Snippet deleted");
      qc.invalidateQueries({ queryKey: ["snippets", id] });
    } catch (e) {
      toast.error(extractErrorMessage(e));
    }
  };

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

  const [estimate, setEstimate] = useState<{
    estimatedRowsScanned: number;
    verdict: "fast" | "moderate" | "slow" | "dangerous";
    estimatedDurationMs: number;
    warnings: string[];
  } | null>(null);
  const estimateMut = useMutation({
    mutationFn: (sqlText: string) => api.estimateCost(id!, sqlText),
    onSuccess: (r) => {
      setEstimate(r);
      const word =
        r.verdict === "dangerous"
          ? "Query looks dangerous"
          : r.verdict === "slow"
            ? "Query looks slow"
            : r.verdict === "moderate"
              ? "Query looks moderate"
              : "Query looks fast";
      toast.info(`${word}: ~${r.estimatedRowsScanned.toLocaleString()} rows, ~${Math.max(1, Math.round(r.estimatedDurationMs))}ms`);
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  const insightsMut = useMutation({
    mutationFn: (sqlText: string) => api.perfInsights(id!, sqlText),
    onSuccess: (r) => {
      setInsights(r);
      setResultTab("insights");
      toast.success(
        r.suggestions.length > 0
          ? `${r.suggestions.length} index suggestion(s)`
          : r.findings.length > 0
            ? `${r.findings.length} finding(s)`
            : "No issues detected",
      );
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
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

  // --- Query parameters (:name placeholders) ---------------------------
  // `:since`-style tokens are detected at run time; the user fills values in
  // a dialog and we substitute escaped literals before sending. `::casts`
  // and tokens inside quoted strings are ignored.
  const [paramRun, setParamRun] = useState<{ params: string[]; confirmDestructive?: boolean } | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const startRun = (confirmDestructive?: boolean) => {
    if (run.isPending || !sql.trim()) return;
    const params = extractQueryParams(sql);
    if (params.length > 0) {
      // Prefill from last-used values for this connection.
      try {
        const saved = JSON.parse(localStorage.getItem(`qparams:${id}`) ?? "{}");
        setParamValues(Object.fromEntries(params.map((p) => [p, saved[p] ?? ""])));
      } catch {
        setParamValues(Object.fromEntries(params.map((p) => [p, ""])));
      }
      setParamRun({ params, confirmDestructive });
      return;
    }
    run.mutate({ sql, confirmDestructive });
  };

  const runWithParams = () => {
    if (!paramRun) return;
    try {
      localStorage.setItem(`qparams:${id}`, JSON.stringify(paramValues));
    } catch { /* ignore */ }
    const substituted = substituteParams(sql, paramValues);
    setParamRun(null);
    run.mutate({ sql: substituted, confirmDestructive: paramRun.confirmDestructive });
  };

  // ---- Server-side cursor streaming ----
  // For huge result sets: open a Postgres cursor and pull pages, appending to
  // the grid, instead of buffering one giant response. A ref-backed stop flag
  // lets the user abort mid-stream; the cursor is closed server-side either way.
  const [streaming, setStreaming] = useState(false);
  const [streamedRows, setStreamedRows] = useState(0);
  const stopStreamRef = useRef(false);

  const streamAll = async () => {
    if (streaming || run.isPending || !sql.trim()) return;
    if (extractQueryParams(sql).length > 0) {
      toast.error("Streaming doesn't support :parameters — run normally instead.");
      return;
    }
    setStreaming(true);
    setStreamedRows(0);
    stopStreamRef.current = false;
    let cursorId: string | null = null;
    const PAGE = 2000;
    try {
      const first = await api.cursorOpen(id!, sql, PAGE);
      cursorId = first.cursorId;
      const fields = first.fields;
      const acc: Record<string, unknown>[] = [...first.rows];
      setResult({
        rows: acc,
        rowCount: acc.length,
        fields,
        durationMs: 0,
        truncated: false,
      } as QueryResult);
      setResultTab("data");
      setStreamedRows(acc.length);
      pushHistory({ sql, when: Date.now() });

      let done = first.done;
      while (!done && !stopStreamRef.current) {
        const page = await api.cursorFetch(id!, cursorId, PAGE);
        acc.push(...page.rows);
        done = page.done;
        // New array each page so the grid re-renders.
        setResult({
          rows: [...acc],
          rowCount: acc.length,
          fields,
          durationMs: 0,
          truncated: false,
        } as QueryResult);
        setStreamedRows(acc.length);
      }
      if (stopStreamRef.current && !done && cursorId) {
        await api.cursorClose(id!, cursorId).catch(() => {});
      }
      toast.success(
        stopStreamRef.current
          ? `Stopped at ${acc.length.toLocaleString()} rows`
          : `Streamed ${acc.length.toLocaleString()} rows`,
      );
    } catch (e: any) {
      const code = e?.response?.data?.code;
      if (code === "CURSOR_UNSUPPORTED") {
        toast.error("Streaming needs PostgreSQL without an SSH tunnel — using a normal run instead.");
        startRun();
      } else {
        toast.error(extractErrorMessage(e));
      }
      if (cursorId) await api.cursorClose(id!, cursorId).catch(() => {});
    } finally {
      setStreaming(false);
      stopStreamRef.current = false;
    }
  };

  // Keep a ref to the current run-callback so the Monaco command (bound once
  // on mount) always sees the latest `sql` without needing to re-bind.
  const runRef = useRef<() => void>(() => {});
  runRef.current = () => {
    startRun();
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

  // Column names in the order shown. Shared by every export format.
  const exportCols = () => (result ? result.fields.map((c) => c.name) : []);

  const copyMarkdown = async () => {
    if (!result) return;
    const ok = await copyToClipboard(toMarkdownTable(exportCols(), result.rows));
    ok ? toast.success("Markdown table copied") : toast.error("Copy failed");
  };
  const copyInserts = async () => {
    if (!result) return;
    const ok = await copyToClipboard(toInsertStatements(exportCols(), result.rows));
    ok ? toast.success("INSERT statements copied") : toast.error("Copy failed");
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
        {/* Toolbar split into two zones:
            - Left (pinned, never scrolls): Run + Limit. These are the
              must-always-see controls — hiding them would be hostile UX.
            - Right (horizontally scrollable): every secondary action. The
              scrollbar is hidden visually; users scroll by trackpad swipe,
              shift+wheel, or keyboard arrows. No wrap, no clipping. */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
          {/* Pinned zone */}
          <div className="flex items-center gap-2 shrink-0">
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
                startRun();
              }}
              disabled={run.isPending || !sql.trim()}
            >
              {run.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run
              <kbd className="ml-1 rounded border border-border bg-background/30 px-1 text-[10px]">Ctrl ↵</kbd>
            </Button>
            {streaming ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  stopStreamRef.current = true;
                }}
                title="Stop streaming"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Stop · {streamedRows.toLocaleString()}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={streamAll}
                disabled={run.isPending || !sql.trim()}
                title="Stream every row via a server-side cursor (PostgreSQL) — no row cap, paged so the browser stays responsive"
              >
                <Layers className="h-3.5 w-3.5" />
                Stream all
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTranspileOpen(true)}
              disabled={!sql.trim()}
              title="Convert this query to another SQL dialect"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              Convert
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
          </div>

          {/* Divider between pinned + scrollable zones so the split reads as
              intentional instead of accidental spacing. */}
          <div className="h-6 w-px bg-border shrink-0 mx-1" />

          {/* Scrollable zone — all secondary actions. `min-w-0` is critical
              on a flex child that should shrink below its content width;
              without it, `overflow-x-auto` has nothing to clip and the row
              blows past the parent. */}
          <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto sql-toolbar-scroll [&>*]:shrink-0 whitespace-nowrap">
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => sql.trim() && insightsMut.mutate(sql)}
            disabled={insightsMut.isPending || !sql.trim()}
            title="Analyze the plan for slow patterns and suggest indexes"
          >
            {insightsMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Insights
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => sql.trim() && estimateMut.mutate(sql)}
            disabled={estimateMut.isPending || !sql.trim()}
            title="Estimate rows + duration before running"
          >
            {estimateMut.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <BarChart3 className="h-3.5 w-3.5" />
            )}
            Estimate
          </Button>
          {estimate && (
            <span
              className={
                "inline-flex items-center gap-1 text-[11px] font-mono rounded px-2 py-1 " +
                (estimate.verdict === "dangerous"
                  ? "bg-destructive/10 text-destructive"
                  : estimate.verdict === "slow"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                    : estimate.verdict === "moderate"
                      ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")
              }
              title={estimate.warnings.join(" · ") || "No warnings"}
            >
              ~{estimate.estimatedRowsScanned.toLocaleString()} rows
            </span>
          )}
          <Button size="sm" variant="outline" onClick={doSave}>
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" title="SQL snippets">
                <FileText className="h-3.5 w-3.5" /> Snippets
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
              {(snippetsQ.data ?? []).map((s) => (
                <DropdownMenuItem
                  key={s.id}
                  onClick={() => setSql((prev) => (prev.trim() ? prev + "\n\n" + s.sqlText : s.sqlText))}
                  title={s.sqlText.slice(0, 200)}
                >
                  <FileText className="h-3.5 w-3.5" /> {s.name}
                </DropdownMenuItem>
              ))}
              {(snippetsQ.data ?? []).length === 0 && (
                <DropdownMenuItem disabled>No snippets yet</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={saveSnippet} disabled={!sql.trim()}>
                <Save className="h-3.5 w-3.5" /> Save current SQL as snippet…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={deleteSnippet} disabled={(snippetsQ.data ?? []).length === 0}>
                <Trash2 className="h-3.5 w-3.5" /> Delete a snippet…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" title="Share">
                <Share2 className="h-3.5 w-3.5" /> Share
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  navigator.clipboard.writeText(window.location.href).then(
                    () => toast.success("Editor link copied"),
                    () => toast.error("Copy failed"),
                  );
                }}
              >
                <Share2 className="h-3.5 w-3.5" /> Copy editor link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShareOpen(true)} disabled={!sql.trim()}>
                <Share2 className="h-3.5 w-3.5" /> Create public link…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={!result}>
                <Download className="h-3.5 w-3.5" /> Export
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => result && dlCsv(exportCols(), result.rows)}>
                <Download className="h-3.5 w-3.5" /> Download CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => result && dlJson(exportCols(), result.rows)}>
                <FileJson className="h-3.5 w-3.5" /> Download JSON
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => result && dlExcel(exportCols(), result.rows)}>
                <FileSpreadsheet className="h-3.5 w-3.5" /> Download Excel
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={copyMarkdown}>
                <FileText className="h-3.5 w-3.5" /> Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={copyInserts}>
                <Table2 className="h-3.5 w-3.5" /> Copy as INSERTs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              {result.cached && (
                <span
                  className="ml-2 inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                  title="Served from cache — invalidated automatically when the underlying tables change"
                >
                  cached
                </span>
              )}
            </span>
          )}
          </div>
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
              // Schema-aware completions. We dispose the previous provider
              // first so navigating between SQL tabs doesn't stack duplicates.
              const disposable = registerSqlCompletions(monaco, () => erRef.current);
              editor.onDidDispose(() => disposable.dispose());
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
          {(result || explainResult || insights) && (
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
              <button
                type="button"
                onClick={() => setResultTab("insights")}
                className={
                  "px-3 py-1.5 text-xs border-b-2 " +
                  (resultTab === "insights"
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground")
                }
                disabled={!insights}
              >
                Insights
                {insights && insights.suggestions.length > 0 && (
                  <span className="ml-1 inline-block rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
                    {insights.suggestions.length}
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
              ) : resultTab === "insights" && insights ? (
                <InsightsPanel insights={insights} />
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
      <ShareQueryDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        connectionId={id!}
        sql={sql}
      />
      <TranspileDialog
        open={transpileOpen}
        onOpenChange={setTranspileOpen}
        connectionId={id!}
        sourceDialect={connQ.data?.dialect ?? "POSTGRES"}
        sql={sql}
        onApply={(converted) => setSql(converted)}
      />
      {/* Parameter prompt — fills :name placeholders before running. */}
      <Dialog open={!!paramRun} onOpenChange={(v) => !v && setParamRun(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Query parameters</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(paramRun?.params ?? []).map((p) => (
              <div key={p} className="space-y-1">
                <label className="text-xs font-mono font-medium">:{p}</label>
                <Input
                  value={paramValues[p] ?? ""}
                  onChange={(e) => setParamValues((v) => ({ ...v, [p]: e.target.value }))}
                  placeholder="value (empty = NULL)"
                  onKeyDown={(e) => e.key === "Enter" && runWithParams()}
                />
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Numbers are passed as numbers, everything else as quoted strings. Empty = NULL.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setParamRun(null)}>Cancel</Button>
            <Button onClick={runWithParams}>
              <Play className="h-3.5 w-3.5" /> Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Find `:name` parameter tokens, skipping `::casts` and quoted strings. */
export function extractQueryParams(sql: string): string[] {
  // Blank out quoted strings/identifiers so tokens inside them are ignored.
  const stripped = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length));
  const out: string[] = [];
  const re = /(^|[^:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    if (!out.includes(m[2])) out.push(m[2]);
  }
  return out;
}

/** Replace :name tokens with escaped SQL literals. */
function substituteParams(sql: string, values: Record<string, string>): string {
  return sql.replace(/(^|[^:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g, (full, pre: string, name: string) => {
    if (!(name in values)) return full;
    const raw = values[name];
    let lit: string;
    if (raw === "") lit = "NULL";
    else if (/^-?\d+(\.\d+)?$/.test(raw.trim())) lit = raw.trim();
    else lit = `'${raw.replace(/'/g, "''")}'`;
    return `${pre}${lit}`;
  });
}

function ShareQueryDialog({
  open,
  onClose,
  connectionId,
  sql,
}: {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  sql: string;
}) {
  const [title, setTitle] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("7");
  const [link, setLink] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createSharedQuery(connectionId, {
        sqlText: sql,
        title: title.trim() || undefined,
        expiresInDays: expiresInDays === "never" ? undefined : parseInt(expiresInDays, 10),
      }),
    onSuccess: (r) => {
      const url = `${window.location.origin}/q/${r.token}`;
      setLink(url);
      navigator.clipboard.writeText(url).catch(() => {});
      toast.success("Public link created & copied");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setLink(null);
      setTitle("");
      setExpiresInDays("7");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create a public link</DialogTitle>
        </DialogHeader>
        {!link ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Anyone with the link can view this query's results (read-only, no login). The SQL is
              frozen — they can re-run and export but not edit. Only <strong>SELECT</strong> queries
              can be shared.
            </p>
            <div>
              <label className="text-xs font-medium">Title (optional)</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Monthly active users" />
            </div>
            <div>
              <label className="text-xs font-medium">Expires</label>
              <Select value={expiresInDays} onValueChange={setExpiresInDays}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">In 1 day</SelectItem>
                  <SelectItem value="7">In 7 days</SelectItem>
                  <SelectItem value="30">In 30 days</SelectItem>
                  <SelectItem value="never">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Link copied to clipboard:</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(link);
                  toast.success("Copied");
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          {!link ? (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => create.mutate()} disabled={create.isPending || !sql.trim()}>
                {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create link
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InsightsPanel({
  insights,
}: {
  insights: {
    findings: { severity: "info" | "warn" | "error"; title: string; detail: string }[];
    suggestions: { table: string; columns: string[]; reason: string; sql: string }[];
  };
}) {
  return (
    <div className="h-full overflow-auto p-4 space-y-4">
      {insights.suggestions.length === 0 && insights.findings.length === 0 && (
        <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No obvious performance issues found in the plan.
        </div>
      )}

      {insights.suggestions.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Suggested indexes
          </div>
          <div className="space-y-2">
            {insights.suggestions.map((s, i) => (
              <div
                key={i}
                className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2"
              >
                <div className="text-sm font-medium">
                  {s.table} ({s.columns.join(", ")})
                </div>
                <p className="text-xs text-muted-foreground">{s.reason}</p>
                <div className="relative">
                  <pre className="rounded bg-background p-2 text-xs font-mono overflow-x-auto">
                    {s.sql}
                  </pre>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(s.sql).then(
                        () => toast.success("Copied"),
                        () => toast.error("Copy failed"),
                      );
                    }}
                    className="absolute top-1 right-1 text-[10px] rounded bg-muted px-1.5 py-0.5 hover:bg-accent"
                  >
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            These are heuristics from the query plan. Always review and test on a staging copy — a
            wrong index can slow writes without helping reads.
          </p>
        </section>
      )}

      {insights.findings.length > 0 && (
        <section>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Plan findings
          </div>
          <div className="space-y-1.5">
            {insights.findings.map((f, i) => (
              <div
                key={i}
                className={
                  "rounded-md border p-3 " +
                  (f.severity === "error"
                    ? "border-destructive/40 bg-destructive/5"
                    : f.severity === "warn"
                      ? "border-amber-500/40 bg-amber-500/5"
                      : "border-border bg-card")
                }
              >
                <div className="text-sm font-medium">{f.title}</div>
                <p className="text-xs text-muted-foreground mt-0.5">{f.detail}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
