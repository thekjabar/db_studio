import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { Activity, ArrowLeft, Database, Loader2, Search, ShieldCheck, Users, Webhook, } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, } from "recharts";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DialectBadge } from "@/components/dialect-badge";
export default function AdminRoute() {
    const user = useAuth((s) => s.user);
    const navigate = useNavigate();
    const [tab, setTab] = useState("overview");
    // Gate at the component level. The backend will 403 anyway, but avoiding
    // the blank dashboard for non-admins is a nicer UX than a toast.
    if (user && !user.isAdmin) {
        return _jsx(Navigate, { to: "/connections", replace: true });
    }
    return (_jsxs("div", { className: "min-h-screen bg-background text-foreground", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { type: "button", onClick: () => navigate("/connections"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1", children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), " Back to app"] }), _jsx("div", { className: "h-4 w-px bg-border" }), _jsxs("div", { className: "flex items-center gap-2 font-semibold", children: [_jsx(ShieldCheck, { className: "h-5 w-5 text-primary" }), "Admin"] })] }), _jsx("div", { className: "text-xs text-muted-foreground", children: user?.email })] }), _jsxs("div", { className: "max-w-6xl mx-auto px-6 py-6", children: [_jsxs("div", { className: "flex items-center gap-1 mb-6 border-b border-border", children: [_jsxs(TabButton, { active: tab === "overview", onClick: () => setTab("overview"), children: [_jsx(Activity, { className: "h-3.5 w-3.5" }), " Overview"] }), _jsxs(TabButton, { active: tab === "users", onClick: () => setTab("users"), children: [_jsx(Users, { className: "h-3.5 w-3.5" }), " Users"] }), _jsxs(TabButton, { active: tab === "incidents", onClick: () => setTab("incidents"), children: [_jsx(Activity, { className: "h-3.5 w-3.5" }), " Incidents"] })] }), tab === "overview" && _jsx(OverviewTab, {}), tab === "users" && _jsx(UsersTab, {}), tab === "incidents" && _jsx(IncidentsTab, {})] })] }));
}
function TabButton({ active, onClick, children, }) {
    return (_jsx("button", { type: "button", onClick: onClick, className: "inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px " +
            (active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"), children: children }));
}
function OverviewTab() {
    const overviewQ = useQuery({ queryKey: ["admin-overview"], queryFn: () => api.adminOverview() });
    const volumeQ = useQuery({ queryKey: ["admin-volume"], queryFn: () => api.adminQueryVolume() });
    const topConnQ = useQuery({ queryKey: ["admin-top-conns"], queryFn: () => api.adminTopConnections() });
    const topUsersQ = useQuery({ queryKey: ["admin-top-users"], queryFn: () => api.adminTopUsers() });
    const o = overviewQ.data;
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "grid grid-cols-2 sm:grid-cols-4 gap-3", children: [_jsx(Kpi, { label: "Users", value: o?.users, hint: `${o?.admins ?? 0} admin${o?.admins === 1 ? "" : "s"}` }), _jsx(Kpi, { label: "Workspaces", value: o?.workspaces }), _jsx(Kpi, { label: "Connections", value: o?.connections, icon: _jsx(Database, { className: "h-4 w-4 text-primary" }) }), _jsx(Kpi, { label: "Active webhooks", value: o?.webhooksEnabled, icon: _jsx(Webhook, { className: "h-4 w-4 text-primary" }) }), _jsx(Kpi, { label: "Scheduled queries", value: o?.scheduledQueriesEnabled }), _jsx(Kpi, { label: "API keys", value: o?.apiKeysActive }), _jsx(Kpi, { label: "Active users (24h)", value: o?.last24h.activeUsers, hint: `${o?.last24h.signups ?? 0} signups` }), _jsx(Kpi, { label: "Failed logins (24h)", value: o?.last24h.failedLogins, tone: o && o.last24h.failedLogins > 50 ? "warn" : undefined })] }), _jsxs("div", { className: "rounded-md border border-border bg-card p-4", children: [_jsx("div", { className: "text-sm font-semibold mb-1", children: "Query volume \u2014 last 24 hours" }), _jsx("p", { className: "text-xs text-muted-foreground mb-3", children: "Hourly buckets across all connections. Schema changes stacked on queries." }), _jsx("div", { className: "h-56", children: volumeQ.isLoading ? (_jsx("div", { className: "h-full flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) })) : (volumeQ.data ?? []).length === 0 ? (_jsx("div", { className: "h-full flex items-center justify-center text-xs text-muted-foreground", children: "No queries recorded in this window." })) : (_jsx(ResponsiveContainer, { width: "100%", height: "100%", children: _jsxs(AreaChart, { data: volumeQ.data, children: [_jsx(CartesianGrid, { strokeDasharray: "3 3", className: "stroke-border" }), _jsx(XAxis, { dataKey: "hour", tickFormatter: (v) => format(new Date(v), "HH:mm"), className: "text-[10px]" }), _jsx(YAxis, { className: "text-[10px]" }), _jsx(Tooltip, { labelFormatter: (v) => (typeof v === "string" ? format(new Date(v), "MMM d HH:mm") : ""), contentStyle: { fontSize: 12 } }), _jsx(Area, { type: "monotone", dataKey: "queries", stackId: "1", stroke: "#3b82f6", fill: "#3b82f6", fillOpacity: 0.3, name: "Queries" }), _jsx(Area, { type: "monotone", dataKey: "schemaChanges", stackId: "1", stroke: "#f59e0b", fill: "#f59e0b", fillOpacity: 0.3, name: "Schema changes" })] }) })) })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsx(TopList, { title: "Top connections (7d)", loading: topConnQ.isLoading, rows: (topConnQ.data ?? []).map((r) => ({
                            id: r.connectionId,
                            primary: r.name,
                            secondary: r.dialect ? _jsx(DialectBadge, { dialect: r.dialect }) : undefined,
                            count: r.queries,
                        })), emptyText: "No query activity recorded in the last 7 days." }), _jsx(TopList, { title: "Top users (7d)", loading: topUsersQ.isLoading, rows: (topUsersQ.data ?? []).map((r) => ({
                            id: r.userId,
                            primary: r.displayName || r.email,
                            secondary: r.displayName ? _jsx("span", { className: "text-muted-foreground", children: r.email }) : undefined,
                            count: r.queries,
                        })), emptyText: "No user activity recorded in the last 7 days." })] })] }));
}
function Kpi({ label, value, hint, icon, tone, }) {
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("span", { className: "text-xs text-muted-foreground", children: label }), icon] }), _jsx("div", { className: "text-2xl font-semibold mt-1 " + (tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""), children: value === undefined ? "…" : value.toLocaleString() }), hint && _jsx("div", { className: "text-[11px] text-muted-foreground mt-0.5", children: hint })] }));
}
function TopList({ title, loading, rows, emptyText, }) {
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-4", children: [_jsx("div", { className: "text-sm font-semibold mb-3", children: title }), loading ? (_jsx("div", { className: "text-xs text-muted-foreground", children: "Loading\u2026" })) : rows.length === 0 ? (_jsx("div", { className: "text-xs text-muted-foreground", children: emptyText })) : (_jsx("div", { className: "space-y-2", children: rows.map((r) => (_jsxs("div", { className: "flex items-center justify-between gap-3 text-sm border-b border-border last:border-b-0 pb-2 last:pb-0", children: [_jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "truncate", children: r.primary }), r.secondary && _jsx("div", { className: "text-[11px] mt-0.5", children: r.secondary })] }), _jsx("span", { className: "text-xs font-mono text-muted-foreground", children: r.count.toLocaleString() })] }, r.id))) }))] }));
}
function UsersTab() {
    const qc = useQueryClient();
    const me = useAuth((s) => s.user);
    const [search, setSearch] = useState("");
    const q = useQuery({
        queryKey: ["admin-users", search],
        queryFn: () => api.adminListUsers({ search: search || undefined }),
    });
    const toggle = useMutation({
        mutationFn: ({ id, isAdmin }) => api.adminSetUserAdmin(id, isAdmin),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["admin-users"] });
            qc.invalidateQueries({ queryKey: ["admin-overview"] });
        },
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    return (_jsxs("div", { className: "space-y-3", children: [_jsx("div", { className: "flex items-center gap-2", children: _jsxs("div", { className: "relative max-w-sm flex-1", children: [_jsx(Search, { className: "absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" }), _jsx(Input, { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search by email or name...", className: "pl-7 h-9 text-sm" })] }) }), _jsx("div", { className: "rounded-md border border-border bg-card overflow-hidden", children: _jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "border-b border-border bg-muted/30", children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "User" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Verified" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Joined" }), _jsx("th", { className: "text-right px-3 py-2 font-medium", children: "Admin" })] }) }), _jsxs("tbody", { children: [q.isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "px-3 py-8 text-center text-muted-foreground", children: _jsx(Loader2, { className: "h-4 w-4 animate-spin inline" }) }) })), q.data?.items.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "px-3 py-8 text-center text-muted-foreground", children: "No users match the search." }) })), q.data?.items.map((u) => (_jsxs("tr", { className: "border-b border-border last:border-b-0", children: [_jsxs("td", { className: "px-3 py-2", children: [_jsx("div", { className: "font-medium", children: u.displayName || u.email }), u.displayName && (_jsx("div", { className: "text-[10px] text-muted-foreground", children: u.email })), u.oauthProvider && (_jsx(Badge, { variant: "secondary", className: "text-[9px] mt-0.5", children: u.oauthProvider }))] }), _jsx("td", { className: "px-3 py-2 text-muted-foreground", children: u.emailVerifiedAt
                                                ? format(new Date(u.emailVerifiedAt), "MMM d yyyy")
                                                : "—" }), _jsx("td", { className: "px-3 py-2 text-muted-foreground", children: format(new Date(u.createdAt), "MMM d yyyy") }), _jsx("td", { className: "px-3 py-2 text-right", children: _jsx(Switch, { checked: u.isAdmin, disabled: toggle.isPending || u.id === me?.id, onCheckedChange: (next) => toggle.mutate({ id: u.id, isAdmin: next }) }) })] }, u.id)))] })] }) }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "You can't demote yourself from this screen. To remove the last admin, promote another user first, then sign in as them." })] }));
}
function IncidentsTab() {
    const qc = useQueryClient();
    const [open, setOpen] = useState(false);
    const list = useQuery({
        queryKey: ["admin-incidents"],
        queryFn: () => api.adminListIncidents(),
    });
    const del = useMutation({
        mutationFn: (id) => api.adminDeleteIncident(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["admin-incidents"] });
            toast.success("Deleted");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "text-sm text-muted-foreground", children: ["Events shown on the public ", _jsx("code", { children: "/status" }), " page."] }), _jsx(Button, { size: "sm", onClick: () => setOpen(true), children: "New incident" })] }), _jsxs("div", { className: "rounded-md border border-border bg-card divide-y divide-border", children: [list.data?.map((i) => (_jsx(IncidentRow, { incident: i, onChanged: () => qc.invalidateQueries({ queryKey: ["admin-incidents"] }), onDelete: () => del.mutate(i.id) }, i.id))), list.data?.length === 0 && (_jsx("div", { className: "p-6 text-center text-sm text-muted-foreground", children: "No incidents on record." }))] }), open && _jsx(NewIncidentDialog, { onClose: () => setOpen(false) })] }));
}
function IncidentRow({ incident, onChanged, onDelete, }) {
    const [updateOpen, setUpdateOpen] = useState(false);
    const [status, setStatus] = useState(incident.status);
    const [message, setMessage] = useState("");
    const [sending, setSending] = useState(false);
    const submit = async () => {
        if (!message.trim()) {
            toast.error("Message required");
            return;
        }
        setSending(true);
        try {
            await api.adminAddIncidentUpdate(incident.id, { status, message });
            setMessage("");
            setUpdateOpen(false);
            onChanged();
        }
        catch (e) {
            toast.error(extractErrorMessage(e));
        }
        finally {
            setSending(false);
        }
    };
    return (_jsxs("div", { className: "p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2 text-sm", children: [_jsx(Badge, { variant: incident.severity === "CRITICAL" ? "destructive" : incident.severity === "MAJOR" ? "warning" : "secondary", children: incident.severity }), _jsx(Badge, { variant: "secondary", className: "text-[10px]", children: incident.status }), _jsx("span", { className: "font-semibold truncate flex-1", children: incident.title }), _jsx("span", { className: "text-[11px] text-muted-foreground", children: format(new Date(incident.startedAt), "MMM d HH:mm") }), !incident.resolvedAt ? (_jsx(Button, { size: "sm", variant: "outline", onClick: () => setUpdateOpen((v) => !v), children: "Update" })) : null, _jsx("button", { onClick: onDelete, className: "text-muted-foreground hover:text-destructive p-1", title: "Delete", children: "\u00D7" })] }), incident.updates.length > 0 && (_jsx("div", { className: "text-[11px] font-mono space-y-0.5", children: incident.updates.slice().reverse().slice(0, 3).map((u, i) => (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: format(new Date(u.at), "MMM d HH:mm") }), " ", _jsxs("span", { className: "text-primary", children: ["[", u.status, "]"] }), " ", u.message] }, i))) })), updateOpen && (_jsxs("div", { className: "flex items-center gap-2 pt-1", children: [_jsxs("select", { value: status, onChange: (e) => setStatus(e.target.value), className: "text-xs px-2 py-1 rounded border border-border bg-background", children: [_jsx("option", { value: "INVESTIGATING", children: "Investigating" }), _jsx("option", { value: "IDENTIFIED", children: "Identified" }), _jsx("option", { value: "MONITORING", children: "Monitoring" }), _jsx("option", { value: "RESOLVED", children: "Resolved" })] }), _jsx(Input, { value: message, onChange: (e) => setMessage(e.target.value), placeholder: "Update message", className: "h-8 text-xs flex-1" }), _jsxs(Button, { size: "sm", onClick: submit, disabled: sending, children: [sending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), "Post"] })] }))] }));
}
function NewIncidentDialog({ onClose }) {
    const qc = useQueryClient();
    const [title, setTitle] = useState("");
    const [severity, setSeverity] = useState("MINOR");
    const [impact, setImpact] = useState("");
    const [message, setMessage] = useState("");
    const [saving, setSaving] = useState(false);
    const submit = async () => {
        if (!title.trim() || !message.trim()) {
            toast.error("Title + initial update required");
            return;
        }
        setSaving(true);
        try {
            await api.adminCreateIncident({
                title,
                severity,
                impact: impact || undefined,
                message,
            });
            toast.success("Created");
            qc.invalidateQueries({ queryKey: ["admin-incidents"] });
            onClose();
        }
        catch (e) {
            toast.error(extractErrorMessage(e));
        }
        finally {
            setSaving(false);
        }
    };
    return (_jsx("div", { className: "fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4", children: _jsxs("div", { className: "bg-card rounded-md border border-border w-full max-w-md p-4 space-y-3", children: [_jsx("h3", { className: "font-semibold", children: "New incident" }), _jsx(Input, { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Title" }), _jsxs("div", { className: "grid grid-cols-2 gap-2", children: [_jsxs("select", { value: severity, onChange: (e) => setSeverity(e.target.value), className: "text-xs px-2 py-2 rounded border border-border bg-background", children: [_jsx("option", { value: "MINOR", children: "Minor" }), _jsx("option", { value: "MAJOR", children: "Major" }), _jsx("option", { value: "CRITICAL", children: "Critical" })] }), _jsx(Input, { value: impact, onChange: (e) => setImpact(e.target.value), placeholder: "Impact (optional)" })] }), _jsx(Input, { value: message, onChange: (e) => setMessage(e.target.value), placeholder: "Initial update \u2014 what we know" }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsxs(Button, { onClick: submit, disabled: saving, children: [saving && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), "Create"] })] })] }) }));
}
