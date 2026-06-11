import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { AddColumnDialog } from "@/components/add-column-dialog";
import { RetypeColumnDialog } from "@/components/retype-column-dialog";
import { CommentsPanel } from "@/components/comments-panel";
export default function SchemaRoute() {
    const { id } = useParams();
    const ctx = useOutletContext();
    const schema = ctx?.schema ?? "public";
    const qc = useQueryClient();
    const modal = useModal();
    const [selectedTable, setSelectedTable] = useState(null);
    const [addOpen, setAddOpen] = useState(false);
    const [retypeCol, setRetypeCol] = useState(null);
    const tablesQ = useQuery({
        queryKey: ["tables", id, schema],
        queryFn: () => api.listTables(id, schema),
        enabled: !!id,
    });
    const colsQ = useQuery({
        queryKey: ["columns", id, schema, selectedTable],
        queryFn: () => api.getTableColumns(id, selectedTable, schema),
        enabled: !!selectedTable && !!id,
    });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["columns", id, schema, selectedTable] });
        qc.invalidateQueries({ queryKey: ["tables", id, schema] });
        qc.invalidateQueries({ queryKey: ["definition", id, schema, selectedTable] });
    };
    const alter = useMutation({
        mutationFn: (req) => api.alterTable(id, req),
        onSuccess: () => {
            toast.success("Schema updated");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const dropColumn = async (name) => {
        if (!selectedTable)
            return;
        const ok = await modal.confirm({
            title: `Drop column ${name}?`,
            description: "This permanently removes the column and its data.",
            confirmLabel: "Drop",
            destructive: true,
        });
        if (!ok)
            return;
        alter.mutate({ schema, name: selectedTable, dropColumns: [name], confirm: true });
    };
    const renameColumn = async (oldName) => {
        if (!selectedTable)
            return;
        const newName = await modal.prompt({
            title: `Rename ${oldName}`,
            description: "Enter the new column name.",
            defaultValue: oldName,
        });
        if (!newName || newName === oldName)
            return;
        alter.mutate({
            schema,
            name: selectedTable,
            renameColumns: [{ from: oldName, to: newName }],
            confirm: true,
        });
    };
    const applyRetype = (newType) => {
        if (!selectedTable || !retypeCol)
            return;
        if (newType === retypeCol.currentType) {
            setRetypeCol(null);
            return;
        }
        alter.mutate({
            schema,
            name: selectedTable,
            alterColumns: [{ name: retypeCol.name, type: newType }],
            confirm: true,
        });
        setRetypeCol(null);
    };
    return (_jsxs("div", { className: "h-full flex", children: [_jsxs("aside", { className: "w-56 shrink-0 border-r border-border bg-card overflow-y-auto", children: [_jsxs("div", { className: "px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-muted-foreground border-b border-border", children: ["Tables \u2014 ", schema] }), tablesQ.isLoading && _jsx("div", { className: "p-3 text-xs text-muted-foreground", children: "Loading..." }), tablesQ.data?.map((t) => (_jsx("button", { onClick: () => setSelectedTable(t.name), className: `block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-accent ${selectedTable === t.name ? "bg-accent text-primary" : ""}`, children: t.name }, t.name)))] }), _jsxs("div", { className: "flex-1 overflow-auto p-6", children: [!selectedTable && (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Select a table to edit its schema." })), selectedTable && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsxs("div", { children: [_jsxs("h2", { className: "text-lg font-semibold font-mono", children: [schema, ".", selectedTable] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Edit columns. Schema changes apply immediately." })] }), _jsxs(Button, { size: "sm", onClick: () => setAddOpen(true), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add column"] })] }), colsQ.isLoading ? (_jsx("div", { className: "text-sm text-muted-foreground", children: "Loading columns..." })) : (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-xs font-mono", children: [_jsx("thead", { className: "bg-muted", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Name" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Type" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Nullable" }), _jsx("th", { className: "text-left px-3 py-2 font-medium text-muted-foreground", children: "Default" }), _jsx("th", { className: "text-right px-3 py-2 font-medium text-muted-foreground", children: "Actions" })] }) }), _jsx("tbody", { children: (colsQ.data ?? []).map((c) => (_jsxs("tr", { className: "border-t border-border", children: [_jsx("td", { className: "px-3 py-2", children: c.name }), _jsx("td", { className: "px-3 py-2 text-primary", children: c.dataType }), _jsx("td", { className: "px-3 py-2", children: c.nullable ? "YES" : "NO" }), _jsx("td", { className: "px-3 py-2 text-muted-foreground", children: c.defaultValue ?? "" }), _jsxs("td", { className: "px-3 py-2 text-right", children: [_jsx(Button, { size: "sm", variant: "ghost", onClick: () => renameColumn(c.name), children: "Rename" }), _jsx(Button, { size: "sm", variant: "ghost", onClick: () => setRetypeCol({ name: c.name, currentType: c.dataType }), children: "Retype" }), _jsx(Button, { size: "sm", variant: "ghost", className: "text-destructive", onClick: () => dropColumn(c.name), children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }, c.name))) })] }) })), _jsx("div", { className: "mt-8 max-w-2xl", children: _jsx(CommentsPanel, { connectionId: id, target: `table:${schema}.${selectedTable}`, label: `Comments on ${schema}.${selectedTable}` }) })] }))] }), selectedTable && (_jsx(AddColumnDialog, { connectionId: id, schema: schema, table: selectedTable, open: addOpen, onOpenChange: setAddOpen, onSaved: () => {
                    toast.success("Column added");
                    invalidate();
                } })), _jsx(RetypeColumnDialog, { open: !!retypeCol, columnName: retypeCol?.name ?? "", currentType: retypeCol?.currentType ?? "", onOpenChange: (v) => !v && setRetypeCol(null), onConfirm: applyRetype })] }));
}
