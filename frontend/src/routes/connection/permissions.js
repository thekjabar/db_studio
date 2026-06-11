import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModal } from "@/components/modal-provider";
const ROLES = ["VIEWER", "EDITOR", "OWNER"];
function roleBadgeVariant(role) {
    switch (role) {
        case "OWNER":
            return "default";
        case "EDITOR":
            return "warning";
        default:
            return "secondary";
    }
}
export default function PermissionsRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(PermissionsInner, { connectionId: id });
}
function PermissionsInner({ connectionId }) {
    const qc = useQueryClient();
    const modal = useModal();
    const members = useQuery({
        queryKey: ["conn-members", connectionId],
        queryFn: () => api.listConnectionMembers(connectionId),
    });
    const grants = useQuery({
        queryKey: ["table-grants", connectionId],
        queryFn: () => api.listTableGrants(connectionId),
    });
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["conn-members", connectionId] });
        qc.invalidateQueries({ queryKey: ["table-grants", connectionId] });
    };
    const addMember = useMutation({
        mutationFn: (input) => api.addConnectionMember(connectionId, input),
        onSuccess: () => {
            toast.success("Member added");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const updateMember = useMutation({
        mutationFn: ({ memberId, role }) => api.updateConnectionMember(connectionId, memberId, role),
        onSuccess: () => {
            toast.success("Role updated");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const removeMember = useMutation({
        mutationFn: (memberId) => api.removeConnectionMember(connectionId, memberId),
        onSuccess: () => {
            toast.success("Member removed");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const upsertGrant = useMutation({
        mutationFn: (input) => api.upsertTableGrant(connectionId, input),
        onSuccess: () => {
            toast.success("Table grant saved");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const removeGrant = useMutation({
        mutationFn: (grantId) => api.removeTableGrant(connectionId, grantId),
        onSuccess: () => {
            toast.success("Table grant removed");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "p-6 space-y-8 max-w-4xl mx-auto", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-lg font-semibold", children: "Permissions" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Control who can access this connection and which tables they can modify." })] }), _jsxs("section", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-sm font-semibold", children: "Connection members" }), _jsx("p", { className: "text-xs text-muted-foreground mt-0.5", children: "Members get the role below on every table by default. Table-level grants below override it." })] }), _jsx(AddMemberForm, { onAdd: (email, role) => addMember.mutate({ email, role }), busy: addMember.isPending }), _jsx(MembersTable, { members: members.data ?? [], loading: members.isLoading, onUpdate: (memberId, role) => updateMember.mutate({ memberId, role }), onRemove: async (memberId, email) => {
                            const ok = await modal.confirm({
                                title: "Remove member",
                                description: `Remove ${email} from this connection? All table grants for this user will also be removed.`,
                                confirmLabel: "Remove",
                                destructive: true,
                            });
                            if (ok)
                                removeMember.mutate(memberId);
                        }, busy: updateMember.isPending || removeMember.isPending })] }), _jsxs("section", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-sm font-semibold", children: "Per-table grants" }), _jsx("p", { className: "text-xs text-muted-foreground mt-0.5", children: "Give a member a different role on a specific table \u2014 e.g. promote a VIEWER to EDITOR on one table, or demote an EDITOR to VIEWER on a sensitive one." })] }), _jsx(UpsertGrantForm, { connectionId: connectionId, members: members.data ?? [], schemas: schemasQ.data ?? [], onSubmit: (v) => upsertGrant.mutate(v), busy: upsertGrant.isPending }), _jsx(GrantsTable, { grants: grants.data ?? [], loading: grants.isLoading, onRemove: (grantId) => removeGrant.mutate(grantId), busy: removeGrant.isPending })] })] }));
}
function AddMemberForm({ onAdd, busy, }) {
    const [email, setEmail] = useState("");
    const [role, setRole] = useState("VIEWER");
    const submit = (e) => {
        e.preventDefault();
        if (!email.trim())
            return;
        onAdd(email.trim(), role);
        setEmail("");
    };
    return (_jsxs("form", { onSubmit: submit, className: "flex items-end gap-2 rounded-md border border-border bg-card p-3", children: [_jsxs("div", { className: "flex-1 space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Email" }), _jsx(Input, { type: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "user@example.com" })] }), _jsxs("div", { className: "w-32 space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Role" }), _jsxs(Select, { value: role, onValueChange: (v) => setRole(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ROLES.map((r) => (_jsx(SelectItem, { value: r, children: r }, r))) })] })] }), _jsxs(Button, { type: "submit", disabled: busy, children: [busy ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : _jsx(UserPlus, { className: "h-4 w-4" }), "Add member"] })] }));
}
function MembersTable({ members, loading, onUpdate, onRemove, busy, }) {
    if (loading) {
        return (_jsxs("div", { className: "rounded-md border border-border p-6 text-sm text-muted-foreground flex items-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading members\u2026"] }));
    }
    if (members.length === 0) {
        return (_jsx("div", { className: "rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground text-center", children: "No members yet. Only the connection owner has access." }));
    }
    return (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "User" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-40", children: "Role" }), _jsx("th", { className: "px-3 py-2 w-10" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: members.map((m) => (_jsxs("tr", { children: [_jsxs("td", { className: "px-3 py-2", children: [_jsx("div", { className: "font-medium", children: m.displayName ?? m.email }), m.displayName && _jsx("div", { className: "text-xs text-muted-foreground", children: m.email })] }), _jsx("td", { className: "px-3 py-2", children: _jsxs(Select, { value: m.role, onValueChange: (v) => onUpdate(m.id, v), disabled: busy, children: [_jsx(SelectTrigger, { className: "h-8", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ROLES.map((r) => (_jsx(SelectItem, { value: r, children: r }, r))) })] }) }), _jsx("td", { className: "px-3 py-2 text-right", children: _jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8 text-destructive", onClick: () => onRemove(m.id, m.email), disabled: busy, children: _jsx(Trash2, { className: "h-4 w-4" }) }) })] }, m.id))) })] }) }));
}
function UpsertGrantForm({ connectionId, members, schemas, onSubmit, busy, }) {
    const [email, setEmail] = useState("");
    const [schemaName, setSchemaName] = useState("");
    const [tableName, setTableName] = useState("");
    const [role, setRole] = useState("VIEWER");
    // Default schema once schemas load, cascade table list off the chosen schema.
    useEffect(() => {
        if (!schemas.length || schemaName)
            return;
        if (schemas.includes("public"))
            setSchemaName("public");
        else
            setSchemaName(schemas[0]);
    }, [schemas, schemaName]);
    useEffect(() => { setTableName(""); }, [schemaName]);
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schemaName],
        queryFn: () => api.listTables(connectionId, schemaName),
        enabled: !!schemaName,
    });
    const submit = (e) => {
        e.preventDefault();
        if (!email || !schemaName || !tableName)
            return;
        onSubmit({ email, schemaName, tableName, role });
        setTableName("");
    };
    return (_jsxs("form", { onSubmit: submit, className: "grid grid-cols-1 md:grid-cols-[1.3fr_0.8fr_0.8fr_0.7fr_auto] gap-2 rounded-md border border-border bg-card p-3", children: [_jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Member" }), _jsxs(Select, { value: email, onValueChange: setEmail, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: members.length === 0 ? "Add a member first" : "Pick a member" }) }), _jsx(SelectContent, { children: members.map((m) => (_jsxs(SelectItem, { value: m.email, children: [_jsx("span", { className: "font-mono", children: m.email }), m.displayName ? _jsxs("span", { className: "text-muted-foreground ml-2", children: ["(", m.displayName, ")"] }) : null] }, m.id))) })] })] }), _jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Schema" }), _jsxs(Select, { value: schemaName, onValueChange: setSchemaName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick a schema" }) }), _jsx(SelectContent, { children: schemas.map((s) => (_jsx(SelectItem, { value: s, className: "font-mono", children: s }, s))) })] })] }), _jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Table" }), _jsxs(Select, { value: tableName, onValueChange: setTableName, disabled: !schemaName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: !schemaName ? "Pick a schema first" :
                                        tablesQ.isLoading ? "Loading…" :
                                            tablesQ.data?.length === 0 ? "No tables" :
                                                "Pick a table" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, className: "font-mono", children: t.name }, t.name))) })] })] }), _jsxs("div", { className: "space-y-1", children: [_jsx(Label, { className: "text-xs", children: "Role" }), _jsxs(Select, { value: role, onValueChange: (v) => setRole(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: ROLES.map((r) => (_jsx(SelectItem, { value: r, children: r }, r))) })] })] }), _jsx("div", { className: "flex items-end", children: _jsx(Button, { type: "submit", disabled: busy || !email || !tableName, className: "w-full", children: busy ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : "Save grant" }) })] }));
}
function GrantsTable({ grants, loading, onRemove, busy, }) {
    if (loading) {
        return (_jsxs("div", { className: "rounded-md border border-border p-6 text-sm text-muted-foreground flex items-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading grants\u2026"] }));
    }
    if (grants.length === 0) {
        return (_jsx("div", { className: "rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground text-center", children: "No per-table grants. Members use their connection-level role on every table." }));
    }
    return (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "User" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Table" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-28", children: "Role" }), _jsx("th", { className: "px-3 py-2 w-10" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: grants.map((g) => (_jsxs("tr", { children: [_jsxs("td", { className: "px-3 py-2", children: [_jsx("div", { className: "font-medium", children: g.displayName ?? g.email }), g.displayName && _jsx("div", { className: "text-xs text-muted-foreground", children: g.email })] }), _jsxs("td", { className: "px-3 py-2 font-mono text-xs", children: [g.schemaName, ".", g.tableName] }), _jsx("td", { className: "px-3 py-2", children: _jsx(Badge, { variant: roleBadgeVariant(g.role), children: g.role }) }), _jsx("td", { className: "px-3 py-2 text-right", children: _jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8 text-destructive", onClick: () => onRemove(g.id), disabled: busy, children: _jsx(Trash2, { className: "h-4 w-4" }) }) })] }, g.id))) })] }) }));
}
