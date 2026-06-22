import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Edit3, RotateCcw } from "lucide-react";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { NumberInput } from "@/components/ui/number-input";
import { JsonFieldEditor } from "@/components/json-field-editor";
import { ArrayInput } from "@/components/ui/array-input";
import { CommentsPanel } from "@/components/comments-panel";
import { cn } from "@/lib/utils";
import { api, extractErrorMessage } from "@/lib/api";
/** Build the polymorphic comment target key for a specific row. */
function buildRowTarget(schema, table, pk) {
    // Sort PK keys so target is stable regardless of key-insert order.
    const sortedKeys = Object.keys(pk).sort();
    const canonical = {};
    for (const k of sortedKeys)
        canonical[k] = pk[k];
    return `row:${schema}.${table}:${JSON.stringify(canonical)}`;
}
function classifyType(dataType) {
    const t = dataType.toLowerCase();
    // Postgres arrays report as `type[]` or, in some catalogs, `ARRAY`. Anything ending in [] is an array.
    if (t.endsWith("[]") || t === "array")
        return "array";
    if (t.includes("json"))
        return "json";
    if (t === "boolean" || t === "bool")
        return "bool";
    if (/(int|numeric|decimal|real|double|serial|float)/.test(t))
        return "number";
    if (t.startsWith("timestamp"))
        return "datetime";
    if (t === "date")
        return "date";
    if (t === "text" || t.includes("char") && !t.includes("character varying"))
        return "long-text";
    return "text";
}
/** For an array type, return the item kind for ArrayInput. */
function arrayItemKind(dataType) {
    const t = dataType.toLowerCase().replace(/\[\]$/, "");
    if (t === "boolean" || t === "bool")
        return "bool";
    if (/(int|numeric|decimal|real|double|serial|float)/.test(t))
        return "number";
    return "text";
}
function toInputValue(v, kind) {
    if (v === null || v === undefined)
        return "";
    if (kind === "json" && typeof v === "object")
        return JSON.stringify(v, null, 2);
    if (kind === "array") {
        // Normalize whatever the server returned into a JSON array string. pg arrays
        // often arrive as either JS arrays or as Postgres literals like "{a,b}".
        if (Array.isArray(v))
            return JSON.stringify(v);
        if (typeof v === "string") {
            const inner = v.replace(/^\{|\}$/g, "").trim();
            if (!inner)
                return "[]";
            const items = inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
            return JSON.stringify(items);
        }
        return "[]";
    }
    if (kind === "datetime" && typeof v === "string") {
        // Trim trailing Z / timezone into the "yyyy-MM-ddTHH:mm" the picker expects.
        const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
        return m ? `${m[1]}T${m[2]}` : v;
    }
    if (kind === "date" && typeof v === "string") {
        return v.slice(0, 10);
    }
    return String(v);
}
function parseValue(v, kind) {
    if (kind === "number") {
        if (v === "")
            return null;
        const n = Number(v);
        if (!Number.isFinite(n))
            throw new Error("Invalid number");
        return n;
    }
    if (kind === "bool") {
        return v === "true" ? true : v === "false" ? false : null;
    }
    if (kind === "json" || kind === "array") {
        if (v.trim() === "")
            return null;
        try {
            return JSON.parse(v);
        }
        catch {
            throw new Error(kind === "array" ? "Invalid array" : "Invalid JSON");
        }
    }
    return v;
}
export function RowDrawer({ connectionId, schema, table, columns, row, onClose, onSaved }) {
    const isInsert = row === null;
    const [fields, setFields] = useState({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [jsonEditing, setJsonEditing] = useState(null); // column name being edited in the json sheet
    useEffect(() => {
        if (!columns.length)
            return;
        const next = {};
        for (const c of columns) {
            const kind = classifyType(c.dataType);
            if (isInsert) {
                // Insert: start with DEFAULT when a server default exists, else NULL if nullable, else empty VALUE.
                if (c.defaultValue) {
                    next[c.name] = { col: c, state: "DEFAULT", value: "" };
                }
                else if (c.nullable) {
                    next[c.name] = { col: c, state: "NULL", value: "" };
                }
                else {
                    next[c.name] = { col: c, state: "VALUE", value: "" };
                }
            }
            else {
                const v = row[c.name];
                if (v === null || v === undefined) {
                    next[c.name] = { col: c, state: "NULL", value: "" };
                }
                else {
                    next[c.name] = { col: c, state: "VALUE", value: toInputValue(v, kind) };
                }
            }
        }
        setFields(next);
        setError(null);
    }, [columns, row, isInsert]);
    const [required, optional] = useMemo(() => {
        const req = [];
        const opt = [];
        for (const c of columns) {
            if (!c.nullable && c.defaultValue == null)
                req.push(c);
            else
                opt.push(c);
        }
        return [req, opt];
    }, [columns]);
    const buildValues = () => {
        const out = {};
        for (const name in fields) {
            const f = fields[name];
            // Skip identity cols on insert: they're auto-generated.
            if (isInsert && f.col.isIdentity)
                continue;
            // Never send PK columns in UPDATE — they identify the row, not a value to
            // change. Sending them would let the user silently rewrite the id.
            if (!isInsert && f.col.isPrimaryKey)
                continue;
            if (f.state === "DEFAULT")
                continue; // don't send — let the DB default apply
            if (f.state === "NULL")
                out[name] = null;
            else {
                try {
                    out[name] = parseValue(f.value, classifyType(f.col.dataType));
                }
                catch (e) {
                    setError(`${name}: ${e.message}`);
                    return null;
                }
            }
        }
        return out;
    };
    const pkFromRow = () => {
        const pk = {};
        for (const c of columns) {
            if (c.isPrimaryKey && row)
                pk[c.name] = row[c.name];
        }
        return pk;
    };
    const save = async () => {
        setError(null);
        const values = buildValues();
        if (!values)
            return;
        setBusy(true);
        try {
            if (isInsert) {
                await api.insertRow(connectionId, table, { schema, row: values });
                toast.success("Row inserted");
            }
            else {
                const pk = pkFromRow();
                if (Object.keys(pk).length === 0) {
                    setError("This table has no primary key — cannot update in place.");
                    setBusy(false);
                    return;
                }
                await api.updateRow(connectionId, table, { schema, pk, set: values });
                toast.success("Row updated");
            }
            onSaved();
            onClose();
        }
        catch (err) {
            setError(extractErrorMessage(err));
        }
        finally {
            setBusy(false);
        }
    };
    /** A column is read-only in this drawer context (PK in update mode, identity in insert mode). */
    const isLocked = (c) => {
        if (isInsert)
            return !!c.isIdentity;
        return !!c.isPrimaryKey;
    };
    const renderInput = (f) => {
        const kind = classifyType(f.col.dataType);
        const setValue = (v) => setFields((xs) => ({ ...xs, [f.col.name]: { ...xs[f.col.name], state: "VALUE", value: v } }));
        const locked = isLocked(f.col);
        // Only PK/auto-generated columns are truly locked. NULL/DEFAULT fields stay
        // editable — typing into them auto-switches to VALUE state (see setValue),
        // so there's no extra "Enter value" click for the common case of typing.
        const disabled = locked;
        if (kind === "bool") {
            return (_jsxs(Select, { value: f.state === "VALUE" ? f.value : "", onValueChange: setValue, disabled: disabled, children: [_jsx(SelectTrigger, { className: "h-9", children: _jsx(SelectValue, { placeholder: "\u2014" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "true", children: "TRUE" }), _jsx(SelectItem, { value: "false", children: "FALSE" })] })] }));
        }
        if (kind === "array") {
            let items = [];
            if (f.state === "VALUE" && f.value) {
                try {
                    const parsed = JSON.parse(f.value);
                    if (Array.isArray(parsed))
                        items = parsed;
                }
                catch {
                    items = [];
                }
            }
            return (_jsx(ArrayInput, { value: items, onChange: (next) => setValue(JSON.stringify(next)), itemKind: arrayItemKind(f.col.dataType), disabled: disabled, placeholder: f.state === "NULL" ? "NULL" : "Type and press Enter" }));
        }
        if (kind === "json") {
            const raw = f.state === "VALUE" ? f.value : "";
            const preview = raw ? raw.replace(/\s+/g, " ").slice(0, 80) : "";
            return (_jsxs("button", { type: "button", disabled: disabled, onClick: () => setJsonEditing(f.col.name), className: cn("flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm", "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"), children: [_jsx("span", { className: cn("font-mono text-xs truncate", !preview && "text-muted-foreground italic"), children: preview ||
                            (f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : "Empty — click to edit") }), _jsx("span", { className: "text-[10px] text-muted-foreground ml-2 shrink-0", children: "Open editor" })] }));
        }
        if (kind === "long-text") {
            return (_jsx(Textarea, { value: f.state === "VALUE" ? f.value : "", onChange: (e) => setValue(e.target.value), disabled: disabled, placeholder: f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : "", className: "text-sm", rows: 3 }));
        }
        if (kind === "datetime") {
            return (_jsx(DateTimePicker, { value: f.state === "VALUE" ? f.value : "", onChange: setValue, disabled: disabled, placeholder: f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : undefined }));
        }
        if (kind === "date") {
            return (_jsx(DatePicker, { value: f.state === "VALUE" ? f.value : "", onChange: setValue, disabled: disabled, placeholder: f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : undefined }));
        }
        if (kind === "number") {
            const integer = /int|serial/.test(f.col.dataType.toLowerCase());
            return (_jsx(NumberInput, { value: f.state === "VALUE" ? f.value : "", onChange: setValue, disabled: disabled, integer: integer, placeholder: f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : "" }));
        }
        return (_jsx(Input, { value: f.state === "VALUE" ? f.value : "", onChange: (e) => setValue(e.target.value), disabled: disabled, placeholder: f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : "" }));
    };
    const renderField = (c) => {
        const f = fields[c.name];
        if (!f)
            return null;
        return (_jsxs("div", { className: "grid grid-cols-[180px_1fr] gap-4 items-start", children: [_jsxs("div", { className: "pt-1.5", children: [_jsxs("div", { className: "font-mono text-sm", children: [c.name, !c.nullable && _jsx("span", { className: "text-destructive ml-1", children: "*" })] }), _jsx("div", { className: "text-xs text-muted-foreground", children: c.dataType }), c.isPrimaryKey && _jsx("div", { className: "text-[10px] text-amber-400 mt-0.5", children: "PRIMARY KEY" })] }), _jsxs("div", { className: "space-y-1", children: [renderInput(f), isLocked(c) ? (_jsx("div", { className: "text-[11px] text-muted-foreground italic", children: isInsert ? "Auto-generated on insert." : "Primary key — read-only." })) : (_jsxs("div", { className: "flex items-center gap-3 text-[11px] text-muted-foreground", children: [c.nullable && (_jsx("button", { type: "button", className: f.state === "NULL" ? "text-primary" : "hover:text-foreground", onClick: () => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "NULL" } })), children: "Set NULL" })), c.defaultValue && (_jsxs("button", { type: "button", className: f.state === "DEFAULT" ? "text-primary" : "hover:text-foreground", onClick: () => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "DEFAULT" } })), children: [_jsx(RotateCcw, { className: "h-3 w-3 inline mr-1" }), "Default: ", _jsx("span", { className: "font-mono", children: c.defaultValue })] })), f.state !== "VALUE" && (_jsxs("button", { type: "button", className: "hover:text-foreground", onClick: () => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "VALUE" } })), children: [_jsx(Edit3, { className: "h-3 w-3 inline mr-1" }), "Enter value"] }))] }))] })] }, c.name));
    };
    return (_jsxs(Sheet, { open: true, onOpenChange: (v) => !v && onClose(), children: [_jsxs(SheetContent, { width: "w-[560px]", resizable: true, storageKey: "rowDrawerWidth", children: [_jsxs(SheetHeader, { children: [_jsxs(SheetTitle, { children: [isInsert ? "Insert row into" : "Update row from", " ", _jsx("code", { className: "text-primary font-mono", children: table })] }), _jsx(SheetDescription, { children: isInsert
                                    ? "Required fields are marked with *. Optional fields fall back to their default or NULL."
                                    : "Change any field below. Primary key columns are used to identify the row — don't change them unless you mean to." })] }), _jsxs(SheetBody, { className: "space-y-6", children: [required.length > 0 && (_jsxs("div", { className: "space-y-4", children: [_jsx("div", { className: "text-sm font-semibold", children: "Required" }), required.map(renderField)] })), optional.length > 0 && (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-semibold", children: "Optional fields" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "These columns accept NULL or use a default value." })] }), optional.map(renderField)] })), !isInsert && row && (_jsx("div", { className: "space-y-3 pt-4 border-t border-border", children: _jsx(CommentsPanel, { connectionId: connectionId, target: buildRowTarget(schema, table, pkFromRow()), label: "Comments on this row" }) }))] }), error && (_jsx("div", { className: "mx-6 mb-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2", children: error })), _jsxs(SheetFooter, { children: [_jsx(Button, { variant: "outline", onClick: onClose, disabled: busy, children: "Cancel" }), _jsx(Button, { onClick: save, disabled: busy, children: isInsert ? "Insert" : "Save" })] })] }), jsonEditing && (_jsx(JsonFieldEditor, { open: true, fieldName: jsonEditing, value: (() => {
                    const f = fields[jsonEditing];
                    if (!f)
                        return null;
                    if (f.state !== "VALUE" || !f.value)
                        return null;
                    try {
                        return JSON.parse(f.value);
                    }
                    catch {
                        return f.value;
                    }
                })(), onClose: () => setJsonEditing(null), onSave: (next) => {
                    setFields((xs) => ({
                        ...xs,
                        [jsonEditing]: { ...xs[jsonEditing], state: "VALUE", value: JSON.stringify(next, null, 2) },
                    }));
                } }))] }));
}
