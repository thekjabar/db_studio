import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import Editor from "@monaco-editor/react";
import { ChevronRight, Home } from "lucide-react";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle, } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme-store";
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function valueAt(root, path) {
    let cur = root;
    for (const key of path) {
        if (cur == null)
            return undefined;
        if (Array.isArray(cur))
            cur = cur[key];
        else if (isObject(cur))
            cur = cur[key];
        else
            return undefined;
    }
    return cur;
}
/** Normalize the incoming value: if it's a string that parses as JSON, use the parsed form. */
function normalize(v) {
    if (typeof v !== "string")
        return v;
    const trimmed = v.trim();
    if (trimmed === "" || trimmed === "null")
        return null;
    if (!/^[\[{"]/.test(trimmed) && !/^(true|false|-?\d)/.test(trimmed))
        return v;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return v;
    }
}
function toPretty(v) {
    const n = normalize(v);
    try {
        return JSON.stringify(n ?? null, null, 2);
    }
    catch {
        return String(n ?? "");
    }
}
export function JsonFieldEditor({ open, fieldName, value, onClose, onSave }) {
    const isDark = useTheme((s) => s.theme === "dark");
    const [mode, setMode] = React.useState("view");
    const [text, setText] = React.useState("");
    const [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [path, setPath] = React.useState([]);
    // Initialise the editor text and reset path when the sheet opens.
    React.useEffect(() => {
        if (!open)
            return;
        setText(toPretty(value));
        setPath([]);
        setMode("edit");
        setError(null);
    }, [open, value]);
    // View-mode needs the live parsed tree. We parse from text in edit mode so
    // the view tab reflects unsaved edits too.
    const parsed = React.useMemo(() => {
        try {
            if (text.trim() === "")
                return { ok: true, value: null };
            return { ok: true, value: JSON.parse(text) };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    }, [text]);
    const save = async () => {
        if (!parsed.ok) {
            setError(parsed.error);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSave(parsed.value);
            onClose();
        }
        catch (e) {
            setError(e.message || "Failed to save");
        }
        finally {
            setBusy(false);
        }
    };
    const format = () => {
        if (!parsed.ok)
            return;
        setText(JSON.stringify(parsed.value, null, 2));
    };
    // --- View tab helpers ---
    const current = parsed.ok ? valueAt(parsed.value, path) : undefined;
    const breadcrumbs = (_jsxs("div", { className: "flex items-center gap-1 text-xs border-b border-border px-3 py-2 bg-muted/30", children: [_jsx("button", { type: "button", onClick: () => setPath([]), className: cn("p-1 rounded hover:bg-accent", path.length === 0 ? "text-foreground" : "text-muted-foreground"), title: "Root", children: _jsx(Home, { className: "h-3.5 w-3.5" }) }), path.map((seg, i) => (_jsxs(React.Fragment, { children: [_jsx(ChevronRight, { className: "h-3 w-3 text-muted-foreground" }), _jsx("button", { type: "button", onClick: () => setPath(path.slice(0, i + 1)), className: cn("font-mono px-1.5 py-0.5 rounded hover:bg-accent", i === path.length - 1 ? "text-foreground" : "text-muted-foreground"), children: String(seg) })] }, i)))] }));
    return (_jsx(Sheet, { open: open, onOpenChange: (v) => !v && !busy && onClose(), children: _jsxs(SheetContent, { width: "w-[780px]", children: [_jsxs(SheetHeader, { className: "flex items-center justify-between flex-row pr-14", children: [_jsxs(SheetTitle, { children: [mode === "edit" ? "Editing" : "Viewing", " JSON Field:", " ", _jsx("code", { className: "font-mono text-primary", children: fieldName })] }), _jsxs("div", { className: "flex rounded-md border border-border overflow-hidden", children: [_jsx("button", { type: "button", onClick: () => setMode("edit"), className: cn("px-3 py-1 text-xs font-medium", mode === "edit" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent"), children: "Edit" }), _jsx("button", { type: "button", onClick: () => setMode("view"), className: cn("px-3 py-1 text-xs font-medium border-l border-border", mode === "view" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent"), children: "View" })] })] }), mode === "edit" ? (_jsxs("div", { className: "flex-1 min-h-0 flex flex-col", children: [_jsx("div", { className: "flex-1 min-h-0", children: _jsx(Editor, { height: "100%", defaultLanguage: "json", theme: isDark ? "vs-dark" : "vs", value: text, onChange: (v) => setText(v ?? ""), options: {
                                    minimap: { enabled: false },
                                    fontSize: 12,
                                    fontFamily: "JetBrains Mono, monospace",
                                    tabSize: 2,
                                    automaticLayout: true,
                                    lineNumbers: "on",
                                    scrollBeyondLastLine: false,
                                } }) }), _jsxs("div", { className: "border-t border-border px-3 py-2 flex items-center justify-between text-xs", children: [_jsx("div", { className: "text-muted-foreground", children: parsed.ok ? (_jsx("span", { className: "text-emerald-400", children: "Valid JSON" })) : (_jsxs("span", { className: "text-destructive", children: ["Invalid: ", parsed.error] })) }), _jsx(Button, { size: "sm", variant: "outline", onClick: format, disabled: !parsed.ok, children: "Format" })] })] })) : (_jsxs("div", { className: "flex-1 min-h-0 flex flex-col", children: [breadcrumbs, _jsx(SheetBody, { className: "py-0 px-0", children: !parsed.ok ? (_jsxs("div", { className: "p-6 text-sm text-destructive", children: ["Invalid JSON: ", parsed.error] })) : (_jsx(ViewPane, { value: current, onDrillIn: (seg) => setPath([...path, seg]) })) })] })), error && (_jsx("div", { className: "mx-6 mb-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2", children: error })), _jsxs(SheetFooter, { children: [_jsx(Button, { variant: "outline", onClick: onClose, disabled: busy, children: "Cancel" }), _jsx(Button, { onClick: save, disabled: busy || !parsed.ok, children: "Save changes" })] })] }) }));
}
function ViewPane({ value, onDrillIn, }) {
    // Leaf: render as single line
    if (value === null || value === undefined) {
        return _jsx("div", { className: "p-6 text-sm text-muted-foreground italic", children: "null" });
    }
    if (typeof value !== "object") {
        return (_jsx("div", { className: "p-6", children: _jsx(ScalarValue, { v: value }) }));
    }
    const entries = Array.isArray(value)
        ? value.map((v, i) => [i, v])
        : Object.entries(value);
    // Split into navigable (object/array children) and primitive leaves.
    const objectEntries = entries.filter(([, v]) => v !== null && typeof v === "object");
    const leafEntries = entries.filter(([, v]) => v === null || typeof v !== "object");
    return (_jsxs("div", { className: "grid grid-cols-[minmax(180px,260px)_1fr] h-full", children: [_jsx("div", { className: "border-r border-border overflow-y-auto py-1", children: objectEntries.length === 0 ? (_jsx("div", { className: "px-4 py-3 text-xs text-muted-foreground italic", children: "No nested objects" })) : (objectEntries.map(([k]) => (_jsxs("button", { type: "button", onClick: () => onDrillIn(k), className: "w-full flex items-center justify-between gap-2 px-4 py-2 text-xs text-sky-400 hover:bg-accent/60 transition-colors", children: [_jsx("span", { className: "font-mono truncate", children: String(k) }), _jsx(ChevronRight, { className: "h-3.5 w-3.5 text-muted-foreground" })] }, String(k))))) }), _jsx("div", { className: "overflow-y-auto py-2 px-4", children: leafEntries.length === 0 ? (_jsx("div", { className: "text-xs text-muted-foreground pt-2", children: "No data available" })) : (_jsx("div", { className: "space-y-1.5", children: leafEntries.map(([k, v]) => (_jsxs("div", { className: "flex items-start gap-2 text-xs font-mono", children: [_jsxs("span", { className: "text-muted-foreground", children: [String(k), ":"] }), _jsx(ScalarValue, { v: v })] }, String(k)))) })) })] }));
}
function ScalarValue({ v }) {
    if (v === null)
        return _jsx("span", { className: "text-muted-foreground italic", children: "null" });
    if (typeof v === "boolean")
        return _jsx("span", { className: "text-emerald-400", children: String(v) });
    if (typeof v === "number")
        return _jsx("span", { className: "text-sky-400", children: String(v) });
    if (typeof v === "string")
        return _jsxs("span", { className: "text-amber-400", children: ["\"", v, "\""] });
    return _jsx("span", { className: "text-muted-foreground", children: JSON.stringify(v) });
}
