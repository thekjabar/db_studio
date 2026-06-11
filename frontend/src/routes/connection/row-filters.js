import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Filter, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
export default function RowFiltersRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const q = useQuery({
        queryKey: ["row-filters", id],
        queryFn: () => api.listRowFilters(id),
        enabled: !!id,
    });
    const upsert = useMutation({
        mutationFn: (body) => api.upsertRowFilter(id, body),
        onSuccess: () => {
            toast.success("Filter saved");
            qc.invalidateQueries({ queryKey: ["row-filters", id] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const del = useMutation({
        mutationFn: (filterId) => api.deleteRowFilter(id, filterId),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["row-filters", id] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(Filter, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Row filters" })] }), _jsxs("div", { className: "max-w-3xl mx-auto p-4 space-y-6", children: [_jsxs("div", { className: "rounded-md border border-border bg-card p-4", children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: "Add / update a filter" }), _jsxs("p", { className: "text-xs text-muted-foreground mb-3", children: ["When a user browses the named table, this predicate is AND-ed with their filters. Use", " ", _jsx("code", { className: "rounded bg-muted px-1 py-0.5 font-mono", children: ":userId" }), " to reference the viewing user's id. Only the connection owner can manage filters."] }), _jsx(NewFilterForm, { connectionId: id, onSubmit: (b) => upsert.mutate(b), pending: upsert.isPending })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2", children: "Active filters" }), q.isLoading && (_jsxs("div", { className: "text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin inline" }), " Loading..."] })), q.data?.length === 0 && (_jsx("div", { className: "rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground", children: "No row filters set. Every team member sees all rows." })), _jsx("div", { className: "space-y-2", children: q.data?.map((f) => (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 flex items-start gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "text-sm font-medium", children: [f.displayName || f.email, _jsxs("span", { className: "text-muted-foreground ml-2", children: ["\u2192 ", f.schemaName, ".", f.tableName] })] }), _jsx("code", { className: "block mt-1 text-xs font-mono rounded bg-muted px-2 py-1", children: f.predicate })] }), _jsx("button", { onClick: () => del.mutate(f.id), disabled: del.isPending, className: "text-muted-foreground hover:text-destructive p-1", title: "Delete filter", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] }, f.id))) })] })] })] }));
}
function NewFilterForm({ connectionId, onSubmit, pending, }) {
    // Populate every dropdown from the *current* connection: workspace members,
    // available schemas, and tables in the picked schema. Avoids typos and
    // missing-table errors, and surfaces the actual options the user has.
    const membersQ = useQuery({
        queryKey: ["conn-members", connectionId],
        queryFn: () => api.listConnectionMembers(connectionId),
    });
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const [email, setEmail] = useState("");
    const [schemaName, setSchema] = useState("");
    const [tableName, setTable] = useState("");
    const [predicate, setPredicate] = useState("tenant_id = :userId");
    // Default schema to "public" if present, otherwise the first one returned.
    useEffect(() => {
        if (!schemasQ.data || schemaName)
            return;
        if (schemasQ.data.includes("public"))
            setSchema("public");
        else if (schemasQ.data[0])
            setSchema(schemasQ.data[0]);
    }, [schemasQ.data, schemaName]);
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schemaName],
        queryFn: () => api.listTables(connectionId, schemaName),
        enabled: !!schemaName,
    });
    // Reset table when schema changes.
    useEffect(() => {
        setTable("");
    }, [schemaName]);
    const submit = (e) => {
        e.preventDefault();
        if (!email || !schemaName || !tableName || !predicate) {
            toast.error("All fields required");
            return;
        }
        onSubmit({ email, schemaName, tableName, predicate });
    };
    return (_jsxs("form", { onSubmit: submit, className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "User" }), _jsxs(Select, { value: email, onValueChange: setEmail, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: membersQ.isLoading ? "Loading members..." :
                                        membersQ.data?.length === 0 ? "No members yet — invite one first" :
                                            "Pick a workspace member" }) }), _jsx(SelectContent, { children: (membersQ.data ?? []).map((m) => (_jsxs(SelectItem, { value: m.email, children: [_jsx("span", { className: "font-mono", children: m.email }), m.displayName ? (_jsxs("span", { className: "text-muted-foreground ml-2", children: ["(", m.displayName, ")"] })) : null] }, m.id))) })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Schema" }), _jsxs(Select, { value: schemaName, onValueChange: setSchema, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: schemasQ.isLoading ? "Loading..." : "Pick a schema" }) }), _jsx(SelectContent, { children: (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, className: "font-mono", children: s }, s))) })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Table" }), _jsxs(Select, { value: tableName, onValueChange: setTable, disabled: !schemaName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !schemaName ? "Pick a schema first" :
                                        tablesQ.isLoading ? "Loading tables..." :
                                            tablesQ.data?.length === 0 ? "No tables in this schema" :
                                                "Pick a table" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsxs(SelectItem, { value: t.name, className: "font-mono", children: [t.name, t.type === "view" ? (_jsx("span", { className: "text-muted-foreground ml-2", children: "(view)" })) : null] }, t.name))) })] })] }), _jsxs("div", { className: "col-span-2", children: [_jsx(Label, { children: "Predicate (allowed: identifiers, =, <, >, IN, AND, OR, NOT, IS NULL, :userId)" }), _jsx(Input, { value: predicate, onChange: (e) => setPredicate(e.target.value), className: "font-mono text-xs" })] }), _jsx("div", { className: "col-span-2 flex justify-end", children: _jsxs(Button, { type: "submit", disabled: pending, children: [pending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Plus, { className: "h-3.5 w-3.5" }), "Save filter"] }) })] }));
}
