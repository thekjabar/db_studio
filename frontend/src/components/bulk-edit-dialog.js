import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/ui/number-input";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";
function kindOf(dataType) {
    const t = dataType.toLowerCase();
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
    return "text";
}
export function BulkEditDialog({ open, onOpenChange, connectionId, schema, table, columns, pks, onApplied }) {
    // Editable cols — no PK, no identity (those identify the row).
    const editableCols = columns.filter((c) => !c.isPrimaryKey && !c.isIdentity);
    const [colName, setColName] = useState("");
    const [raw, setRaw] = useState("");
    const [setNull, setSetNull] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open)
            return;
        setColName(editableCols[0]?.name ?? "");
        setRaw("");
        setSetNull(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    const col = editableCols.find((c) => c.name === colName);
    const kind = col ? kindOf(col.dataType) : "text";
    const parse = () => {
        if (setNull)
            return { ok: true, value: null };
        try {
            if (kind === "number") {
                if (raw === "")
                    return { ok: false, error: "Enter a value" };
                const n = Number(raw);
                if (!Number.isFinite(n))
                    return { ok: false, error: "Not a number" };
                return { ok: true, value: n };
            }
            if (kind === "bool")
                return { ok: true, value: raw === "true" };
            if (kind === "json") {
                if (raw.trim() === "")
                    return { ok: true, value: null };
                return { ok: true, value: JSON.parse(raw) };
            }
            return { ok: true, value: raw };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    };
    const apply = async () => {
        if (!col)
            return;
        const parsed = parse();
        if (!parsed.ok) {
            toast.error(parsed.error);
            return;
        }
        setBusy(true);
        try {
            const r = await api.bulkUpdateRows(connectionId, table, {
                schema,
                pks,
                values: { [col.name]: parsed.value },
            });
            toast.success(`Updated ${r.affectedRows} row${r.affectedRows === 1 ? "" : "s"}`);
            onApplied();
            onOpenChange(false);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setBusy(false);
        }
    };
    const renderInput = () => {
        if (setNull) {
            return _jsx(Input, { value: "NULL", disabled: true, className: "font-mono italic text-muted-foreground" });
        }
        if (kind === "bool") {
            return (_jsxs(Select, { value: raw, onValueChange: setRaw, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "\u2014" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "true", children: "TRUE" }), _jsx(SelectItem, { value: "false", children: "FALSE" })] })] }));
        }
        if (kind === "number") {
            const integer = !!col && /int|serial/.test(col.dataType.toLowerCase());
            return _jsx(NumberInput, { value: raw, onChange: setRaw, integer: integer });
        }
        if (kind === "date")
            return _jsx(DatePicker, { value: raw, onChange: setRaw });
        if (kind === "datetime")
            return _jsx(DateTimePicker, { value: raw, onChange: setRaw });
        if (kind === "json")
            return _jsx(Textarea, { value: raw, onChange: (e) => setRaw(e.target.value), rows: 6, className: "font-mono text-xs" });
        return _jsx(Input, { value: raw, onChange: (e) => setRaw(e.target.value) });
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !busy && onOpenChange(v), children: _jsxs(DialogContent, { className: "max-w-md", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: ["Bulk edit ", _jsx("span", { className: "font-mono text-primary", children: pks.length }), " row", pks.length === 1 ? "" : "s"] }), _jsx(DialogDescription, { children: "Set one column to the same value on every selected row. Primary key columns are excluded." })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Column" }), _jsxs(Select, { value: colName, onValueChange: setColName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { className: "max-h-72", children: editableCols.map((c) => (_jsxs(SelectItem, { value: c.name, children: [_jsx("span", { className: "font-mono", children: c.name }), _jsx("span", { className: "ml-2 text-muted-foreground text-[10px]", children: c.dataType })] }, c.name))) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "New value" }), renderInput(), col?.nullable && (_jsxs("label", { className: "flex items-center gap-2 text-xs text-muted-foreground cursor-pointer", children: [_jsx("input", { type: "checkbox", checked: setNull, onChange: (e) => setSetNull(e.target.checked), className: "accent-brand" }), "Set NULL instead"] }))] })] }), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), disabled: busy, children: "Cancel" }), _jsxs(Button, { onClick: apply, disabled: busy || !colName, children: [busy && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Apply to ", pks.length] })] })] }) }));
}
