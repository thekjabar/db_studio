import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Copy, Database, Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth-store";
import { useModal } from "@/components/modal-provider";
export default function ApiKeysRoute() {
    const qc = useQueryClient();
    const modal = useModal();
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const [newToken, setNewToken] = useState(null);
    const keysQ = useQuery({ queryKey: ["api-keys"], queryFn: api.listApiKeys });
    const connectionsQ = useQuery({
        queryKey: ["connections"],
        queryFn: () => api.listConnections(),
    });
    const revoke = useMutation({
        mutationFn: (id) => api.revokeApiKey(id),
        onSuccess: () => {
            toast.success("Key revoked");
            qc.invalidateQueries({ queryKey: ["api-keys"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteApiKey(id),
        onSuccess: () => {
            toast.success("Key deleted");
            qc.invalidateQueries({ queryKey: ["api-keys"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "min-h-screen gradient-bg", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm", children: [_jsxs(Link, { to: "/connections", className: "flex items-center gap-2 font-semibold", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), "DB Studio"] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { to: "/connections", className: "text-sm text-muted-foreground hover:text-foreground", children: "Connections" }), _jsx("span", { className: "hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50", children: user?.email }), _jsx(ThemeToggle, {})] })] }), _jsxs("div", { className: "max-w-5xl mx-auto px-6 py-10 space-y-6", children: [_jsxs("div", { className: "flex items-start justify-between gap-4 flex-wrap", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-2xl font-semibold flex items-center gap-2", children: [_jsx(Key, { className: "h-6 w-6" }), " API keys"] }), _jsxs("p", { className: "text-sm text-muted-foreground mt-1", children: ["Use these tokens to script against DB Studio. Send them as", " ", _jsx("code", { className: "bg-muted px-1 rounded text-xs", children: "Authorization: Bearer dbs_live_\u2026" }), " ", "against ", _jsx("code", { className: "bg-muted px-1 rounded text-xs", children: "/api/v1/*" }), "."] })] }), _jsxs(Button, { onClick: () => setOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New key"] })] }), _jsx(UsageHint, {}), keysQ.isLoading ? (_jsxs("div", { className: "rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading\u2026"] })) : !keysQ.data || keysQ.data.length === 0 ? (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center", children: [_jsx("div", { className: "text-sm font-medium mb-1", children: "No API keys yet" }), _jsx("div", { className: "text-xs text-muted-foreground mb-4", children: "Create one to run queries from scripts or CI." }), _jsxs(Button, { onClick: () => setOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New key"] })] })) : (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Name" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Token" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Scope" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Last used" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Status" }), _jsx("th", { className: "px-3 py-2 w-20" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: keysQ.data.map((k) => (_jsx(KeyRow, { k: k, connections: connectionsQ.data ?? [], onRevoke: () => revoke.mutate(k.id), onDelete: async () => {
                                            const ok = await modal.confirm({
                                                title: "Delete API key",
                                                description: `Permanently delete "${k.name}"? Any services still using this token will break.`,
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                remove.mutate(k.id);
                                        }, busy: revoke.isPending || remove.isPending }, k.id))) })] }) }))] }), _jsx(NewKeyDialog, { open: open, onOpenChange: setOpen, connections: connectionsQ.data ?? [], onCreated: (name, token) => setNewToken({ name, token }) }), _jsx(Dialog, { open: !!newToken, onOpenChange: (v) => !v && setNewToken(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Save this token" }), _jsx(DialogDescription, { children: "This is the only time you'll see the full token. Copy and store it somewhere safe (password manager, CI secret, etc.)." })] }), newToken && (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "text-xs text-muted-foreground", children: ["Name: ", newToken.name] }), _jsxs("div", { className: "flex items-stretch gap-2", children: [_jsx(Input, { readOnly: true, value: newToken.token, className: "font-mono text-xs flex-1", onFocus: (e) => e.currentTarget.select() }), _jsx(Button, { variant: "outline", size: "icon", className: "h-9 w-9", onClick: async () => {
                                                try {
                                                    await navigator.clipboard.writeText(newToken.token);
                                                    toast.success("Copied");
                                                }
                                                catch {
                                                    toast.error("Copy failed");
                                                }
                                            }, children: _jsx(Copy, { className: "h-4 w-4" }) })] })] })), _jsx(DialogFooter, { children: _jsx(Button, { onClick: () => setNewToken(null), children: "I saved it" }) })] }) })] }));
}
function UsageHint() {
    const apiUrl = (import.meta.env.VITE_API_URL ?? window.location.origin + "/api");
    const exampleCurl = `curl -H "Authorization: Bearer dbs_live_…" \\\n  -H "Content-Type: application/json" \\\n  -d '{"sql":"SELECT 1"}' \\\n  ${apiUrl}/v1/connections/<connectionId>/query`;
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 text-xs text-muted-foreground space-y-1", children: [_jsxs("div", { className: "font-medium text-foreground", children: ["Endpoints (all under ", _jsx("code", { children: "/v1" }), ")"] }), _jsxs("div", { children: ["\u2022 ", _jsx("code", { children: "GET /v1/connections" }), " \u2014 list connections this key can reach"] }), _jsxs("div", { children: ["\u2022 ", _jsx("code", { children: "GET /v1/connections/:id/tables?schema=public" }), " \u2014 list tables"] }), _jsxs("div", { children: ["\u2022 ", _jsx("code", { children: "POST /v1/connections/:id/query" }), " \u2014 run SQL; body ", _jsx("code", { children: "{sql, params?, maxRows?, confirmDestructive?}" })] }), _jsx("pre", { className: "mt-2 bg-muted/40 p-2 rounded font-mono text-[11px] overflow-x-auto", children: exampleCurl })] }));
}
function KeyRow({ k, connections, onRevoke, onDelete, busy, }) {
    const scope = k.connectionIds.length === 0
        ? "All connections"
        : k.connectionIds
            .map((id) => connections.find((c) => c.id === id)?.name ?? id)
            .join(", ");
    const revoked = !!k.revokedAt;
    const expired = k.expiresAt && new Date(k.expiresAt) < new Date();
    const statusLabel = revoked ? "revoked" : expired ? "expired" : "active";
    const statusVariant = revoked ? "destructive" : expired ? "warning" : "default";
    return (_jsxs("tr", { className: revoked ? "opacity-60" : "", children: [_jsxs("td", { className: "px-3 py-2", children: [_jsx("div", { className: "font-medium", children: k.name }), _jsx("div", { className: "text-xs text-muted-foreground", children: k.expiresAt ? `expires ${formatDistanceToNow(new Date(k.expiresAt), { addSuffix: true })}` : "no expiry" })] }), _jsx("td", { className: "px-3 py-2 font-mono text-xs", children: k.tokenPrefix }), _jsx("td", { className: "px-3 py-2 text-xs max-w-xs truncate", title: scope, children: scope }), _jsx("td", { className: "px-3 py-2 text-xs", children: k.lastUsedAt ? formatDistanceToNow(new Date(k.lastUsedAt), { addSuffix: true }) : "never" }), _jsx("td", { className: "px-3 py-2", children: _jsx(Badge, { variant: statusVariant, children: statusLabel }) }), _jsxs("td", { className: "px-3 py-2 text-right", children: [!revoked && (_jsx(Button, { variant: "ghost", size: "sm", onClick: onRevoke, disabled: busy, title: "Revoke", children: _jsx(X, { className: "h-3.5 w-3.5" }) })), _jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8 text-destructive", onClick: onDelete, disabled: busy, children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }));
}
function NewKeyDialog({ open, onOpenChange, connections, onCreated, }) {
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [scope, setScope] = useState("all");
    const [selected, setSelected] = useState(new Set());
    const [expiry, setExpiry] = useState("never");
    const [busy, setBusy] = useState(false);
    const reset = () => {
        setName("");
        setScope("all");
        setSelected(new Set());
        setExpiry("never");
    };
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const expiresAt = expiry === "never"
                ? undefined
                : new Date(Date.now() + expiryDays(expiry) * 24 * 60 * 60 * 1000).toISOString();
            const r = await api.createApiKey({
                name,
                connectionIds: scope === "selected" ? Array.from(selected) : [],
                expiresAt,
            });
            qc.invalidateQueries({ queryKey: ["api-keys"] });
            onCreated(r.name, r.token);
            reset();
            onOpenChange(false);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setBusy(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => (v ? onOpenChange(true) : (reset(), onOpenChange(false))), children: _jsxs(DialogContent, { className: "max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New API key" }), _jsx(DialogDescription, { children: "Create a token your scripts can use to query the API." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { required: true, value: name, onChange: (e) => setName(e.target.value), placeholder: "Backup script" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Scope" }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "button", className: `flex-1 rounded border px-2 py-1 text-xs ${scope === "all"
                                                ? "border-primary bg-primary/15 text-primary"
                                                : "border-border text-muted-foreground hover:text-foreground"}`, onClick: () => setScope("all"), children: "All connections" }), _jsx("button", { type: "button", className: `flex-1 rounded border px-2 py-1 text-xs ${scope === "selected"
                                                ? "border-primary bg-primary/15 text-primary"
                                                : "border-border text-muted-foreground hover:text-foreground"}`, onClick: () => setScope("selected"), children: "Specific connections" })] })] }), scope === "selected" && (_jsxs("div", { className: "space-y-1 max-h-40 overflow-y-auto rounded border border-border p-2", children: [connections.map((c) => (_jsxs("label", { className: "flex items-center gap-2 text-xs cursor-pointer px-1 py-1 hover:bg-accent rounded", children: [_jsx(Checkbox, { checked: selected.has(c.id), onCheckedChange: (v) => {
                                                const next = new Set(selected);
                                                if (v)
                                                    next.add(c.id);
                                                else
                                                    next.delete(c.id);
                                                setSelected(next);
                                            } }), _jsx("span", { children: c.name }), _jsx("span", { className: "text-muted-foreground ml-auto", children: c.dialect.toLowerCase() })] }, c.id))), connections.length === 0 && (_jsx("div", { className: "text-xs text-muted-foreground px-1", children: "No connections yet." }))] })), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Expires" }), _jsx("div", { className: "flex gap-2", children: ["never", "30d", "90d", "365d"].map((e) => (_jsx("button", { type: "button", className: `flex-1 rounded border px-2 py-1 text-xs ${expiry === e
                                            ? "border-primary bg-primary/15 text-primary"
                                            : "border-border text-muted-foreground hover:text-foreground"}`, onClick: () => setExpiry(e), children: e === "never" ? "Never" : e }, e))) })] }), _jsxs(DialogFooter, { className: "pt-2", children: [_jsx(Button, { type: "button", variant: "ghost", onClick: () => onOpenChange(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: busy || !name || (scope === "selected" && selected.size === 0), children: [busy && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Create"] })] })] })] }) }));
}
function expiryDays(e) {
    return e === "30d" ? 30 : e === "90d" ? 90 : 365;
}
