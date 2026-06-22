import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Code2, Database, Loader2, Network, Pencil, Plus, Shield, ShieldCheck, Table2, Trash2, Zap } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { SshTunnelFields, defaultSshTunnel } from "@/components/ssh-tunnel-fields";
import { EditConnectionDialog } from "@/components/edit-connection-dialog";
import { useModal } from "@/components/modal-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DialectBadge } from "@/components/dialect-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";
const DIALECTS = [
    { value: "POSTGRES", label: "PostgreSQL", port: 5432 },
    { value: "MYSQL", label: "MySQL", port: 3306 },
    { value: "SQLITE", label: "SQLite", port: 0 },
    { value: "MSSQL", label: "SQL Server", port: 1433 },
];
// Quick-connect presets for popular managed providers. Host values are
// placeholder patterns the user edits — the point is the right port,
// SSL mode and default database out of the box.
const CONNECTION_PRESETS = [
    { label: "Supabase", dialect: "POSTGRES", host: "db.YOUR-PROJECT.supabase.co", port: 5432, sslMode: "require", database: "postgres", user: "postgres" },
    { label: "Neon", dialect: "POSTGRES", host: "YOUR-PROJECT.neon.tech", port: 5432, sslMode: "require" },
    { label: "AWS RDS", dialect: "POSTGRES", host: "YOUR-DB.xxxxx.rds.amazonaws.com", port: 5432, sslMode: "require" },
    { label: "Railway", dialect: "POSTGRES", host: "YOUR-PROJECT.railway.app", port: 5432, sslMode: "require", database: "railway", user: "postgres" },
    { label: "PlanetScale", dialect: "MYSQL", host: "aws.connect.psdb.cloud", port: 3306, sslMode: "require" },
    { label: "Local Postgres", dialect: "POSTGRES", host: "localhost", port: 5432, sslMode: "" },
];
export default function ConnectionsPage() {
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState(null);
    const qc = useQueryClient();
    const modal = useModal();
    const { user, clear } = useAuth();
    const nav = useNavigate();
    const [workspaceId, setWorkspaceId] = useState("");
    const wsQ = useQuery({ queryKey: ["workspaces"], queryFn: () => api.listWorkspaces() });
    const q = useQuery({
        queryKey: ["connections", workspaceId],
        queryFn: () => api.listConnections(workspaceId || undefined),
    });
    const del = useMutation({
        mutationFn: (id) => api.deleteConnection(id),
        onSuccess: () => {
            toast.success("Connection deleted");
            qc.invalidateQueries({ queryKey: ["connections"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const test = useMutation({
        mutationFn: (id) => api.testConnection(id),
        onSuccess: (r) => {
            if (r.ok)
                toast.success(`Connected${r.serverVersion ? ` — ${r.serverVersion}` : ""}`);
            else
                toast.error(r.message || "Connection failed");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const logout = async () => {
        try {
            await api.logout();
        }
        catch { }
        clear();
        qc.clear();
        nav("/login");
    };
    return (_jsxs("div", { className: "min-h-screen gradient-bg", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm", children: [_jsxs(Link, { to: "/connections", className: "flex items-center gap-2 font-semibold", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), "DB Studio"] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { to: "/dashboards", className: "text-sm text-muted-foreground hover:text-foreground", children: "Dashboards" }), _jsx(Link, { to: "/notebooks", className: "text-sm text-muted-foreground hover:text-foreground", children: "Notebooks" }), _jsx(Link, { to: "/schedules", className: "text-sm text-muted-foreground hover:text-foreground", children: "Schedules" }), _jsx(Link, { to: "/federated", className: "text-sm text-muted-foreground hover:text-foreground", children: "Multi-DB query" }), _jsx(Link, { to: "/api-keys", className: "text-sm text-muted-foreground hover:text-foreground", children: "API keys" }), _jsx("span", { className: "hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50", children: user?.email }), _jsx(ThemeToggle, {}), _jsx(Button, { variant: "ghost", size: "sm", onClick: logout, children: "Logout" })] })] }), _jsxs("div", { className: "max-w-6xl mx-auto px-6 py-10", children: [_jsxs("div", { className: "flex items-center justify-between mb-6 gap-4 flex-wrap", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Connections" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Databases you have access to." })] }), _jsxs("div", { className: "flex items-center gap-2", children: [wsQ.data && wsQ.data.length > 0 && (_jsxs(Select, { value: workspaceId || "all", onValueChange: (v) => setWorkspaceId(v === "all" ? "" : v), children: [_jsx(SelectTrigger, { className: "h-9 w-56", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "all", children: "All my workspaces" }), wsQ.data.map((w) => (_jsxs(SelectItem, { value: w.id, children: [w.name, w.isPersonal ? " (personal)" : ""] }, w.id)))] })] })), workspaceId && (() => {
                                        const ws = wsQ.data?.find((w) => w.id === workspaceId);
                                        // Only non-personal workspaces support SSO — a personal one is a
                                        // single-user bucket, configuring SSO on it makes no sense.
                                        if (!ws || ws.isPersonal)
                                            return null;
                                        return (_jsxs(Link, { to: `/workspaces/${workspaceId}/sso`, className: "inline-flex items-center gap-1 h-9 px-3 rounded-md border border-border hover:bg-accent text-xs font-medium", title: "Configure SSO for this workspace", children: [_jsx(ShieldCheck, { className: "h-3.5 w-3.5" }), " SSO"] }));
                                    })(), _jsxs(Button, { onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New connection"] })] })] }), q.isLoading && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4", children: [1, 2, 3].map((i) => (_jsx("div", { className: "rounded-lg border border-border bg-card h-40 animate-pulse" }, i))) })), q.error && (_jsxs("div", { className: "rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive", children: ["Failed to load connections: ", extractErrorMessage(q.error)] })), q.data && q.data.length === 0 && (_jsx(FirstRunGuide, { onCreate: () => setDialogOpen(true) })), q.data && q.data.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4", children: q.data.map((c) => (_jsxs("div", { className: "group relative rounded-lg border border-border bg-card p-5 hover:border-primary/50 transition-colors", children: [_jsxs("div", { className: "flex items-start justify-between mb-3", children: [_jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "font-semibold truncate", children: c.name }), _jsxs("div", { className: "text-xs text-muted-foreground font-mono truncate mt-0.5", children: [c.host, ":", c.port, "/", c.database] })] }), _jsx(DialectBadge, { dialect: c.dialect })] }), _jsxs("div", { className: "flex items-center gap-2 text-[10px] text-muted-foreground mb-4", children: [_jsx("span", { className: "font-mono", children: c.user }), c.readOnly && (_jsx("span", { className: "rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-400", children: "RO" }))] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: () => test.mutate(c.id), disabled: test.isPending && test.variables === c.id, children: [test.isPending && test.variables === c.id ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(Zap, { className: "h-3.5 w-3.5" })), "Test"] }), _jsx(Button, { size: "sm", asChild: true, children: _jsxs(Link, { to: `/c/${c.id}/t/public/`, children: ["Connect ", _jsx(ArrowRight, { className: "h-3.5 w-3.5" })] }) }), _jsx(Button, { size: "icon", variant: "ghost", title: "Edit connection", onClick: () => setEditing(c), children: _jsx(Pencil, { className: "h-3.5 w-3.5" }) }), _jsx(Button, { size: "icon", variant: "ghost", className: "text-destructive hover:text-destructive", onClick: async () => {
                                                const ok = await modal.confirm({
                                                    title: `Delete "${c.name}"?`,
                                                    description: "This removes the connection. It cannot be undone.",
                                                    confirmLabel: "Delete",
                                                    destructive: true,
                                                });
                                                if (ok)
                                                    del.mutate(c.id);
                                            }, children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }, c.id))) }))] }), _jsx(NewConnectionDialog, { open: dialogOpen, onOpenChange: setDialogOpen }), _jsx(EditConnectionDialog, { connection: editing, onOpenChange: (v) => !v && setEditing(null) })] }));
}
function FirstRunGuide({ onCreate }) {
    // Three explicit steps — the user hits the first-run guide with zero
    // connections, so step 1 is always active. Step 2/3 appear grayed so the
    // user sees what's next without feeling dumped-in.
    const steps = [
        {
            n: 1,
            title: "Add your first connection",
            desc: "Postgres, MySQL, SQL Server, or SQLite. Credentials are AES-256-GCM encrypted at rest and never leave the server in plain text.",
            active: true,
            cta: { label: "Add connection", onClick: onCreate },
        },
        {
            n: 2,
            title: "Browse or query",
            desc: "Click a table to filter/sort/edit rows, or hit the SQL editor (Ctrl+K → SQL Editor) to run queries.",
            active: false,
        },
        {
            n: 3,
            title: "Share with your team",
            desc: "Workspaces group connections; per-table grants + column masks give VIEWERs safe read-only access to production.",
            active: false,
        },
    ];
    const features = [
        {
            icon: Table2,
            title: "Browse tables",
            desc: "Filter, sort, edit rows and bulk-delete with PK-safe updates.",
        },
        {
            icon: Code2,
            title: "Run SQL",
            desc: "Query editor with autosave history and destructive-statement guards.",
        },
        {
            icon: Network,
            title: "Visualise relationships",
            desc: "Auto-generated ER diagram from your foreign keys.",
        },
        {
            icon: Shield,
            title: "Audit every change",
            desc: "Schema edits, inserts, updates and deletes all get logged.",
        },
    ];
    return (_jsxs("div", { className: "rounded-xl border border-dashed border-border bg-card/50 p-8 md:p-12 space-y-10", children: [_jsxs("div", { className: "max-w-2xl mx-auto text-center space-y-3", children: [_jsx("div", { className: "h-12 w-12 mx-auto rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h2", { className: "text-xl font-semibold", children: "Welcome to DB Studio" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "3 steps to a connected, queryable database. Most teams finish in under 2 minutes." })] }), _jsx("ol", { className: "mx-auto max-w-2xl space-y-3", children: steps.map((s) => (_jsxs("li", { className: `flex gap-3 rounded-lg border p-4 transition-colors ${s.active
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-card/60 opacity-70"}`, children: [_jsx("div", { className: `h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold ${s.active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`, children: s.n }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { className: "font-medium", children: s.title }), _jsx("div", { className: "text-sm text-muted-foreground mt-0.5", children: s.desc }), s.cta && s.active && (_jsx("div", { className: "mt-3", children: _jsxs(Button, { onClick: s.cta.onClick, children: [_jsx(Plus, { className: "h-4 w-4" }), " ", s.cta.label] }) }))] })] }, s.n))) }), _jsxs("div", { className: "mt-8", children: [_jsx("div", { className: "text-xs uppercase tracking-wider text-muted-foreground text-center mb-3", children: "What you'll get" }), _jsx("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto", children: features.map((f) => (_jsxs("div", { className: "flex items-start gap-3 rounded-lg border border-border bg-card p-3", children: [_jsx("div", { className: "h-8 w-8 shrink-0 rounded-md bg-muted flex items-center justify-center text-muted-foreground", children: _jsx(f.icon, { className: "h-4 w-4" }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "text-sm font-medium", children: f.title }), _jsx("div", { className: "text-xs text-muted-foreground", children: f.desc })] })] }, f.title))) })] })] }));
}
function NewConnectionDialog({ open, onOpenChange }) {
    const qc = useQueryClient();
    const [dialect, setDialect] = useState("POSTGRES");
    const [name, setName] = useState("");
    const [host, setHost] = useState("localhost");
    const [port, setPort] = useState(5432);
    const [database, setDatabase] = useState("");
    const [user, setUser] = useState("");
    const [password, setPassword] = useState("");
    const [readOnly, setReadOnly] = useState(false);
    const [sslMode, setSslMode] = useState("");
    const [sshEnabled, setSshEnabled] = useState(false);
    const [ssh, setSsh] = useState(defaultSshTunnel);
    const [submitting, setSubmitting] = useState(false);
    const reset = () => {
        setName("");
        setHost("localhost");
        setPort(5432);
        setDatabase("");
        setUser("");
        setPassword("");
        setReadOnly(false);
        setSslMode("");
        setSshEnabled(false);
        setSsh(defaultSshTunnel());
        setDialect("POSTGRES");
    };
    const submit = async (e) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const input = {
                name,
                dialect,
                host,
                port,
                database,
                user,
                password,
                readOnly,
                sslMode: sslMode || undefined,
                ssh: sshEnabled ? ssh : undefined,
            };
            const created = await api.createConnection(input);
            toast.success("Connection created");
            try {
                const r = await api.testConnection(created.id);
                if (r.ok)
                    toast.success(`Test OK${r.serverVersion ? ` — ${r.serverVersion}` : ""}`);
                else
                    toast.warning(r.message || "Created but test failed");
            }
            catch (err) {
                toast.warning("Created but test failed: " + extractErrorMessage(err));
            }
            qc.invalidateQueries({ queryKey: ["connections"] });
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
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New connection" }), _jsx(DialogDescription, { children: "Connect to a database server." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsx("div", { className: "flex flex-wrap gap-1.5", children: CONNECTION_PRESETS.map((p) => (_jsx("button", { type: "button", onClick: () => {
                                    setDialect(p.dialect);
                                    setHost(p.host);
                                    setPort(p.port);
                                    setSslMode(p.sslMode);
                                    if (p.database)
                                        setDatabase(p.database);
                                    if (p.user)
                                        setUser(p.user);
                                }, className: "text-[11px] px-2 py-1 rounded-full border border-border hover:border-primary hover:text-primary transition-colors", children: p.label }, p.label))) }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { required: true, value: name, onChange: (e) => setName(e.target.value), placeholder: "My Database" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Dialect" }), _jsxs(Select, { value: dialect, onValueChange: (v) => {
                                                setDialect(v);
                                                const d = DIALECTS.find((d) => d.value === v);
                                                if (d)
                                                    setPort(d.port);
                                            }, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: DIALECTS.map((d) => (_jsx(SelectItem, { value: d.value, children: d.label }, d.value))) })] })] })] }), _jsxs("div", { className: "grid grid-cols-[1fr_140px] gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Host" }), _jsx(Input, { required: true, value: host, onChange: (e) => setHost(e.target.value) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Port" }), _jsx(NumberInput, { value: String(port), onChange: (v) => setPort(parseInt(v, 10) || 0), integer: true, min: 1, max: 65535 })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Database" }), _jsx(Input, { required: true, value: database, onChange: (e) => setDatabase(e.target.value) })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "User" }), _jsx(Input, { required: true, value: user, onChange: (e) => setUser(e.target.value) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Password" }), _jsx(Input, { type: "password", value: password, onChange: (e) => setPassword(e.target.value) })] })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SSL mode" }), _jsx(Input, { value: sslMode, onChange: (e) => setSslMode(e.target.value), placeholder: "disable | require" })] }), _jsxs("div", { className: "flex items-center gap-2 pt-5", children: [_jsx(Switch, { checked: readOnly, onCheckedChange: setReadOnly, id: "ro" }), _jsx("label", { htmlFor: "ro", className: "text-sm", children: "Read only" })] })] }), _jsx(SshTunnelFields, { enabled: sshEnabled, onEnabledChange: setSshEnabled, value: ssh, onChange: setSsh }), _jsxs(DialogFooter, { className: "pt-2", children: [_jsx(Button, { type: "button", variant: "ghost", onClick: () => onOpenChange(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: submitting, children: [submitting && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Create & test"] })] })] })] }) }));
}
