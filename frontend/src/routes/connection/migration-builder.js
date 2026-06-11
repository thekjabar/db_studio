import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Copy, FileCode2, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
function renderStepSql(step, dialect) {
    const ident = (s) => {
        if (dialect === "MYSQL")
            return `\`${s}\``;
        if (dialect === "MSSQL")
            return `[${s}]`;
        return `"${s}"`;
    };
    const qt = (s, t) => (dialect === "SQLITE" ? ident(t) : `${ident(s)}.${ident(t)}`);
    switch (step.kind) {
        case "add-column": {
            const parts = [`${ident(step.name)} ${step.type}`];
            if (!step.nullable)
                parts.push("NOT NULL");
            if (step.default)
                parts.push(`DEFAULT ${step.default}`);
            return `ALTER TABLE ${qt(step.schema, step.table)} ADD COLUMN ${parts.join(" ")};`;
        }
        case "drop-column":
            return `ALTER TABLE ${qt(step.schema, step.table)} DROP COLUMN ${ident(step.name)};`;
        case "rename-column":
            return `ALTER TABLE ${qt(step.schema, step.table)} RENAME COLUMN ${ident(step.name)} TO ${ident(step.newName)};`;
        case "create-table": {
            const cols = step.columns.map((c) => {
                const parts = [`  ${ident(c.name)} ${c.type}`];
                if (!c.nullable)
                    parts.push("NOT NULL");
                if (c.pk)
                    parts.push("PRIMARY KEY");
                return parts.join(" ");
            });
            return `CREATE TABLE ${qt(step.schema, step.name)} (\n${cols.join(",\n")}\n);`;
        }
        case "drop-table":
            return `DROP TABLE ${qt(step.schema, step.name)};`;
    }
}
export default function MigrationBuilderRoute() {
    const { id } = useParams();
    const [steps, setSteps] = useState([]);
    const [applying, setApplying] = useState(false);
    const connQ = useQuery({
        queryKey: ["connection", id],
        queryFn: () => api.getConnection(id),
        enabled: !!id,
    });
    const dialect = connQ.data?.dialect ?? "POSTGRES";
    const allSql = steps.map((s) => renderStepSql(s, dialect)).join("\n\n");
    const addStep = (step) => setSteps((s) => [...s, step]);
    const removeStep = (i) => setSteps((s) => s.filter((_, idx) => idx !== i));
    const moveStep = (i, delta) => {
        const j = i + delta;
        if (j < 0 || j >= steps.length)
            return;
        const next = [...steps];
        [next[i], next[j]] = [next[j], next[i]];
        setSteps(next);
    };
    const applyAll = async () => {
        if (steps.length === 0)
            return;
        setApplying(true);
        try {
            for (const step of steps) {
                if (step.kind === "add-column") {
                    await api.alterTable(id, {
                        schema: step.schema,
                        name: step.table,
                        addColumns: [{ name: step.name, type: step.type, nullable: step.nullable, default: step.default ?? null }],
                    });
                }
                else if (step.kind === "drop-column") {
                    await api.alterTable(id, {
                        schema: step.schema,
                        name: step.table,
                        dropColumns: [step.name],
                    });
                }
                else if (step.kind === "rename-column") {
                    await api.alterTable(id, {
                        schema: step.schema,
                        name: step.table,
                        renameColumns: [{ from: step.name, to: step.newName }],
                    });
                }
                else if (step.kind === "create-table") {
                    await api.createTable(id, {
                        schema: step.schema,
                        name: step.name,
                        columns: step.columns.map((c) => ({
                            name: c.name,
                            type: c.type,
                            nullable: c.nullable,
                            primaryKey: c.pk,
                        })),
                    });
                }
                else if (step.kind === "drop-table") {
                    await api.dropTable(id, step.schema, step.name, true);
                }
            }
            toast.success(`Applied ${steps.length} step${steps.length === 1 ? "" : "s"}`);
            setSteps([]);
        }
        catch (err) {
            toast.error(`Failed at step ${steps.length}: ${extractErrorMessage(err)}`);
        }
        finally {
            setApplying(false);
        }
    };
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(FileCode2, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Migration builder" }), _jsxs("div", { className: "ml-auto flex items-center gap-2", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: () => {
                                    navigator.clipboard.writeText(allSql);
                                    toast.success("SQL copied");
                                }, disabled: steps.length === 0, children: [_jsx(Copy, { className: "h-3.5 w-3.5" }), " Copy SQL"] }), _jsxs(Button, { onClick: applyAll, disabled: applying || steps.length === 0, children: [applying && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), "Apply all"] })] })] }), _jsxs("div", { className: "max-w-4xl mx-auto p-4 space-y-4", children: [_jsx(AddStepForm, { connectionId: id, onAdd: addStep, dialect: dialect }), _jsxs("div", { children: [_jsxs("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: ["Staged steps (", steps.length, ")"] }), steps.length === 0 ? (_jsx("div", { className: "rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground", children: "Add steps above. They'll run in order when you Apply." })) : (_jsx("div", { className: "space-y-2", children: steps.map((s, i) => (_jsxs("div", { className: "rounded-md border border-border bg-card p-3", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1 text-xs text-muted-foreground", children: [_jsxs("span", { className: "font-mono", children: ["#", i + 1] }), _jsx("span", { className: "uppercase tracking-wider", children: s.kind }), _jsxs("div", { className: "ml-auto flex items-center gap-1", children: [_jsx("button", { onClick: () => moveStep(i, -1), disabled: i === 0, className: "p-1 rounded hover:bg-accent disabled:opacity-30", children: "\u2191" }), _jsx("button", { onClick: () => moveStep(i, 1), disabled: i === steps.length - 1, className: "p-1 rounded hover:bg-accent disabled:opacity-30", children: "\u2193" }), _jsx("button", { onClick: () => removeStep(i), className: "p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] })] }), _jsx("pre", { className: "text-[11px] font-mono bg-muted p-2 rounded overflow-x-auto", children: renderStepSql(s, dialect) })] }, i))) }))] }), steps.length > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: "Combined SQL" }), _jsx("pre", { className: "rounded-md border border-border bg-card p-3 text-[11px] font-mono overflow-x-auto", children: allSql })] }))] })] }));
}
function AddStepForm({ connectionId, onAdd, dialect, }) {
    const [kind, setKind] = useState("add-column");
    const [schema, setSchema] = useState("");
    const [table, setTable] = useState("");
    const [colName, setColName] = useState("");
    const [colType, setColType] = useState("text");
    const [nullable, setNullable] = useState(false);
    const [renameTo, setRenameTo] = useState("");
    // Live schema/table/column lists from the current connection.
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schema],
        queryFn: () => api.listTables(connectionId, schema),
        enabled: !!schema,
    });
    // Only fetch columns when the step actually references existing ones —
    // skip on `add-column` (user is naming a new column) and `drop-table`.
    const needsExistingColumn = kind === "drop-column" || kind === "rename-column";
    const columnsQ = useQuery({
        queryKey: ["columns", connectionId, schema, table],
        queryFn: () => api.getTableColumns(connectionId, table, schema),
        enabled: !!schema && !!table && needsExistingColumn,
    });
    // Default schema once available.
    useEffect(() => {
        if (!schemasQ.data || schema)
            return;
        if (schemasQ.data.includes("public"))
            setSchema("public");
        else if (schemasQ.data[0])
            setSchema(schemasQ.data[0]);
    }, [schemasQ.data, schema]);
    // Cascade reset.
    useEffect(() => { setTable(""); }, [schema]);
    useEffect(() => { setColName(""); }, [table, kind]);
    const reset = () => {
        setTable("");
        setColName("");
        setRenameTo("");
    };
    const submit = () => {
        if (!schema || !table) {
            toast.error("Schema + table required");
            return;
        }
        if (kind === "add-column" && (!colName || !colType)) {
            toast.error("Column name + type required");
            return;
        }
        if (kind === "drop-column" && !colName) {
            toast.error("Column name required");
            return;
        }
        if (kind === "rename-column" && (!colName || !renameTo)) {
            toast.error("Old + new column names required");
            return;
        }
        if (kind === "add-column")
            onAdd({ kind, schema, table, name: colName, type: colType, nullable });
        else if (kind === "drop-column")
            onAdd({ kind, schema, table, name: colName });
        else if (kind === "rename-column")
            onAdd({ kind, schema, table, name: colName, newName: renameTo });
        else if (kind === "drop-table")
            onAdd({ kind, schema, name: table });
        reset();
    };
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 space-y-3", children: [_jsxs("div", { className: "text-xs text-muted-foreground", children: ["Adding to a ", _jsx("span", { className: "font-mono", children: dialect }), " connection"] }), _jsxs("div", { className: "grid grid-cols-[160px_1fr_1fr_auto] gap-2 items-end", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Step type" }), _jsxs(Select, { value: kind, onValueChange: (v) => setKind(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "add-column", children: "Add column" }), _jsx(SelectItem, { value: "drop-column", children: "Drop column" }), _jsx(SelectItem, { value: "rename-column", children: "Rename column" }), _jsx(SelectItem, { value: "drop-table", children: "Drop table" })] })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Schema" }), _jsxs(Select, { value: schema, onValueChange: setSchema, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: schemasQ.isLoading ? "Loading…" : "Pick a schema" }) }), _jsx(SelectContent, { children: (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, className: "font-mono", children: s }, s))) })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: kind === "drop-table" ? "Table to drop" : "Table" }), _jsxs(Select, { value: table, onValueChange: setTable, disabled: !schema, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !schema ? "Pick schema first" :
                                                tablesQ.isLoading ? "Loading…" :
                                                    tablesQ.data?.length === 0 ? "No tables" :
                                                        "Pick a table" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, className: "font-mono", children: t.name }, t.name))) })] })] }), _jsxs(Button, { onClick: submit, children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Stage"] })] }), (kind === "add-column" || kind === "drop-column" || kind === "rename-column") && (_jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Column" }), needsExistingColumn ? (_jsxs(Select, { value: colName, onValueChange: setColName, disabled: !table, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !table ? "Pick table first" :
                                                columnsQ.isLoading ? "Loading…" :
                                                    columnsQ.data?.length === 0 ? "No columns" :
                                                        "Pick a column" }) }), _jsx(SelectContent, { children: (columnsQ.data ?? []).map((c) => (_jsx(SelectItem, { value: c.name, className: "font-mono", children: c.name }, c.name))) })] })) : (
                            // `add-column` names a NEW column, so it stays a text input.
                            _jsx(Input, { value: colName, onChange: (e) => setColName(e.target.value), placeholder: "new_column" }))] }), kind === "add-column" && (_jsxs(_Fragment, { children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Type (raw SQL)" }), _jsx(Input, { value: colType, onChange: (e) => setColType(e.target.value), placeholder: "text / varchar(64) / int" })] }), _jsxs("div", { className: "flex items-end gap-2", children: [_jsxs("label", { className: "text-xs flex items-center gap-1", children: [_jsx("input", { type: "checkbox", checked: nullable, onChange: (e) => setNullable(e.target.checked) }), "nullable"] }), _jsx(ArrowRight, { className: "h-4 w-4 text-muted-foreground" })] })] })), kind === "rename-column" && (_jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "New name" }), _jsx(Input, { value: renameTo, onChange: (e) => setRenameTo(e.target.value), placeholder: "new_name" })] }))] }))] }));
}
