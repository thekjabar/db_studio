import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { toast } from "sonner";
import { BarChart3, Download, Loader2, Play, Save, Send, Share2, Sparkles, Trash2 } from "lucide-react";
import { format as formatSql } from "sql-formatter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataGrid } from "@/components/data-grid";
import { ExplainPanel } from "@/components/explain-panel";
import { api, extractErrorMessage } from "@/lib/api";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { AiQueryDialog } from "@/components/ai-query-dialog";
import { SendResultDialog } from "@/components/send-result-dialog";
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
    const [sql, setSql] = useState(() => {
        const urlSql = searchParams.get("sql");
        return urlSql ?? "SELECT 1 AS hello;";
    });
    // Push SQL to URL so it's shareable — debounced so every keystroke isn't a history event.
    // Skip anything over ~1.5KB to keep URLs reasonable (long queries should be Saved instead).
    useEffect(() => {
        const handle = setTimeout(() => {
            const next = new URLSearchParams(searchParams);
            if (sql && sql !== "SELECT 1 AS hello;" && sql.length < 1500)
                next.set("sql", sql);
            else
                next.delete("sql");
            setSearchParams(next, { replace: true });
        }, 400);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sql]);
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
    const ctx = useOutletContext();
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
    // Keep a ref to the current run-callback so the Monaco command (bound once
    // on mount) always sees the latest `sql` without needing to re-bind.
    const runRef = useRef(() => { });
    runRef.current = () => {
        if (!run.isPending && sql.trim())
            run.mutate({ sql });
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
    const exportCsv = () => {
        if (!result)
            return;
        const cols = result.fields.map((c) => c.name);
        const csv = [
            cols.join(","),
            ...result.rows.map((r) => cols.map((c) => {
                const v = r[c];
                if (v === null || v === undefined)
                    return "";
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
    return (_jsxs("div", { className: "h-full flex", children: [_jsxs("aside", { className: "w-56 shrink-0 border-r border-border bg-card flex flex-col", children: [_jsx("div", { className: "px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-b border-border", children: "Saved queries" }), _jsxs("div", { className: "flex-1 overflow-auto p-1", children: [savedQ.isLoading && _jsx("div", { className: "p-2 text-xs text-muted-foreground", children: "Loading..." }), savedQ.data?.length === 0 && (_jsxs("div", { className: "p-3 text-[11px] text-muted-foreground text-center", children: ["No saved queries. Click ", _jsx("span", { className: "font-medium text-foreground", children: "Save" }), " to keep one."] })), savedQ.data?.map((q) => (_jsxs("div", { className: "group flex items-center gap-1 px-2 py-1 rounded hover:bg-accent", children: [_jsx("button", { onClick: () => setSql(q.sqlText), className: "flex-1 text-left text-xs truncate", children: q.name }), _jsx("button", { onClick: async () => {
                                            const ok = await modal.confirm({
                                                title: `Delete "${q.name}"?`,
                                                description: "This removes the saved query.",
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                delSaved.mutate(q.id);
                                        }, className: "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] }, q.id)))] }), _jsxs("div", { className: "px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-t border-b border-border flex items-center justify-between", children: [_jsx("span", { children: "History" }), history.length > 0 && (_jsx("button", { type: "button", onClick: clearHistory, className: "text-[10px] normal-case text-muted-foreground/70 hover:text-destructive", children: "Clear" }))] }), _jsxs("div", { className: "flex-1 overflow-auto p-1", children: [history.length === 0 && _jsx("div", { className: "p-2 text-xs text-muted-foreground", children: "No history yet" }), history.map((h, i) => (_jsx("button", { onClick: () => setSql(h.sql), className: "block w-full text-left px-2 py-1 rounded hover:bg-accent text-xs font-mono truncate", title: h.sql, children: h.sql.split("\n")[0].slice(0, 30) }, i)))] })] }), _jsxs("div", { className: "flex-1 flex flex-col min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 px-4 py-2 border-b border-border", children: [_jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsxs(Button, { size: "sm", onClick: async () => {
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
                                            run.mutate({ sql });
                                        }, disabled: run.isPending || !sql.trim(), children: [run.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Play, { className: "h-3.5 w-3.5" }), "Run", _jsx("kbd", { className: "ml-1 rounded border border-border bg-background/30 px-1 text-[10px]", children: "Ctrl \u21B5" })] }), _jsxs("div", { className: "flex items-center gap-1.5 text-xs text-muted-foreground", children: [_jsx("span", { children: "Limit" }), _jsxs(Select, { value: String(maxRows), onValueChange: (v) => setMaxRows(parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "h-7 w-28 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "100", children: "100" }), _jsx(SelectItem, { value: "500", children: "500" }), _jsx(SelectItem, { value: "1000", children: "1,000" }), _jsx(SelectItem, { value: "5000", children: "5,000" }), _jsx(SelectItem, { value: "10000", children: "10,000" }), _jsx(SelectItem, { value: "0", children: "No cap" })] })] })] })] }), _jsx("div", { className: "h-6 w-px bg-border shrink-0 mx-1" }), _jsxs("div", { className: "flex items-center gap-2 min-w-0 flex-1 overflow-x-auto sql-toolbar-scroll [&>*]:shrink-0 whitespace-nowrap", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: () => setAiOpen(true), children: [_jsx(Sparkles, { className: "h-3.5 w-3.5" }), " Ask AI"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => formatRef.current(), children: ["Format", _jsx("kbd", { className: "ml-1 rounded border border-border bg-background/30 px-1 text-[10px]", children: "Shift \u2325 F" })] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => sql.trim() && explainMut.mutate({ sql, mode: "plan" }), disabled: explainMut.isPending || !sql.trim(), title: "Show plan without running", children: [explainMut.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(BarChart3, { className: "h-3.5 w-3.5" }), "Explain"] }), _jsx(Button, { size: "sm", variant: "outline", onClick: async () => {
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
                                                        : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"), title: estimate.warnings.join(" · ") || "No warnings", children: ["~", estimate.estimatedRowsScanned.toLocaleString(), " rows"] })), _jsxs(Button, { size: "sm", variant: "outline", onClick: doSave, children: [_jsx(Save, { className: "h-3.5 w-3.5" }), " Save"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => {
                                            navigator.clipboard.writeText(window.location.href).then(() => toast.success("Link copied"), () => toast.error("Copy failed"));
                                        }, title: "Copy shareable link (embeds the current SQL if short)", children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Share"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: exportCsv, disabled: !result, children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " CSV"] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => setSendOpen(true), disabled: !sql.trim(), title: "Send result to email / Slack / webhook", children: [_jsx(Send, { className: "h-3.5 w-3.5" }), " Send"] }), result && (_jsxs("span", { className: "ml-auto text-xs font-mono " +
                                            (result.truncated ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"), children: [result.truncated ? `${result.rowCount}+ rows (capped)` : `${result.rowCount ?? result.rows.length} rows`, " \u00B7", " ", result.durationMs, "ms"] }))] })] }), _jsx("div", { className: "h-2/5 min-h-45 border-b border-border", children: _jsx(Editor, { height: "100%", defaultLanguage: "sql", theme: isDark ? "vs-dark" : "vs", value: sql, onChange: (v) => setSql(v ?? ""), onMount: (editor, monaco) => {
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
                            } }) }), _jsxs("div", { className: "flex-1 min-h-0 flex flex-col", children: [(result || explainResult || insights) && (_jsxs("div", { className: "flex items-center gap-1 border-b border-border px-2", children: [_jsxs("button", { type: "button", onClick: () => setResultTab("data"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                            (resultTab === "data"
                                                ? "border-primary text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"), children: ["Data ", result ? `(${result.rowCount ?? result.rows.length})` : ""] }), _jsxs("button", { type: "button", onClick: () => setResultTab("plan"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                            (resultTab === "plan"
                                                ? "border-primary text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"), disabled: !explainResult, children: ["Plan", explainResult && explainResult.warnings.length > 0 && (_jsx("span", { className: "ml-1 inline-block rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400", children: explainResult.warnings.length }))] }), _jsxs("button", { type: "button", onClick: () => setResultTab("insights"), className: "px-3 py-1.5 text-xs border-b-2 " +
                                            (resultTab === "insights"
                                                ? "border-primary text-foreground"
                                                : "border-transparent text-muted-foreground hover:text-foreground"), disabled: !insights, children: ["Insights", insights && insights.suggestions.length > 0 && (_jsx("span", { className: "ml-1 inline-block rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary", children: insights.suggestions.length }))] })] })), _jsxs("div", { className: "flex-1 min-h-0 flex flex-col", children: [resultTab === "data" && result?.truncated && (_jsx("div", { className: "flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400", children: _jsxs("span", { children: ["Showing first ", _jsx("strong", { children: result.rowCount }), " rows. Real result is larger \u2014 add an explicit ", _jsx("code", { className: "font-mono", children: "LIMIT" }), " to your query, or raise the cap above."] }) })), _jsx("div", { className: "flex-1 min-h-0", children: resultTab === "plan" && explainResult ? (_jsx(ExplainPanel, { result: explainResult })) : resultTab === "insights" && insights ? (_jsx(InsightsPanel, { insights: insights })) : result ? (_jsx(DataGrid, { columns: result.fields.map((c) => ({ name: c.name, type: c.dataType })), rows: result.rows, emptyMessage: "Query returned no rows" })) : (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Run a query to see results." })) })] })] })] }), _jsx(Dialog, { open: !!confirmSql, onOpenChange: (v) => !v && setConfirmSql(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Destructive query detected" }), _jsx(DialogDescription, { children: "This query modifies data without a WHERE clause. Confirm to run." })] }), _jsx("pre", { className: "rounded-md bg-muted p-3 text-xs font-mono overflow-auto max-h-40", children: confirmSql }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: () => setConfirmSql(null), children: "Cancel" }), _jsx(Button, { variant: "destructive", onClick: () => {
                                        if (confirmSql)
                                            run.mutate({ sql: confirmSql, confirmDestructive: true });
                                        setConfirmSql(null);
                                    }, children: "Run anyway" })] })] }) }), _jsx(AiQueryDialog, { open: aiOpen, onOpenChange: setAiOpen, connectionId: id, schema: ctx?.schema, onAccept: (generatedSql) => setSql(generatedSql) }), _jsx(SendResultDialog, { open: sendOpen, onClose: () => setSendOpen(false), connectionId: id, sql: sql })] }));
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
