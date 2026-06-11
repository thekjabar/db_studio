import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Editor from "@monaco-editor/react";
import { ArrowDown, ArrowLeft, ArrowUp, BookOpen, Code2, Eye, FileText, Loader2, Play, PlayCircle, Plus, Trash2, } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
function randomCellId() {
    return ("c_" +
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 6));
}
export default function NotebookDetailRoute() {
    const { id } = useParams();
    const nav = useNavigate();
    const qc = useQueryClient();
    const modal = useModal();
    const nbQ = useQuery({
        queryKey: ["notebook", id],
        queryFn: () => api.getNotebook(id),
        enabled: !!id,
    });
    // Local editable copy of cells + metadata. We mirror server state on load
    // and auto-save with a short debounce so rapid edits don't storm the API.
    const [cells, setCells] = useState([]);
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [saving, setSaving] = useState(false);
    const [runs, setRuns] = useState({});
    const seededFor = useRef(null);
    // Seed local state once when the notebook first loads. Avoids clobbering
    // user edits if the server sends a refetched payload.
    useEffect(() => {
        if (!nbQ.data)
            return;
        if (seededFor.current === nbQ.data.id)
            return;
        seededFor.current = nbQ.data.id;
        setName(nbQ.data.name);
        setDescription(nbQ.data.description ?? "");
        setCells(nbQ.data.cells);
    }, [nbQ.data]);
    const saveTimer = useRef(null);
    const persist = useCallback((patch) => {
        if (!id)
            return;
        if (saveTimer.current)
            clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
            setSaving(true);
            try {
                await api.updateNotebook(id, patch);
                qc.invalidateQueries({ queryKey: ["notebooks"] });
            }
            catch (err) {
                toast.error(extractErrorMessage(err));
            }
            finally {
                setSaving(false);
            }
        }, 600);
    }, [id, qc]);
    const updateCells = (next) => {
        setCells(next);
        persist({ cells: next });
    };
    const del = useMutation({
        mutationFn: () => api.deleteNotebook(id),
        onSuccess: () => {
            toast.success("Deleted");
            nav("/notebooks");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const runCell = async (cell) => {
        if (cell.kind !== "sql" || !cell.source.trim() || !nbQ.data)
            return;
        setRuns((r) => ({ ...r, [cell.id]: { status: "running" } }));
        try {
            const res = await api.runQuery(nbQ.data.connectionId, {
                sql: cell.source,
                maxRows: 1000,
            });
            setRuns((r) => ({ ...r, [cell.id]: { status: "ok", result: res, at: Date.now() } }));
        }
        catch (err) {
            setRuns((r) => ({
                ...r,
                [cell.id]: { status: "error", message: extractErrorMessage(err), at: Date.now() },
            }));
        }
    };
    const runAll = async () => {
        for (const c of cells) {
            if (c.kind === "sql") {
                // Sequential — a later cell might depend on a prior DDL committing.
                await runCell(c);
            }
        }
    };
    const move = (index, delta) => {
        const ni = index + delta;
        if (ni < 0 || ni >= cells.length)
            return;
        const next = [...cells];
        [next[index], next[ni]] = [next[ni], next[index]];
        updateCells(next);
    };
    const removeCell = (cellId) => {
        updateCells(cells.filter((c) => c.id !== cellId));
        setRuns((r) => {
            const { [cellId]: _, ...rest } = r;
            return rest;
        });
    };
    const insertCell = (after, kind) => {
        const next = [...cells];
        next.splice(after + 1, 0, {
            id: randomCellId(),
            kind,
            source: kind === "md" ? "## Heading\n\nExplain what this section does." : "SELECT 1;",
        });
        updateCells(next);
    };
    const updateCell = (cellId, patch) => {
        const next = cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c));
        updateCells(next);
    };
    if (nbQ.isLoading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    if (!nbQ.data)
        return _jsx("div", { className: "p-8 text-destructive", children: "Notebook not found." });
    return (_jsxs("div", { className: "min-h-screen bg-background", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3 min-w-0 flex-1", children: [_jsx("button", { type: "button", onClick: () => nav("/notebooks"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0", children: _jsx(ArrowLeft, { className: "h-4 w-4" }) }), _jsx("div", { className: "h-4 w-px bg-border shrink-0" }), _jsx(BookOpen, { className: "h-5 w-5 text-primary shrink-0" }), _jsx("input", { value: name, onChange: (e) => {
                                    setName(e.target.value);
                                    persist({ name: e.target.value });
                                }, className: "bg-transparent border-none outline-none font-semibold text-sm flex-1 min-w-0", placeholder: "Untitled notebook", maxLength: 120 }), _jsx("span", { className: "text-[11px] text-muted-foreground shrink-0", children: saving ? "Saving…" : "Saved" })] }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: runAll, children: [_jsx(PlayCircle, { className: "h-3.5 w-3.5" }), " Run all"] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: async () => {
                                    const ok = await modal.confirm({
                                        title: `Delete "${nbQ.data.name}"?`,
                                        description: "Cells are removed with it.",
                                        confirmLabel: "Delete",
                                        destructive: true,
                                    });
                                    if (ok)
                                        del.mutate();
                                }, className: "text-destructive hover:text-destructive", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }), _jsxs("div", { className: "max-w-4xl mx-auto px-6 py-6 space-y-3", children: [_jsx(Input, { value: description, onChange: (e) => {
                            setDescription(e.target.value);
                            persist({ description: e.target.value || null });
                        }, placeholder: "Short description (optional)", className: "text-sm", maxLength: 500 }), cells.map((c, i) => (_jsx(CellBlock, { cell: c, index: i, last: i === cells.length - 1, run: runs[c.id], onRun: () => runCell(c), onMoveUp: () => move(i, -1), onMoveDown: () => move(i, 1), onRemove: () => removeCell(c.id), onInsertBelow: (kind) => insertCell(i, kind), onUpdate: (patch) => updateCell(c.id, patch) }, c.id))), cells.length === 0 && (_jsxs("div", { className: "flex items-center justify-center gap-2 py-8", children: [_jsxs(Button, { variant: "outline", onClick: () => insertCell(-1, "md"), children: [_jsx(FileText, { className: "h-3.5 w-3.5" }), " Add markdown cell"] }), _jsxs(Button, { onClick: () => insertCell(-1, "sql"), children: [_jsx(Code2, { className: "h-3.5 w-3.5" }), " Add SQL cell"] })] }))] })] }));
}
function CellBlock({ cell, index, last, run, onRun, onMoveUp, onMoveDown, onRemove, onInsertBelow, onUpdate, }) {
    const isDark = useTheme((s) => s.theme === "dark");
    const [mdPreview, setMdPreview] = useState(cell.kind === "md");
    // Always preview MD cells by default; editing toggles to raw.
    useEffect(() => {
        setMdPreview(cell.kind === "md");
    }, [cell.id, cell.kind]);
    const rendered = useMemo(() => (cell.kind === "md" ? renderMarkdown(cell.source) : ""), [cell.kind, cell.source]);
    return (_jsxs("div", { className: "rounded-md border border-border bg-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center gap-2 px-2 py-1 border-b border-border text-[11px] text-muted-foreground", children: [_jsxs("span", { className: "font-mono", children: ["[", index + 1, "]"] }), _jsx("span", { className: "uppercase tracking-wider", children: cell.kind }), cell.kind === "md" && (_jsxs("button", { onClick: () => setMdPreview((v) => !v), className: "ml-1 text-muted-foreground hover:text-foreground inline-flex items-center gap-1", children: [_jsx(Eye, { className: "h-3 w-3" }), mdPreview ? "Edit" : "Preview"] })), _jsxs("div", { className: "ml-auto flex items-center gap-0.5", children: [cell.kind === "sql" && (_jsx("button", { onClick: onRun, disabled: run?.status === "running", className: "p-1 rounded hover:bg-primary/10 text-primary", title: "Run cell", children: run?.status === "running" ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(Play, { className: "h-3.5 w-3.5" })) })), _jsx("button", { onClick: onMoveUp, disabled: index === 0, className: "p-1 rounded hover:bg-accent disabled:opacity-30", children: _jsx(ArrowUp, { className: "h-3 w-3" }) }), _jsx("button", { onClick: onMoveDown, disabled: last, className: "p-1 rounded hover:bg-accent disabled:opacity-30", children: _jsx(ArrowDown, { className: "h-3 w-3" }) }), _jsx("button", { onClick: onRemove, className: "p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] })] }), cell.kind === "md" ? (mdPreview ? (_jsx("div", { className: "prose prose-sm max-w-none dark:prose-invert p-4", dangerouslySetInnerHTML: { __html: rendered } })) : (_jsx(Textarea, { value: cell.source, onChange: (e) => onUpdate({ source: e.target.value }), className: "border-0 rounded-none font-mono text-sm focus-visible:ring-0", rows: Math.max(4, cell.source.split("\n").length + 1), placeholder: "Write markdown \u2014 # headings, **bold**, `code`, etc." }))) : (_jsx("div", { className: "h-40 border-b border-border", children: _jsx(Editor, { height: "100%", defaultLanguage: "sql", theme: isDark ? "vs-dark" : "vs", value: cell.source, onChange: (v) => onUpdate({ source: v ?? "" }), options: {
                        minimap: { enabled: false },
                        fontSize: 12,
                        fontFamily: "JetBrains Mono, monospace",
                        tabSize: 2,
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                    } }) })), cell.kind === "sql" && run && (_jsxs("div", { className: "border-t border-border", children: [run.status === "error" && (_jsx("div", { className: "p-3 text-xs text-destructive font-mono whitespace-pre-wrap", children: run.message })), run.status === "ok" && _jsx(CellResult, { result: run.result }), run.status === "running" && (_jsxs("div", { className: "p-3 text-xs text-muted-foreground inline-flex items-center gap-1", children: [_jsx(Loader2, { className: "h-3 w-3 animate-spin" }), " Running\u2026"] }))] })), _jsxs("div", { className: "flex items-center justify-center gap-1 py-1 border-t border-border bg-background", children: [_jsxs("button", { onClick: () => onInsertBelow("md"), className: "text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent", children: [_jsx(Plus, { className: "h-3 w-3" }), " ", _jsx(FileText, { className: "h-3 w-3" }), " Markdown"] }), _jsxs("button", { onClick: () => onInsertBelow("sql"), className: "text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent", children: [_jsx(Plus, { className: "h-3 w-3" }), " ", _jsx(Code2, { className: "h-3 w-3" }), " SQL"] })] })] }));
}
function CellResult({ result }) {
    const cols = result.fields.map((f) => f.name);
    const rowCount = result.rowCount ?? result.rows.length;
    return (_jsxs("div", { children: [_jsxs("div", { className: "px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border", children: [rowCount, " row", rowCount === 1 ? "" : "s", " \u00B7 ", result.durationMs, "ms"] }), _jsxs("div", { className: "overflow-auto max-h-80", children: [_jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { className: "sticky top-0 bg-card z-10", children: _jsx("tr", { children: cols.map((c) => (_jsx("th", { className: "text-left px-2 py-1 font-medium text-muted-foreground border-b border-border", children: c }, c))) }) }), _jsx("tbody", { children: result.rows.slice(0, 200).map((r, i) => (_jsx("tr", { className: cn("border-b border-border last:border-b-0"), children: cols.map((c) => (_jsx("td", { className: "px-2 py-1 font-mono", children: formatCell(r[c]) }, c))) }, i))) })] }), result.rows.length > 200 && (_jsx("div", { className: "px-3 py-1 text-[10px] text-muted-foreground", children: "Showing first 200 rows." }))] })] }));
}
function formatCell(v) {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "object")
        return JSON.stringify(v);
    return String(v);
}
