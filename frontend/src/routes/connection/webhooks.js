import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Plus, Play, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";
const ALL_EVENTS = ["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"];
export default function WebhooksRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(Inner, { connectionId: id });
}
function Inner({ connectionId }) {
    const qc = useQueryClient();
    const modal = useModal();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const [newSecret, setNewSecret] = useState(null);
    const listQ = useQuery({
        queryKey: ["webhooks", connectionId],
        queryFn: () => api.listWebhooks(connectionId),
    });
    const toggle = useMutation({
        mutationFn: ({ webhookId, enabled }) => api.updateWebhook(connectionId, webhookId, { enabled }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", connectionId] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const remove = useMutation({
        mutationFn: (webhookId) => api.deleteWebhook(connectionId, webhookId),
        onSuccess: () => {
            toast.success("Webhook deleted");
            qc.invalidateQueries({ queryKey: ["webhooks", connectionId] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const test = useMutation({
        mutationFn: (webhookId) => api.testWebhook(connectionId, webhookId),
        onSuccess: () => toast.success("Test delivery queued"),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-5xl mx-auto", children: [_jsxs("div", { className: "flex items-start justify-between gap-4 flex-wrap", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-lg font-semibold flex items-center gap-2", children: [_jsx(WebhookIcon, { className: "h-5 w-5" }), " Webhooks"] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "POST JSON to a URL when rows in a watched table change through DB Studio." })] }), _jsxs(Button, { onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New webhook"] })] }), _jsxs("div", { className: "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2", children: [_jsx(AlertTriangle, { className: "h-4 w-4 mt-0.5 shrink-0" }), _jsxs("div", { children: [_jsx("strong", { children: "Scope:" }), " Webhooks fire on row changes made through DB Studio's row APIs (Table view, bulk edit/delete). External writes to the target DB are not detected \u2014 that would require DB-native CDC (triggers / logical replication)."] })] }), listQ.isLoading ? (_jsxs("div", { className: "rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading\u2026"] })) : !listQ.data || listQ.data.length === 0 ? (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center", children: [_jsx("div", { className: "text-sm font-medium mb-1", children: "No webhooks yet" }), _jsx("div", { className: "text-xs text-muted-foreground mb-4", children: "Create one to be notified when a specific table changes." }), _jsxs(Button, { onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New webhook"] })] })) : (_jsx("div", { className: "space-y-3", children: listQ.data.map((w) => (_jsx(WebhookCard, { webhook: w, connectionId: connectionId, expanded: expandedId === w.id, onExpand: () => setExpandedId(expandedId === w.id ? null : w.id), onToggle: (enabled) => toggle.mutate({ webhookId: w.id, enabled }), onTest: () => test.mutate(w.id), onDelete: async () => {
                        const ok = await modal.confirm({
                            title: "Delete webhook",
                            description: `Remove "${w.name}"? Delivery history will be kept for a short time, then purged.`,
                            confirmLabel: "Delete",
                            destructive: true,
                        });
                        if (ok)
                            remove.mutate(w.id);
                    }, busy: toggle.isPending || test.isPending || remove.isPending }, w.id))) })), _jsx(NewWebhookDialog, { open: dialogOpen, onOpenChange: setDialogOpen, connectionId: connectionId, onCreated: (hookName, secret) => setNewSecret({ hookName, secret }) }), _jsx(Dialog, { open: !!newSecret, onOpenChange: (v) => !v && setNewSecret(null), children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Save this secret" }), _jsxs(DialogDescription, { children: ["Use it to verify the ", _jsx("code", { className: "bg-muted px-1 rounded", children: "X-DBStudio-Signature" }), " ", "header on incoming payloads. You won't see it again."] })] }), newSecret && (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "text-xs text-muted-foreground", children: ["Webhook: ", newSecret.hookName] }), _jsxs("div", { className: "flex items-stretch gap-2", children: [_jsx(Input, { readOnly: true, value: newSecret.secret, className: "font-mono text-xs flex-1", onFocus: (e) => e.currentTarget.select() }), _jsx(Button, { variant: "outline", size: "icon", className: "h-9 w-9", onClick: async () => {
                                                try {
                                                    await navigator.clipboard.writeText(newSecret.secret);
                                                    toast.success("Copied");
                                                }
                                                catch {
                                                    toast.error("Copy failed");
                                                }
                                            }, children: _jsx(Copy, { className: "h-4 w-4" }) })] }), _jsx("div", { className: "rounded bg-muted/50 p-2 text-xs font-mono", children: "signature := HMAC-SHA256(secret, request.body).hex()" })] })), _jsx(DialogFooter, { children: _jsx(Button, { onClick: () => setNewSecret(null), children: "I saved it" }) })] }) })] }));
}
function statusVariant(s) {
    if (s === "SUCCESS")
        return "default";
    if (s === "FAILED")
        return "destructive";
    if (s === "PENDING")
        return "info";
    return "secondary";
}
function WebhookCard({ webhook: w, connectionId, expanded, onExpand, onToggle, onTest, onDelete, busy, }) {
    return (_jsxs("div", { className: "rounded-md border border-border bg-card", children: [_jsxs("div", { className: "p-3 flex items-start gap-4", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("div", { className: "font-medium", children: w.name }), w.lastStatus && (_jsx(Badge, { variant: statusVariant(w.lastStatus), className: "text-[10px]", children: w.lastStatus })), _jsxs("span", { className: "text-xs text-muted-foreground font-mono truncate", children: [w.schemaName, ".", w.tableName] })] }), _jsxs("div", { className: "mt-1 text-xs text-muted-foreground flex flex-wrap gap-2 items-center", children: [_jsx("span", { className: "font-mono truncate max-w-lg", title: w.url, children: w.url }), _jsx("span", { children: "\u00B7" }), _jsx("span", { children: w.events.map((e) => e.replace("ROW_", "")).join(", ").toLowerCase() }), _jsx("span", { children: "\u00B7" }), _jsx("span", { children: w.lastFiredAt
                                            ? `last fired ${formatDistanceToNow(new Date(w.lastFiredAt), { addSuffix: true })}`
                                            : "never fired" })] })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("div", { className: "flex items-center gap-2 pr-2", children: [_jsx(Switch, { checked: w.enabled, onCheckedChange: onToggle, disabled: busy }), _jsx("span", { className: "text-xs text-muted-foreground", children: w.enabled ? "on" : "off" })] }), _jsxs(Button, { variant: "ghost", size: "sm", onClick: onTest, disabled: busy, children: [_jsx(Play, { className: "h-3.5 w-3.5" }), " Test"] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: onExpand, children: expanded ? "Hide" : "History" }), _jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8 text-destructive", onClick: onDelete, disabled: busy, children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }), expanded && _jsx(DeliveryHistory, { connectionId: connectionId, webhookId: w.id })] }));
}
function DeliveryHistory({ connectionId, webhookId }) {
    const q = useQuery({
        queryKey: ["webhook-deliveries", connectionId, webhookId],
        queryFn: () => api.listWebhookDeliveries(connectionId, webhookId, 30),
        refetchInterval: 5_000,
    });
    if (q.isLoading) {
        return _jsx("div", { className: "border-t border-border p-4 text-xs text-muted-foreground", children: "Loading\u2026" });
    }
    if (!q.data || q.data.length === 0) {
        return (_jsx("div", { className: "border-t border-border p-4 text-xs text-muted-foreground", children: "No deliveries yet. Click Test above to send a synthetic payload." }));
    }
    return (_jsx("div", { className: "border-t border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { className: "bg-muted/40 text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "When" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-24", children: "Event" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-20", children: "Attempt" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-20", children: "Status" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-20", children: "HTTP" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-20", children: "Time" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Detail" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: q.data.map((d) => (_jsxs("tr", { children: [_jsx("td", { className: "px-3 py-1.5 font-mono", children: formatDistanceToNow(new Date(d.startedAt), { addSuffix: true }) }), _jsx("td", { className: "px-3 py-1.5", children: d.event.replace("ROW_", "").toLowerCase() }), _jsx("td", { className: "px-3 py-1.5 font-mono", children: d.attempt }), _jsx("td", { className: "px-3 py-1.5", children: d.status === "SUCCESS" ? (_jsxs("span", { className: "flex items-center gap-1 text-emerald-500", children: [_jsx(CheckCircle2, { className: "h-3 w-3" }), " success"] })) : d.status === "FAILED" ? (_jsx("span", { className: "text-destructive", children: "failed" })) : (_jsx("span", { className: "text-muted-foreground", children: "pending" })) }), _jsx("td", { className: "px-3 py-1.5 text-right font-mono", children: d.httpStatus ?? "—" }), _jsx("td", { className: "px-3 py-1.5 text-right font-mono", children: d.durationMs != null ? `${d.durationMs}ms` : "—" }), _jsx("td", { className: cn("px-3 py-1.5 font-mono text-xs max-w-md truncate", d.status === "FAILED" && "text-destructive"), title: d.errorMessage ?? d.responseBody ?? "", children: d.errorMessage ?? d.responseBody ?? "" })] }, d.id))) })] }) }));
}
function NewWebhookDialog({ open, onOpenChange, connectionId, onCreated, }) {
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [schemaName, setSchemaName] = useState("");
    const [tableName, setTableName] = useState("");
    const [events, setEvents] = useState(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);
    const [submitting, setSubmitting] = useState(false);
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
        enabled: open,
    });
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, schemaName],
        queryFn: () => api.listTables(connectionId, schemaName),
        enabled: open && !!schemaName,
    });
    const reset = () => {
        setName("");
        setUrl("");
        setSchemaName("");
        setTableName("");
        setEvents(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);
    };
    const submit = async (e) => {
        e.preventDefault();
        if (events.length === 0) {
            toast.error("Pick at least one event");
            return;
        }
        setSubmitting(true);
        try {
            const payload = {
                name,
                url,
                schemaName,
                tableName,
                events,
                enabled: true,
            };
            const created = await api.createWebhook(connectionId, payload);
            toast.success("Webhook created");
            qc.invalidateQueries({ queryKey: ["webhooks", connectionId] });
            onCreated(created.name, created.secret);
            reset();
            onOpenChange(false);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setSubmitting(false);
        }
    };
    const toggleEvent = (e) => {
        setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => (v ? onOpenChange(true) : (reset(), onOpenChange(false))), children: _jsxs(DialogContent, { className: "max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New webhook" }), _jsx(DialogDescription, { children: "Fire a POST request to a URL when rows change in a specific table." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { required: true, value: name, onChange: (e) => setName(e.target.value), placeholder: "Notify orders service" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Target URL" }), _jsx(Input, { required: true, value: url, onChange: (e) => setUrl(e.target.value), placeholder: "https://api.example.com/hook" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Schema" }), _jsxs(Select, { value: schemaName || "__none__", onValueChange: (v) => { setSchemaName(v === "__none__" ? "" : v); setTableName(""); }, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick\u2026" }) }), _jsx(SelectContent, { children: (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, children: s }, s))) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Table" }), _jsxs(Select, { value: tableName || "__none__", onValueChange: (v) => setTableName(v === "__none__" ? "" : v), disabled: !schemaName, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: schemaName ? "Pick…" : "Pick schema first" }) }), _jsx(SelectContent, { children: (tablesQ.data ?? []).map((t) => (_jsx(SelectItem, { value: t.name, children: t.name }, t.name))) })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Events" }), _jsx("div", { className: "flex gap-2 flex-wrap", children: ALL_EVENTS.map((e) => (_jsx("button", { type: "button", onClick: () => toggleEvent(e), className: cn("px-2 py-1 rounded text-xs border", events.includes(e)
                                            ? "border-primary bg-primary/15 text-primary"
                                            : "border-border text-muted-foreground hover:text-foreground"), children: e.replace("ROW_", "").toLowerCase() }, e))) })] }), _jsxs(DialogFooter, { className: "pt-2", children: [_jsx(Button, { type: "button", variant: "ghost", onClick: () => onOpenChange(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: submitting || !schemaName || !tableName, children: [submitting && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Create"] })] })] })] }) }));
}
