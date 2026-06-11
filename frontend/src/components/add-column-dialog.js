import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { api } from "@/lib/api";
import { ColumnTypeSelect } from "@/components/column-type-select";
const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];
export function AddColumnDialog({ connectionId, schema, table, open, onOpenChange, onSaved }) {
    const [name, setName] = useState("");
    const [comment, setComment] = useState("");
    const [baseType, setBaseType] = useState("");
    const [isArray, setIsArray] = useState(false);
    const [defaultValue, setDefaultValue] = useState("");
    const [isPrimaryKey, setIsPrimaryKey] = useState(false);
    const [nullable, setNullable] = useState(true);
    const [isUnique, setIsUnique] = useState(false);
    const [check, setCheck] = useState("");
    const [fks, setFks] = useState([]);
    const [previewSql, setPreviewSql] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open)
            return;
        setName("");
        setComment("");
        setBaseType("");
        setIsArray(false);
        setDefaultValue("");
        setIsPrimaryKey(false);
        setNullable(true);
        setIsUnique(false);
        setCheck("");
        setFks([]);
        setPreviewSql(null);
        setError(null);
    }, [open]);
    // Need to know other tables in the schema for FK picker
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schema],
        queryFn: () => api.listTables(connectionId, schema),
        enabled: open && fks.length > 0,
    });
    const buildSpec = () => {
        if (!name.trim()) {
            setError("Column name is required.");
            return null;
        }
        if (!baseType) {
            setError("Choose a column type.");
            return null;
        }
        const type = isArray ? `${baseType}[]` : baseType;
        const defaultTrim = defaultValue.trim();
        let defValue = null;
        let defIsExpr = false;
        if (defaultTrim) {
            // Supabase convention: "(expr)" means expression, otherwise literal.
            if (defaultTrim.startsWith("(") && defaultTrim.endsWith(")")) {
                defValue = defaultTrim.slice(1, -1);
                defIsExpr = true;
            }
            else {
                defValue = defaultTrim;
            }
        }
        return {
            name: name.trim(),
            type,
            nullable: !isPrimaryKey && nullable,
            primaryKey: isPrimaryKey,
            unique: isUnique,
            default: defValue,
            defaultIsExpression: defIsExpr || undefined,
            check: check.trim() || null,
            comment: comment.trim() || null,
        };
    };
    const buildRequest = (confirm) => {
        const spec = buildSpec();
        if (!spec)
            return null;
        const fkSpecs = fks
            .filter((f) => f.refTable && f.refColumn)
            .map((f) => ({
            columns: [spec.name],
            refSchema: f.refSchema || schema,
            refTable: f.refTable,
            refColumns: [f.refColumn],
            onDelete: f.onDelete || undefined,
            onUpdate: f.onUpdate || undefined,
        }));
        return {
            schema,
            name: table,
            addColumns: [spec],
            addForeignKeys: fkSpecs.length ? fkSpecs : undefined,
            confirm,
        };
    };
    const doPreview = async () => {
        setError(null);
        const req = buildRequest(false);
        if (!req)
            return;
        setBusy(true);
        try {
            const r = await api.alterTable(connectionId, req);
            setPreviewSql(r.preview);
        }
        catch (err) {
            const msg = err?.response?.data?.message;
            setError(Array.isArray(msg) ? msg.join("; ") : msg || "Failed to build preview");
        }
        finally {
            setBusy(false);
        }
    };
    const doSave = async () => {
        setError(null);
        const req = buildRequest(true);
        if (!req)
            return;
        setBusy(true);
        try {
            await api.alterTable(connectionId, req);
            onSaved(name);
            onOpenChange(false);
        }
        catch (err) {
            const msg = err?.response?.data?.message;
            setError(Array.isArray(msg) ? msg.join("; ") : msg || "Failed to apply change");
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "max-w-2xl max-h-[85vh] overflow-y-auto", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: ["Add new column to ", _jsx("span", { className: "font-mono", children: table })] }), _jsxs(DialogDescription, { children: ["Column is applied with ", _jsx("code", { children: "ALTER TABLE" }), ". Use Preview to see the generated SQL first."] })] }), _jsxs("div", { className: "grid grid-cols-[140px_1fr] gap-x-6 gap-y-5", children: [_jsx("div", { className: "text-sm font-semibold pt-1", children: "General" }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: "column_name" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Recommended to use lowercase and underscores \u2014 e.g. ", _jsx("code", { children: "column_name" })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs(Label, { className: "flex justify-between", children: [_jsx("span", { children: "Description" }), _jsx("span", { className: "text-xs text-muted-foreground", children: "Optional" })] }), _jsx(Input, { value: comment, onChange: (e) => setComment(e.target.value) })] })] }), _jsx("div", { className: "text-sm font-semibold pt-1", children: "Data Type" }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Type" }), _jsx(ColumnTypeSelect, { value: baseType, onChange: setBaseType })] }), _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Switch, { checked: isArray, onCheckedChange: setIsArray }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Define as Array" }), _jsxs("div", { className: "text-xs text-muted-foreground", children: ["Allow column to be defined as a variable-length array (e.g. ", _jsx("code", { children: "text[]" }), ")"] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Default Value" }), _jsx(Input, { value: defaultValue, onChange: (e) => setDefaultValue(e.target.value), placeholder: "NULL" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: ["Can be a literal or an expression. Wrap expressions in brackets \u2014 e.g.", " ", _jsx("code", { children: "(gen_random_uuid())" })] })] })] }), _jsx("div", { className: "text-sm font-semibold pt-1", children: "Foreign Keys" }), _jsxs("div", { className: "space-y-3", children: [fks.map((fk, i) => (_jsxs("div", { className: "rounded-md border border-border p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "text-xs font-medium", children: ["FK #", i + 1] }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-6 w-6", onClick: () => setFks((xs) => xs.filter((_, j) => j !== i)), children: _jsx(X, { className: "h-3.5 w-3.5" }) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-xs", children: "Referenced table" }), _jsxs(Select, { value: fk.refTable, onValueChange: (v) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, refTable: v, refColumn: "" } : x))), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Choose table..." }) }), _jsx(SelectContent, { className: "max-h-64", children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, children: t.name }, `${t.schema}.${t.name}`))) })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-xs", children: "Referenced column" }), _jsx(Input, { value: fk.refColumn, onChange: (e) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, refColumn: e.target.value } : x))), placeholder: "id" })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-xs", children: "ON DELETE" }), _jsxs(Select, { value: fk.onDelete, onValueChange: (v) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, onDelete: v } : x))), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "NO ACTION" }) }), _jsx(SelectContent, { children: FK_ACTIONS.map((a) => (_jsx(SelectItem, { value: a, children: a }, a))) })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-xs", children: "ON UPDATE" }), _jsxs(Select, { value: fk.onUpdate, onValueChange: (v) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, onUpdate: v } : x))), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "NO ACTION" }) }), _jsx(SelectContent, { children: FK_ACTIONS.map((a) => (_jsx(SelectItem, { value: a, children: a }, a))) })] })] })] })] }, i))), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => setFks((xs) => [...xs, { refTable: "", refSchema: schema, refColumn: "", onDelete: "", onUpdate: "" }]), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add foreign key"] })] }), _jsx("div", { className: "text-sm font-semibold pt-1", children: "Constraints" }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Switch, { checked: isPrimaryKey, onCheckedChange: (v) => { setIsPrimaryKey(v); if (v)
                                                setNullable(false); } }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Is Primary Key" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Marks this column as the table's primary key. Implies NOT NULL." })] })] }), _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Switch, { checked: nullable, onCheckedChange: setNullable, disabled: isPrimaryKey }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Allow Nullable" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Allow the column to hold NULL when no value is provided." })] })] }), _jsxs("div", { className: "flex items-start gap-3", children: [_jsx(Switch, { checked: isUnique, onCheckedChange: setIsUnique }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Is Unique" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Enforce that values in this column are unique across rows." })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs(Label, { className: "flex justify-between", children: [_jsx("span", { children: "CHECK Constraint" }), _jsx("span", { className: "text-xs text-muted-foreground", children: "Optional" })] }), _jsx(Input, { value: check, onChange: (e) => setCheck(e.target.value), placeholder: `length("${name || "column_name"}") < 500`, className: "font-mono" })] })] })] }), error && (_jsx("div", { className: "rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2", children: error })), previewSql && (_jsxs("div", { className: "rounded-md border border-border bg-muted", children: [_jsx("div", { className: "px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border", children: "Preview" }), _jsx("pre", { className: "p-3 text-xs font-mono whitespace-pre-wrap", children: previewSql })] })), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), disabled: busy, children: "Cancel" }), _jsx(Button, { variant: "outline", onClick: doPreview, disabled: busy, children: "Preview" }), _jsx(Button, { onClick: doSave, disabled: busy, children: "Save" })] })] }) }));
}
