import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { BookMarked, Loader2, Pencil, Trash2, User } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { renderMarkdown } from "@/lib/markdown";
// Sentinel since Radix Select forbids empty-string item values, but we need to
// represent "table-level (no column)" as the chosen option.
const TABLE_LEVEL = "__table__";
export default function SchemaDocsRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const [edit, setEdit] = useState(null);
    const q = useQuery({
        queryKey: ["schema-docs", id],
        queryFn: () => api.listSchemaDocs(id),
        enabled: !!id,
    });
    const del = useMutation({
        mutationFn: (docId) => api.deleteSchemaDoc(id, docId),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["schema-docs", id] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const grouped = useMemo(() => {
        const map = new Map();
        for (const d of q.data ?? []) {
            const k = `${d.schemaName}.${d.tableName}`;
            const list = map.get(k) ?? [];
            list.push(d);
            map.set(k, list);
        }
        // Sort each group so table-level (columnName = '') comes first.
        for (const list of map.values()) {
            list.sort((a, b) => {
                if (a.columnName === "" && b.columnName !== "")
                    return -1;
                if (b.columnName === "" && a.columnName !== "")
                    return 1;
                return a.columnName.localeCompare(b.columnName);
            });
        }
        return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, [q.data]);
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(BookMarked, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Schema docs" }), _jsx("div", { className: "ml-auto", children: _jsxs(Button, { size: "sm", onClick: () => setEdit("new"), children: [_jsx(Pencil, { className: "h-3.5 w-3.5" }), " New doc"] }) })] }), _jsxs("div", { className: "max-w-4xl mx-auto p-4 space-y-6", children: [q.isLoading && _jsx("div", { className: "text-muted-foreground", children: "Loading\u2026" }), q.data?.length === 0 && (_jsx("div", { className: "rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground", children: "No documentation yet. Add descriptions, tags, and owners for your tables and columns." })), grouped.map(([key, docs]) => (_jsxs("section", { children: [_jsx("h2", { className: "text-sm font-semibold mb-2", children: key }), _jsx("div", { className: "space-y-2", children: docs.map((d) => (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 flex items-start gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "text-sm font-medium", children: [d.columnName || _jsx("span", { className: "text-muted-foreground", children: "(table)" }), d.ownerEmail && (_jsxs("span", { className: "inline-flex items-center gap-1 ml-2 text-[11px] text-muted-foreground", children: [_jsx(User, { className: "h-3 w-3" }), " ", d.ownerEmail] }))] }), d.tags && (_jsx("div", { className: "flex flex-wrap gap-1 mt-1", children: d.tags.split(",").map((t) => (_jsx(Badge, { variant: "secondary", className: "text-[10px]", children: t }, t))) })), d.description && (_jsx("div", { className: "prose prose-sm max-w-none dark:prose-invert mt-2 text-sm", dangerouslySetInnerHTML: { __html: renderMarkdown(d.description) } })), _jsxs("div", { className: "text-[10px] text-muted-foreground mt-1.5", children: ["Updated ", format(new Date(d.updatedAt), "MMM d HH:mm"), d.updatedBy && ` by ${d.updatedBy.displayName || d.updatedBy.email}`] })] }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [_jsx("button", { onClick: () => setEdit(d), className: "text-muted-foreground hover:text-foreground p-1", title: "Edit", children: _jsx(Pencil, { className: "h-3.5 w-3.5" }) }), _jsx("button", { onClick: () => del.mutate(d.id), disabled: del.isPending, className: "text-muted-foreground hover:text-destructive p-1", title: "Delete", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }, d.id))) })] }, key)))] }), edit && (_jsx(DocDialog, { connectionId: id, initial: edit === "new" ? null : edit, onClose: () => setEdit(null) }))] }));
}
function DocDialog({ connectionId, initial, onClose, }) {
    const qc = useQueryClient();
    const isEditing = !!initial;
    const [schemaName, setSchema] = useState(initial?.schemaName ?? "");
    const [tableName, setTable] = useState(initial?.tableName ?? "");
    // Use sentinel for "table-level" since Radix Select disallows empty strings.
    const [columnPick, setColumnPick] = useState(initial?.columnName ? initial.columnName : TABLE_LEVEL);
    const [description, setDescription] = useState(initial?.description ?? "");
    const [tags, setTags] = useState(initial?.tags ?? "");
    const [ownerEmail, setOwnerEmail] = useState(initial?.ownerEmail ?? "");
    // Connection-derived options.
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schemaName],
        queryFn: () => api.listTables(connectionId, schemaName),
        enabled: !!schemaName,
    });
    const columnsQ = useQuery({
        queryKey: ["columns", connectionId, schemaName, tableName],
        queryFn: () => api.getTableColumns(connectionId, tableName, schemaName),
        enabled: !!schemaName && !!tableName,
    });
    const membersQ = useQuery({
        queryKey: ["conn-members", connectionId],
        queryFn: () => api.listConnectionMembers(connectionId),
    });
    // First-load default: pick "public" if available, otherwise the first schema.
    useEffect(() => {
        if (!schemasQ.data || schemaName)
            return;
        if (schemasQ.data.includes("public"))
            setSchema("public");
        else if (schemasQ.data[0])
            setSchema(schemasQ.data[0]);
    }, [schemasQ.data, schemaName]);
    // When schema changes (and we're creating, not editing) reset cascading picks.
    useEffect(() => {
        if (isEditing)
            return;
        setTable("");
        setColumnPick(TABLE_LEVEL);
    }, [schemaName, isEditing]);
    useEffect(() => {
        if (isEditing)
            return;
        setColumnPick(TABLE_LEVEL);
    }, [tableName, isEditing]);
    const save = useMutation({
        mutationFn: () => {
            const columnName = columnPick === TABLE_LEVEL ? undefined : columnPick;
            return api.upsertSchemaDoc(connectionId, {
                schemaName: schemaName.trim(),
                tableName: tableName.trim(),
                columnName,
                description: description || undefined,
                tags: tags || undefined,
                ownerEmail: ownerEmail || undefined,
            });
        },
        onSuccess: () => {
            toast.success("Saved");
            qc.invalidateQueries({ queryKey: ["schema-docs", connectionId] });
            onClose();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsx(Dialog, { open: true, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-2xl", children: [_jsx(DialogHeader, { children: _jsx(DialogTitle, { children: initial ? "Edit doc" : "New doc" }) }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "grid grid-cols-3 gap-2", children: [_jsxs("div", { children: [_jsx(Label, { children: "Schema" }), _jsxs(Select, { value: schemaName, onValueChange: setSchema, disabled: isEditing, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: schemasQ.isLoading ? "Loading..." : "Pick a schema" }) }), _jsx(SelectContent, { children: (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, className: "font-mono", children: s }, s))) })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Table" }), _jsxs(Select, { value: tableName, onValueChange: setTable, disabled: isEditing || !schemaName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !schemaName ? "Pick schema first" :
                                                            tablesQ.isLoading ? "Loading..." :
                                                                tablesQ.data?.length === 0 ? "No tables" :
                                                                    "Pick a table" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, className: "font-mono", children: t.name }, t.name))) })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Column" }), _jsxs(Select, { value: columnPick, onValueChange: setColumnPick, disabled: isEditing || !tableName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !tableName ? "Pick table first" :
                                                            columnsQ.isLoading ? "Loading..." :
                                                                "Table-level" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: TABLE_LEVEL, children: _jsx("span", { className: "text-muted-foreground", children: "Table-level (no column)" }) }), (columnsQ.data ?? []).map((c) => (_jsx(SelectItem, { value: c.name, className: "font-mono", children: c.name }, c.name)))] })] })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Owner" }), _jsxs(Select, { value: ownerEmail || TABLE_LEVEL, onValueChange: (v) => setOwnerEmail(v === TABLE_LEVEL ? "" : v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: membersQ.isLoading ? "Loading members..." : "Optional — pick an owner" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: TABLE_LEVEL, children: _jsx("span", { className: "text-muted-foreground", children: "No owner" }) }), (membersQ.data ?? []).map((m) => (_jsxs(SelectItem, { value: m.email, children: [_jsx("span", { className: "font-mono", children: m.email }), m.displayName ? (_jsxs("span", { className: "text-muted-foreground ml-2", children: ["(", m.displayName, ")"] })) : null] }, m.id)))] })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Tags (comma-separated, e.g. pii,regulated)" }), _jsx(Input, { value: tags, onChange: (e) => setTags(e.target.value) })] }), _jsxs("div", { children: [_jsx(Label, { children: "Description (markdown)" }), _jsx(Textarea, { rows: 6, value: description, onChange: (e) => setDescription(e.target.value), className: "font-mono text-xs" })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsxs(Button, { onClick: () => save.mutate(), disabled: save.isPending || !schemaName || !tableName, children: [save.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Save"] })] })] }) }));
}
