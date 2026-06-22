import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { toast } from "sonner";
import { ArrowRightLeft, BarChart3, ChevronDown, Download, FileJson, FileSpreadsheet, FileText, Layers, Loader2, Play, Save, Send, Share2, Sparkles, Table2, Trash2 } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { exportCsv as dlCsv, exportJson as dlJson, exportExcel as dlExcel, toMarkdownTable, toInsertStatements, toJson, copyToClipboard, } from "@/lib/result-export";
import { DataGrid } from "@/components/data-grid";
import { ExplainPanel } from "@/components/explain-panel";
import { api, extractErrorMessage } from "@/lib/api";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { AiQueryDialog } from "@/components/ai-query-dialog";
import { SendResultDialog } from "@/components/send-result-dialog";
import { TranspileDialog } from "@/components/transpile-dialog";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { registerSqlCompletions } from "@/lib/sql-completions";
import { useOutletContext } from "react-router-dom";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription, } from "@/components/ui/dialog";
const HISTORY_LIMIT = 50;
const historyKey = (id) => `dbdash.sqlHistory.${id}`;
function loadHistory(id) {
    try {
        const raw = localStorage.getItem(historyKey(id));
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((x) => x && typeof x.sql === "string" && typeof x.when === "number");
    }
    catch {
        return [];
    }
}
export default function SqlRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const modal = useModal();
    const isDark = useTheme((s) => s.theme === "dark");
    const [searchParams, setSearchParams] = useSearchParams();
    // Initial content priority: ?sql= deep link > per-connection saved draft > default.
    const [sql, setSql] = useState(() => {
        const urlSql = searchParams.get("sql");
        if (urlSql)
            return urlSql;
        try {
            const draft = localStorage.getItem(`sqldraft:${id}`);
            if (draft)
                return draft;
        }
        catch { /* ignore */ }
        return "SELECT 1 AS hello;";
    });
    // A deep link (?sql=) seeds the editor once, then we strip it from the URL so
    // the address bar stays clean instead of carrying the whole query.
    useEffect(() => {
        if (searchParams.get("sql")) {
            const next = new URLSearchParams(searchParams);
            next.delete("sql");
            setSearchParams(next, { replace: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Persist the editor content per-connection so a refresh keeps your work,
    // without polluting the URL. Debounced.
    useEffect(() => {
        const handle = setTimeout(() => {
            try {
                if (sql && sql !== "SELECT 1 AS hello;")
                    localStorage.setItem(`sqldraft:${id}`, sql);
                else
                    localStorage.removeItem(`sqldraft:${id}`);
            }
            catch { /* ignore quota */ }
        }, 400);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sql, id]);
    const [result, setResult] = useState(null);
    const [explainResult, setExplainResult] = useState(null);
    const [insights, setInsights] = useState(null);
    const [resultTab, setResultTab] = useState("data");
    // Row-cap for SELECT queries. 0 means "no cap" and triggers a warning before
    // running — raw SELECT * FROM big_table is a common way to freeze the app.
    const [maxRows, setMaxRows] = useState(() => {
        const stored = localStorage.getItem("dbdash.sqlMaxRows");
        const n = stored ? parseInt(stored, 10) : NaN;
        return Number.isFinite(n) && n >= 0 ? n : 1000;
    });
    useEffect(() => {
        localStorage.setItem("dbdash.sqlMaxRows", String(maxRows));
    }, [maxRows]);
    const [history, setHistory] = useState(() => (id ? loadHistory(id) : []));
    const [confirmSql, setConfirmSql] = useState(null);
    const [aiOpen, setAiOpen] = useState(false);
    const [sendOpen, setSendOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [transpileOpen, setTranspileOpen] = useState(false);
    const ctx = useOutletContext();
    // Connection dialect — needed as the "from" side of dialect conversion.
    const connQ = useQuery({
        queryKey: ["connection", id],
        queryFn: () => api.getConnection(id),
        enabled: !!id,
        staleTime: 5 * 60_000,
    });
    const editorRef = useRef(null);
    // Live schema context fed to Monaco's completion provider. A ref + setter
    // keeps the provider closure stable — the provider reads the latest ER
    // via the getter instead of re-registering on every fetch.
    const erRef = useRef(null);
    useEffect(() => {
        if (!id)
            return;
        let cancelled = false;
        api.getEr(id, ctx?.schema ?? "public")
            .then((er) => {
            if (!cancelled)
                erRef.current = er;
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
        if (id)
            setHistory(loadHistory(id));
    }, [id]);
    const pushHistory = useCallback((entry) => {
        if (!id)
            return;
        setHistory((h) => {
            // Dedupe the most recent same-SQL so consecutive runs don't spam.
            const deduped = h[0]?.sql === entry.sql ? h : [entry, ...h];
            const next = deduped.slice(0, HISTORY_LIMIT);
            try {
                localStorage.setItem(historyKey(id), JSON.stringify(next));
            }
            catch {
                // Storage full / disabled — silently fall back to in-memory only.
            }
            return next;
        });
    }, [id]);
    const clearHistory = () => {
        if (!id)
            return;
        setHistory([]);
        try {
            localStorage.removeItem(historyKey(id));
        }
        catch {
            // ignore
        }
    };
    const savedQ = useQuery({
        queryKey: ["saved-queries", id],
        queryFn: () => api.listSavedQueries(id),
        enabled: !!id,
    });
    // Personal SQL snippets — insertable text blocks, global + per-connection.
    const snippetsQ = useQuery({
        queryKey: ["snippets", id],
        queryFn: () => api.listSnippets(id),
        enabled: !!id,
    });
    const saveSnippet = async () => {
        const name = await modal.prompt({
            title: "Save snippet",
            description: "A short name for the current SQL.",
            placeholder: "monthly revenue",
            validate: (v) => (v.trim().length < 1 ? "Name required" : null),
        });
        if (!name)
            return;
        try {
            await api.createSnippet({ name: name.trim(), sqlText: sql, connectionId: id });
            toast.success("Snippet saved");
            qc.invalidateQueries({ queryKey: ["snippets", id] });
        }
        catch (e) {
            toast.error(extractErrorMessage(e));
        }
    };
    const deleteSnippet = async () => {
        const list = snippetsQ.data ?? [];
        const pick = await modal.select({
            title: "Delete snippet",
            options: list.map((s) => ({ value: s.id, label: s.name })),
        });
        if (!pick)
            return;
        try {
            await api.deleteSnippet(pick);
            toast.success("Snippet deleted");
            qc.invalidateQueries({ queryKey: ["snippets", id] });
        }
        catch (e) {
            toast.error(extractErrorMessage(e));
        }
    };
    const run = useMutation({
        mutationFn: async (body) => api.runQuery(id, { ...body, maxRows }),
        onSuccess: (r) => {
            setResult(r);
            setResultTab("data");
            pushHistory({ sql, when: Date.now() });
            if (r.truncated) {
                toast.warning(`Showed first ${r.rowCount} rows — result is larger. Add LIMIT to your query or raise the cap.`);
            }
            else {
                toast.success(`${r.rowCount ?? r.rows.length} rows · ${r.durationMs}ms`);
            }
        },
        onError: (err) => {
            const data = err?.response?.data;
            if (data?.needsConfirm || data?.confirmRequired) {
                setConfirmSql(sql);
            }
            else {
                toast.error(extractErrorMessage(err));
            }
        },
    });
    const [estimate, setEstimate] = useState(null);
    const estimateMut = useMutation({
        mutationFn: (sqlText) => api.estimateCost(id, sqlText),
        onSuccess: (r) => {
            setEstimate(r);
            const word = r.verdict === "dangerous"
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
        mutationFn: (sqlText) => api.perfInsights(id, sqlText),
        onSuccess: (r) => {
            setInsights(r);
            setResultTab("insights");
            toast.success(r.suggestions.length > 0
                ? `${r.suggestions.length} index suggestion(s)`
                : r.findings.length > 0
                    ? `${r.findings.length} finding(s)`
                    : "No issues detected");
        },
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    const explainMut = useMutation({
        mutationFn: (body) => api.explain(id, body),
        onSuccess: (r) => {
            setExplainResult(r);
            setResultTab("plan");
            toast.success(r.mode === "analyze"
                ? `Plan + execution analysis (${r.warnings.length} warnings)`
                : `Plan analysis (${r.warnings.length} warnings)`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const saveMut = useMutation({
        mutationFn: (body) => api.createSavedQuery(id, body),
        onSuccess: () => {
            toast.success("Query saved");
            qc.invalidateQueries({ queryKey: ["saved-queries", id] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const delSaved = useMutation({
        mutationFn: (qid) => api.deleteSavedQuery(id, qid),
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
    const [paramRun, setParamRun] = useState(null);
    const [paramValues, setParamValues] = useState({});
    /**
     * Decide which SQL to actually run:
     *  1. If the user has selected text → run exactly that.
     *  2. Else → run the single statement under the cursor.
     *  3. Else (no editor / cursor info) → run the last non-empty statement.
     * Falls back to the whole buffer if splitting yields nothing.
     */
    const resolveSqlToRun = () => {
        const editor = editorRef.current;
        if (editor) {
            const model = editor.getModel?.();
            const selection = editor.getSelection?.();
            // 1) Non-empty selection wins.
            if (model && selection && !selection.isEmpty()) {
                const selected = model.getValueInRange(selection);
                if (selected.trim())
                    return selected;
            }
            // 2) Statement under the cursor.
            if (model && selection) {
                const offset = model.getOffsetAt(selection.getPosition());
                const stmt = statementAtOffset(sql, offset);
                if (stmt && stmt.trim())
                    return stmt;
            }
        }
        // 3) Last non-empty statement, else whole buffer.
        const parts = splitSqlStatements(sql).filter((s) => s.trim());
        return parts.length ? parts[parts.length - 1] : sql;
    };
    const startRun = (confirmDestructive) => {
        if (run.isPending || !sql.trim())
            return;
        const sqlToRun = resolveSqlToRun();
        const params = extractQueryParams(sqlToRun);
        if (params.length > 0) {
            // Prefill from last-used values for this connection.
            try {
                const saved = JSON.parse(localStorage.getItem(`qparams:${id}`) ?? "{}");
                setParamValues(Object.fromEntries(params.map((p) => [p, saved[p] ?? ""])));
            }
            catch {
                setParamValues(Object.fromEntries(params.map((p) => [p, ""])));
            }
            setParamRun({ params, confirmDestructive, sql: sqlToRun });
            return;
        }
        run.mutate({ sql: sqlToRun, confirmDestructive });
    };
    const runWithParams = () => {
        if (!paramRun)
            return;
        try {
            localStorage.setItem(`qparams:${id}`, JSON.stringify(paramValues));
        }
        catch { /* ignore */ }
        const substituted = substituteParams(paramRun.sql, paramValues);
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
        if (streaming || run.isPending || !sql.trim())
            return;
        if (extractQueryParams(sql).length > 0) {
            toast.error("Streaming doesn't support :parameters — run normally instead.");
            return;
        }
        setStreaming(true);
        setStreamedRows(0);
        stopStreamRef.current = false;
        let cursorId = null;
        const PAGE = 2000;
        try {
            const first = await api.cursorOpen(id, sql, PAGE);
            cursorId = first.cursorId;
            const fields = first.fields;
            const acc = [...first.rows];
            setResult({
                rows: acc,
                rowCount: acc.length,
                fields,
                durationMs: 0,
                truncated: false,
            });
            setResultTab("data");
            setStreamedRows(acc.length);
            pushHistory({ sql, when: Date.now() });
            let done = first.done;
            while (!done && !stopStreamRef.current) {
                const page = await api.cursorFetch(id, cursorId, PAGE);
                acc.push(...page.rows);
                done = page.done;
                // New array each page so the grid re-renders.
                setResult({
                    rows: [...acc],
                    rowCount: acc.length,
                    fields,
                    durationMs: 0,
                    truncated: false,
                });
                setStreamedRows(acc.length);
            }
            if (stopStreamRef.current && !done && cursorId) {
                await api.cursorClose(id, cursorId).catch(() => { });
            }
            toast.success(stopStreamRef.current
                ? `Stopped at ${acc.length.toLocaleString()} rows`
                : `Streamed ${acc.length.toLocaleString()} rows`);
        }
        catch (e) {
            const code = e?.response?.data?.code;
            if (code === "CURSOR_UNSUPPORTED") {
                toast.error("Streaming needs PostgreSQL without an SSH tunnel — using a normal run instead.");
                startRun();
            }
            else {
                toast.error(extractErrorMessage(e));
            }
            if (cursorId)
                await api.cursorClose(id, cursorId).catch(() => { });
        }
        finally {
            setStreaming(false);
            stopStreamRef.current = false;
        }
    };
    // Keep a ref to the current run-callback so the Monaco command (bound once
    // on mount) always sees the latest `sql` without needing to re-bind.
    const runRef = useRef(() => { });
    runRef.current = () => {
        startRun();
    };
    const formatRef = useRef(() => { });
    formatRef.current = () => {
        if (!sql.trim())
            return;
        try {
            const formatted = formatSql(sql, { language: "postgresql", keywordCase: "upper", tabWidth: 2 });
            setSql(formatted);
        }
        catch (err) {
            toast.error(`Format failed: ${err.message}`);
        }
    };
    // Fallback window-level handler for when Monaco isn't focused.
    useEffect(() => {
        const h = (e) => {
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
        if (name)
            saveMut.mutate({ name, sqlText: sql });
    };
    // Column names in the order shown. Shared by every export format.
    const exportCols = () => (result ? result.fields.map((c) => c.name) : []);
    const copyMarkdown = async () => {
        if (!result)
            return;
        const ok = await copyToClipboard(toMarkdownTable(exportCols(), result.rows));
        ok ? toast.success("Markdown table copied") : toast.error("Copy failed");
    };
    const copyInserts = async () => {
        if (!result)
            return;
        const ok = await copyToClipboard(toInsertStatements(exportCols(), result.rows));
        ok ? toast.success("INSERT statements copied") : toast.error("Copy failed");
    };
    const copyJson = async () => {
        if (!result)
            return;
        const ok = await copyToClipboard(toJson(exportCols(), result.rows));
        ok ? toast.success("JSON copied") : toast.error("Copy failed");
    };
    return (_jsxs(_Fragment, { children: [_jsxs(ResizablePanelGroup, { direction: "horizontal", autoSaveId: "sql-editor-h", className: "h-full", children: [_jsx(ResizablePanel, { defaultSize: 16, minSize: 10, maxSize: 35, collapsible: true, collapsedSize: 0, children: _jsxs("aside", { className: "h-full w-full shrink-0 border-r border-border bg-card flex flex-col", children: [_jsx("div", { className: "px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-b border-border", children: "Saved queries" }), _jsxs("div", { className: "flex-1 overflow-auto p-1", children: [savedQ.isLoading && _jsx("div", { className: "p-2 text-xs text-muted-foreground", children: "Loading..." }), savedQ.data?.length === 0 && (_jsxs("div", { className: "p-3 text-[11px] text-muted-foreground text-center", children: ["No saved queries. Click ", _jsx("span", { className: "font-medium text-foreground", children: "Save" }), " to keep one."] })), savedQ.data?.map((q) => (_jsxs("div", { className: "group flex items-center gap-1 px-2 py-1 rounded hover:bg-accent", children: [_jsx("button", { onClick: () => setSql(q.sqlText), className: "flex-1 text-left text-xs truncate", children: q.name }), _jsx("button", { onClick: async () => {
                                                        const ok = await modal.confirm({
                                                            title: `Delete "${q.name}"?`,
                                                            description: "This removes the saved query.",
                                                            confirmLabel: "Delete",
                                                            destructive: true,
                                                        });
                                                        if (ok)
                                                            delSaved.mutate(q.id);
                                                    }, className: "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] }, q.id)))] }), _jsxs("div", { className: "px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-t border-b border-border flex items-center justify-between", children: [_jsx("span", { children: "History" }), history.length > 0 && (_jsx("button", { type: "button", onClick: clearHistory, className: "text-[10px] normal-case text-muted-foreground/70 hover:text-destructive", children: "Clear" }))] }), _jsxs("div", { className: "flex-1 overflow-auto p-1", children: [history.length === 0 && _jsx("div", { className: "p-2 text-xs text-muted-foreground", children: "No history yet" }), history.map((h, i) => (_jsx("button", { onClick: () => setSql(h.sql), className: "block w-full text-left px-2 py-1 rounded hover:bg-accent text-xs font-mono truncate", title: h.sql, children: h.sql.split("\n")[0].slice(0, 30) }, i)))] })] }) }), _jsx(ResizableHandle, { withHandle: true }), _jsx(ResizablePanel, { defaultSize: 84, minSize: 40, children: _jsxs("div", { className: "flex-1 flex flex-col min-w-0 h-full", children: [_jsxs("div", { className: "flex items-center gap-2 px-4 py-2 border-b border-border", children: [_jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsxs(Button, { size: "sm", onClick: async () => {
                                                        if (!sql.trim())
                                                            return;
                                                        if (maxRows === 0) {
                                                            const ok = await modal.confirm({
                                                                title: "Run without a row cap?",
                                                                description: "Unbounded SELECT on a large table can freeze the browser and stress the database. Continue?",
                                                                confirmLabel: "Run anyway",
                                                                destructive: true,
                                                            });
                                                            if (!ok)
                                                                return;
                                                        }
                                                        startRun();
                                                    }, disabled: run.isPending || !sql.trim(), children: [run.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Play, { className: "h-3.5 w-3.5" }), "Run", _jsx("kbd", { className: "ml-1 rounded border border-border bg-background/30 px-1 text-[10px]", children: "Ctrl \u21B5" })] }), streaming ? (_jsxs(Button, { size: "sm", variant: "outline", onClick: () => {
                                                        stopStreamRef.current = true;
                                                    }, title: "Stop streaming", children: [_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), "Stop \u00B7 ", streamedRows.toLocaleString()] })) : (_jsxs(Button, { size: "sm", variant: "outline", onClick: streamAll, disabled: run.isPending || !sql.trim(), title: "Stream every row via a server-side cursor (PostgreSQL) \u2014 no row cap, paged so the browser stays responsive", children: [_jsx(Layers, { className: "h-3.5 w-3.5" }), "Stream all"] })), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => setTranspileOpen(true), disabled: !sql.trim(), title: "Convert this query to another SQL dialect", children: [_jsx(ArrowRightLeft, { className: "h-3.5 w-3.5" }), "Convert"] }), _jsxs("div", { className: "flex items-center gap-1.5 text-xs text-muted-foreground", children: [_jsx("span", { children: "Limit" }), _jsxs(Select, { value: String(maxRows), onValueChange: (v) => setMaxRows(parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "h-7 w-28 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "100", children: "100" }), _jsx(SelectItem, { value: "500", children: "500" }), _jsx(SelectItem, { value: "1000", children: "1,000" }), _jsx(SelectItem, { value: "5000", children: "5,000" }), _jsx(SelectItem, { value: "10000", children: "10,000" }), _jsx(SelectItem, { value: "0", children: "No cap" })] })] })] })] }), _jsx("div", { className: "h-6 w-px bg-border shrink-0 mx-1" }), _jsxs("div", { className: "flex items-center gap-2 min-w-0 flex-1 overflow-x-auto sql-toolbar-scroll [&>*]:shrink-0 whitespace-nowrap", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: () => setAiOpen(true), children: [_jsx(Sparkles, { className: "h-3.5 w-3.5" }), " Ask AI"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => formatRef.current(), children: ["Format", _jsx("kbd", { className: "ml-1 rounded border border-border bg-background/30 px-1 text-[10px]", children: "Shift \u2325 F" })] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => sql.trim() && explainMut.mutate({ sql, mode: "plan" }), disabled: explainMut.isPending || !sql.trim(), title: "Show plan without running", children: [explainMut.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(BarChart3, { className: "h-3.5 w-3.5" }), "Explain"] }), _jsx(Button, { size: "sm", variant: "outline", onClick: async () => {
                                                        const ok = await modal.confirm({
                                                            title: "Run EXPLAIN ANALYZE?",
                                                            description: "This actually executes the query to measure real timings. SELECT is safe; DML runs inside a BEGIN/ROLLBACK so nothing persists.",
                                                            confirmLabel: "Run analyze",
                                                        });
                                                        if (ok)
                                                            explainMut.mutate({ sql, mode: "analyze" });
                                                    }, disabled: explainMut.isPending || !sql.trim(), title: "Run EXPLAIN ANALYZE (executes the query)", children: "Analyze" }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => sql.trim() && insightsMut.mutate(sql), disabled: insightsMut.isPending || !sql.trim(), title: "Analyze the plan for slow patterns and suggest indexes", children: [insightsMut.isPending ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(Sparkles, { className: "h-3.5 w-3.5" })), "Insights"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => sql.trim() && estimateMut.mutate(sql), disabled: estimateMut.isPending || !sql.trim(), title: "Estimate rows + duration before running", children: [estimateMut.isPending ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(BarChart3, { className: "h-3.5 w-3.5" })), "Estimate"] }), estimate && (_jsxs("span", { className: "inline-flex items-center gap-1 text-[11px] font-mono rounded px-2 py-1 " +
                                                        (estimate.verdict === "dangerous"
                                                            ? "bg-destructive/10 text-destructive"
                                                            : estimate.verdict === "slow"
                                                                ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                                                : estimate.verdict === "moderate"
                                                                    ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                                                                    : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"), title: estimate.warnings.join(" · ") || "No warnings", children: ["~", estimate.estimatedRowsScanned.toLocaleString(), " rows"] })), _jsxs(Button, { size: "sm", variant: "outline", onClick: doSave, children: [_jsx(Save, { className: "h-3.5 w-3.5" }), " Save"] }), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: "sm", variant: "ghost", title: "SQL snippets", children: [_jsx(FileText, { className: "h-3.5 w-3.5" }), " Snippets", _jsx(ChevronDown, { className: "h-3 w-3 opacity-60" })] }) }), _jsxs(DropdownMenuContent, { align: "end", className: "max-h-80 overflow-auto", children: [(snippetsQ.data ?? []).map((s) => (_jsxs(DropdownMenuItem, { onClick: () => setSql((prev) => (prev.trim() ? prev + "\n\n" + s.sqlText : s.sqlText)), title: s.sqlText.slice(0, 200), children: [_jsx(FileText, { className: "h-3.5 w-3.5" }), " ", s.name] }, s.id))), (snippetsQ.data ?? []).length === 0 && (_jsx(DropdownMenuItem, { disabled: true, children: "No snippets yet" })), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onClick: saveSnippet, disabled: !sql.trim(), children: [_jsx(Save, { className: "h-3.5 w-3.5" }), " Save current SQL as snippet\u2026"] }), _jsxs(DropdownMenuItem, { onClick: deleteSnippet, disabled: (snippetsQ.data ?? []).length === 0, children: [_jsx(Trash2, { className: "h-3.5 w-3.5" }), " Delete a snippet\u2026"] })] })] }), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: "sm", variant: "ghost", title: "Share", children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Share", _jsx(ChevronDown, { className: "h-3 w-3 opacity-60" })] }) }), _jsxs(DropdownMenuContent, { align: "end", children: [_jsxs(DropdownMenuItem, { onClick: () => {
                                                                        navigator.clipboard.writeText(window.location.href).then(() => toast.success("Editor link copied"), () => toast.error("Copy failed"));
                                                                    }, children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Copy editor link"] }), _jsxs(DropdownMenuItem, { onClick: () => setShareOpen(true), disabled: !sql.trim(), children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Create public link\u2026"] })] })] }), _jsxs(DropdownMenu, { children: [_jsx(DropdownMenuTrigger, { asChild: true, children: _jsxs(Button, { size: "sm", variant: "ghost", disabled: !result, children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Export", _jsx(ChevronDown, { className: "h-3 w-3 opacity-60" })] }) }), _jsxs(DropdownMenuContent, { align: "end", children: [_jsxs(DropdownMenuItem, { onClick: () => result && dlCsv(exportCols(), result.rows), children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Download CSV"] }), _jsxs(DropdownMenuItem, { onClick: () => result && dlJson(exportCols(), result.rows), children: [_jsx(FileJson, { className: "h-3.5 w-3.5" }), " Download JSON"] }), _jsxs(DropdownMenuItem, { onClick: () => result && dlExcel(exportCols(), result.rows), children: [_jsx(FileSpreadsheet, { className: "h-3.5 w-3.5" }), " Download Excel"] }), _jsx(DropdownMenuSeparator, {}), _jsxs(DropdownMenuItem, { onClick: copyMarkdown, children: [_jsx(FileText, { className: "h-3.5 w-3.5" }), " Copy as Markdown"] }), _jsxs(DropdownMenuItem, { onClick: copyJson, children: [_jsx(FileJson, { className: "h-3.5 w-3.5" }), " Copy as JSON"] }), _jsxs(DropdownMenuItem, { onClick: copyInserts, children: [_jsx(Table2, { className: "h-3.5 w-3.5" }), " Copy as INSERTs"] })] })] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setSendOpen(true), disabled: !sql.trim(), title: "Send result to email / Slack / webhook", children: [_jsx(Send, { className: "h-3.5 w-3.5" }), " Send"] }), result && (_jsxs("span", { className: "ml-auto text-xs font-mono " +
                                                        (result.truncated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"), children: [result.truncated ? `${result.rowCount}+ rows (capped)` : `${result.rowCount ?? result.rows.length} rows`, " \u00B7", " ", result.durationMs, "ms", result.cached && (_jsx("span", { className: "ml-2 inline-flex items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400", title: "Served from cache \u2014 invalidated automatically when the underlying tables change", children: "cached" }))] }))] })] }), _jsxs(ResizablePanelGroup, { direction: "vertical", autoSaveId: "sql-editor-v", className: "flex-1 min-h-0", children: [_jsx(ResizablePanel, { defaultSize: 40, minSize: 15, children: _jsx("div", { className: "h-full min-h-0 border-b border-border", children: _jsx(Editor, { height: "100%", defaultLanguage: "sql", theme: isDark ? "vs-dark" : "vs", value: sql, onChange: (v) => setSql(v ?? ""), onMount: (editor, monaco) => {
                                                        editorRef.current = editor;
                                                        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());
                                                        // Shift+Alt+F = format, matching VS Code.
                                                        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => formatRef.current());
                                                        // Schema-aware completions. We dispose the previous provider
                                                        // first so navigating between SQL tabs doesn't stack duplicates.
                                                        const disposable = registerSqlCompletions(monaco, () => erRef.current);
                                                        editor.onDidDispose(() => disposable.dispose());
                                                    }, options: {
                                                        minimap: { enabled: false },
                                                        fontSize: 13,
                                                        fontFamily: "JetBrains Mono, monospace",
                                                        tabSize: 2,
                                                        automaticLayout: true,
                                                    } }) }) }), _jsx(ResizableHandle, { withHandle: true }), _jsx(ResizablePanel, { defaultSize: 60, minSize: 10, children: _jsxs("div", { className: "h-full min-h-0 flex flex-col", children: [(result || explainResult || insights) && (_jsxs("div", { className: "flex items-center gap-1 border-b border-border px-2", children: [_jsxs("button", { type: "button", onClick: () => setResultTab("data"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                                                    (resultTab === "data"
                                                                        ? "border-primary text-foreground"
                                                                        : "border-transparent text-muted-foreground hover:text-foreground"), children: ["Data ", result ? `(${result.rowCount ?? result.rows.length})` : ""] }), _jsxs("button", { type: "button", onClick: () => setResultTab("plan"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                                                    (resultTab === "plan"
                                                                        ? "border-primary text-foreground"
                                                                        : "border-transparent text-muted-foreground hover:text-foreground"), disabled: !explainResult, children: ["Plan", explainResult && explainResult.warnings.length > 0 && (_jsx("span", { className: "ml-1 inline-block rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400", children: explainResult.warnings.length }))] }), _jsxs("button", { type: "button", onClick: () => setResultTab("insights"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                                                    (resultTab === "insights"
                                                                        ? "border-primary text-foreground"
                                                                        : "border-transparent text-muted-foreground hover:text-foreground"), disabled: !insights, children: ["Insights", insights && insights.suggestions.length > 0 && (_jsx("span", { className: "ml-1 inline-block rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary", children: insights.suggestions.length }))] })] })), _jsxs("div", { className: "flex-1 min-h-0 flex flex-col", children: [resultTab === "data" && result?.truncated && (_jsx("div", { className: "flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400", children: _jsxs("span", { children: ["Showing first ", _jsx("strong", { children: result.rowCount }), " rows. Real result is larger \u2014 add an explicit ", _jsx("code", { className: "font-mono", children: "LIMIT" }), " to your query, or raise the cap above."] }) })), _jsx("div", { className: "flex-1 min-h-0", children: resultTab === "plan" && explainResult ? (_jsx(ExplainPanel, { result: explainResult })) : resultTab === "insights" && insights ? (_jsx(InsightsPanel, { insights: insights })) : result ? (_jsx(DataGrid, { columns: result.fields.map((c) => ({ name: c.name, type: c.dataType })), rows: result.rows, emptyMessage: "Query returned no rows" })) : (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Run a query to see results." })) })] })] }) })] })] }) })] }), _jsx(Dialog, { open: !!confirmSql, onOpenChange: (v) => !v && setConfirmSql(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Destructive query detected" }), _jsx(DialogDescription, { children: "This query modifies data without a WHERE clause. Confirm to run." })] }), _jsx("pre", { className: "rounded-md bg-muted p-3 text-xs font-mono overflow-auto max-h-40", children: confirmSql }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: () => setConfirmSql(null), children: "Cancel" }), _jsx(Button, { variant: "destructive", onClick: () => {
                                        if (confirmSql)
                                            run.mutate({ sql: confirmSql, confirmDestructive: true });
                                        setConfirmSql(null);
                                    }, children: "Run anyway" })] })] }) }), _jsx(AiQueryDialog, { open: aiOpen, onOpenChange: setAiOpen, connectionId: id, schema: ctx?.schema, onAccept: (generatedSql) => setSql(generatedSql) }), _jsx(SendResultDialog, { open: sendOpen, onClose: () => setSendOpen(false), connectionId: id, sql: sql }), _jsx(ShareQueryDialog, { open: shareOpen, onClose: () => setShareOpen(false), connectionId: id, sql: sql }), _jsx(TranspileDialog, { open: transpileOpen, onOpenChange: setTranspileOpen, connectionId: id, sourceDialect: connQ.data?.dialect ?? "POSTGRES", sql: sql, onApply: (converted) => setSql(converted) }), _jsx(Dialog, { open: !!paramRun, onOpenChange: (v) => !v && setParamRun(null), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsx(DialogHeader, { children: _jsx(DialogTitle, { children: "Query parameters" }) }), _jsxs("div", { className: "space-y-3", children: [(paramRun?.params ?? []).map((p) => (_jsxs("div", { className: "space-y-1", children: [_jsxs("label", { className: "text-xs font-mono font-medium", children: [":", p] }), _jsx(Input, { value: paramValues[p] ?? "", onChange: (e) => setParamValues((v) => ({ ...v, [p]: e.target.value })), placeholder: "value (empty = NULL)", onKeyDown: (e) => e.key === "Enter" && runWithParams() })] }, p))), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "Numbers are passed as numbers, everything else as quoted strings. Empty = NULL." })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: () => setParamRun(null), children: "Cancel" }), _jsxs(Button, { onClick: runWithParams, children: [_jsx(Play, { className: "h-3.5 w-3.5" }), " Run"] })] })] }) })] }));
}
/** Find `:name` parameter tokens, skipping `::casts` and quoted strings. */
export function extractQueryParams(sql) {
    // Blank out quoted strings/identifiers so tokens inside them are ignored.
    const stripped = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => " ".repeat(m.length));
    const out = [];
    const re = /(^|[^:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let m;
    while ((m = re.exec(stripped))) {
        if (!out.includes(m[2]))
            out.push(m[2]);
    }
    return out;
}
/** Replace :name tokens with escaped SQL literals. */
function substituteParams(sql, values) {
    return sql.replace(/(^|[^:\w]):([a-zA-Z_][a-zA-Z0-9_]*)/g, (full, pre, name) => {
        if (!(name in values))
            return full;
        const raw = values[name];
        let lit;
        if (raw === "")
            lit = "NULL";
        else if (/^-?\d+(\.\d+)?$/.test(raw.trim()))
            lit = raw.trim();
        else
            lit = `'${raw.replace(/'/g, "''")}'`;
        return `${pre}${lit}`;
    });
}
/**
 * Split a SQL buffer into individual statements on top-level semicolons,
 * ignoring `;` inside single/double-quoted strings, line/block comments, and
 * Postgres dollar-quoted bodies ($$ ... $$ / $tag$ ... $tag$). Returns each
 * statement WITH a trailing newline-preserved slice so cursor offsets map back.
 * The returned strings include their original text (sans the splitting `;`).
 */
function splitSqlStatements(sql) {
    const out = [];
    let buf = "";
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const ch = sql[i];
        const two = sql.slice(i, i + 2);
        // Line comment.
        if (two === "--") {
            const end = sql.indexOf("\n", i);
            const stop = end === -1 ? n : end;
            buf += sql.slice(i, stop);
            i = stop;
            continue;
        }
        // Block comment.
        if (two === "/*") {
            const end = sql.indexOf("*/", i + 2);
            const stop = end === -1 ? n : end + 2;
            buf += sql.slice(i, stop);
            i = stop;
            continue;
        }
        // Single/double quoted string.
        if (ch === "'" || ch === '"') {
            const q = ch;
            buf += ch;
            i++;
            while (i < n) {
                buf += sql[i];
                if (sql[i] === q) {
                    // Doubled quote = escaped, stay in string.
                    if (sql[i + 1] === q) {
                        buf += sql[i + 1];
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        // Dollar-quoted body: $tag$ ... $tag$.
        if (ch === "$") {
            const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (m) {
                const tag = m[0];
                const close = sql.indexOf(tag, i + tag.length);
                const stop = close === -1 ? n : close + tag.length;
                buf += sql.slice(i, stop);
                i = stop;
                continue;
            }
        }
        if (ch === ";") {
            out.push(buf);
            buf = "";
            i++;
            continue;
        }
        buf += ch;
        i++;
    }
    if (buf.trim())
        out.push(buf);
    return out;
}
/** Return the single statement that contains the given character offset. */
function statementAtOffset(sql, offset) {
    const parts = splitSqlStatements(sql);
    let pos = 0;
    for (const part of parts) {
        // +1 accounts for the `;` consumed by the splitter between statements.
        const start = pos;
        const end = pos + part.length;
        if (offset >= start && offset <= end + 1) {
            return part.trim() ? part : null;
        }
        pos = end + 1;
    }
    return null;
}
function ShareQueryDialog({ open, onClose, connectionId, sql, }) {
    const [title, setTitle] = useState("");
    const [expiresInDays, setExpiresInDays] = useState("7");
    const [link, setLink] = useState(null);
    const create = useMutation({
        mutationFn: () => api.createSharedQuery(connectionId, {
            sqlText: sql,
            title: title.trim() || undefined,
            expiresInDays: expiresInDays === "never" ? undefined : parseInt(expiresInDays, 10),
        }),
        onSuccess: (r) => {
            const url = `${window.location.origin}/q/${r.token}`;
            setLink(url);
            navigator.clipboard.writeText(url).catch(() => { });
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
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsx(DialogHeader, { children: _jsx(DialogTitle, { children: "Create a public link" }) }), !link ? (_jsxs("div", { className: "space-y-3", children: [_jsxs("p", { className: "text-xs text-muted-foreground", children: ["Anyone with the link can view this query's results (read-only, no login). The SQL is frozen \u2014 they can re-run and export but not edit. Only ", _jsx("strong", { children: "SELECT" }), " queries can be shared."] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium", children: "Title (optional)" }), _jsx(Input, { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Monthly active users" })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium", children: "Expires" }), _jsxs(Select, { value: expiresInDays, onValueChange: setExpiresInDays, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "1", children: "In 1 day" }), _jsx(SelectItem, { value: "7", children: "In 7 days" }), _jsx(SelectItem, { value: "30", children: "In 30 days" }), _jsx(SelectItem, { value: "never", children: "Never" })] })] })] })] })) : (_jsxs("div", { className: "space-y-2", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "Link copied to clipboard:" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Input, { readOnly: true, value: link, className: "font-mono text-xs", onFocus: (e) => e.target.select() }), _jsx(Button, { size: "sm", variant: "outline", onClick: () => {
                                        navigator.clipboard.writeText(link);
                                        toast.success("Copied");
                                    }, children: "Copy" })] })] })), _jsx(DialogFooter, { children: !link ? (_jsxs(_Fragment, { children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsxs(Button, { onClick: () => create.mutate(), disabled: create.isPending || !sql.trim(), children: [create.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Create link"] })] })) : (_jsx(Button, { onClick: onClose, children: "Done" })) })] }) }));
}
function InsightsPanel({ insights, }) {
    return (_jsxs("div", { className: "h-full overflow-auto p-4 space-y-4", children: [insights.suggestions.length === 0 && insights.findings.length === 0 && (_jsx("div", { className: "rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground", children: "No obvious performance issues found in the plan." })), insights.suggestions.length > 0 && (_jsxs("section", { children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: "Suggested indexes" }), _jsx("div", { className: "space-y-2", children: insights.suggestions.map((s, i) => (_jsxs("div", { className: "rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2", children: [_jsxs("div", { className: "text-sm font-medium", children: [s.table, " (", s.columns.join(", "), ")"] }), _jsx("p", { className: "text-xs text-muted-foreground", children: s.reason }), _jsxs("div", { className: "relative", children: [_jsx("pre", { className: "rounded bg-background p-2 text-xs font-mono overflow-x-auto", children: s.sql }), _jsx("button", { type: "button", onClick: () => {
                                                navigator.clipboard.writeText(s.sql).then(() => toast.success("Copied"), () => toast.error("Copy failed"));
                                            }, className: "absolute top-1 right-1 text-[10px] rounded bg-muted px-1.5 py-0.5 hover:bg-accent", children: "Copy" })] })] }, i))) }), _jsx("p", { className: "text-[11px] text-muted-foreground mt-2", children: "These are heuristics from the query plan. Always review and test on a staging copy \u2014 a wrong index can slow writes without helping reads." })] })), insights.findings.length > 0 && (_jsxs("section", { children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: "Plan findings" }), _jsx("div", { className: "space-y-1.5", children: insights.findings.map((f, i) => (_jsxs("div", { className: "rounded-md border p-3 " +
                                (f.severity === "error"
                                    ? "border-destructive/40 bg-destructive/5"
                                    : f.severity === "warn"
                                        ? "border-amber-500/40 bg-amber-500/5"
                                        : "border-border bg-card"), children: [_jsx("div", { className: "text-sm font-medium", children: f.title }), _jsx("p", { className: "text-xs text-muted-foreground mt-0.5", children: f.detail })] }, i))) })] }))] }));
}
