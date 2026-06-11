import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ArrowLeft, BarChart3, Database, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";
export default function DashboardsListRoute() {
    const nav = useNavigate();
    const qc = useQueryClient();
    const modal = useModal();
    const [dialogOpen, setDialogOpen] = useState(false);
    const dashQ = useQuery({ queryKey: ["dashboards"], queryFn: () => api.listDashboards() });
    const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });
    const del = useMutation({
        mutationFn: (id) => api.deleteDashboard(id),
        onSuccess: () => {
            toast.success("Dashboard deleted");
            qc.invalidateQueries({ queryKey: ["dashboards"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "min-h-screen bg-background text-foreground", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { type: "button", onClick: () => nav("/connections"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1", children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), " Back"] }), _jsx("div", { className: "h-4 w-px bg-border" }), _jsxs("div", { className: "flex items-center gap-2 font-semibold", children: [_jsx(BarChart3, { className: "h-5 w-5 text-primary" }), "Dashboards"] })] }), _jsxs(Button, { onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New dashboard"] })] }), _jsxs("div", { className: "max-w-5xl mx-auto px-6 py-8", children: [dashQ.isLoading && _jsx("div", { className: "text-muted-foreground", children: "Loading..." }), dashQ.data?.length === 0 && (_jsxs("div", { className: "rounded-md border border-border bg-card p-10 text-center", children: [_jsx(BarChart3, { className: "h-10 w-10 text-muted-foreground mx-auto mb-2" }), _jsx("div", { className: "font-semibold", children: "No dashboards yet" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1 max-w-md mx-auto", children: "Create a dashboard to pin saved queries as charts. Auto-refresh on a timer, share via read-only link." }), _jsxs(Button, { className: "mt-4", onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " Create dashboard"] })] })), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3", children: dashQ.data?.map((d) => {
                            const conn = connsQ.data?.find((c) => c.id === d.connectionId);
                            return (_jsxs("div", { className: "rounded-md border border-border bg-card p-4 hover:border-primary/40 transition-colors group", children: [_jsxs(Link, { to: `/dashboards/${d.id}`, className: "block", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1", children: [_jsx("div", { className: "font-semibold truncate flex-1", children: d.name }), _jsxs("span", { className: "text-[10px] font-mono text-muted-foreground", children: [d._count.tiles, " tile", d._count.tiles === 1 ? "" : "s"] })] }), d.description && (_jsx("p", { className: "text-xs text-muted-foreground line-clamp-2 mb-2", children: d.description })), _jsxs("div", { className: "text-[11px] text-muted-foreground space-y-0.5", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Database, { className: "h-3 w-3" }), conn?.name ?? "(unknown connection)"] }), _jsxs("div", { children: ["Updated ", format(new Date(d.updatedAt), "MMM d, HH:mm")] })] })] }), _jsx("button", { type: "button", onClick: async () => {
                                            const ok = await modal.confirm({
                                                title: `Delete dashboard "${d.name}"?`,
                                                description: "Tiles and share link are also removed.",
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                del.mutate(d.id);
                                        }, className: "opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive", title: "Delete", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] }, d.id));
                        }) })] }), dialogOpen && (_jsx(CreateDashboardDialog, { open: dialogOpen, onClose: () => setDialogOpen(false), connections: connsQ.data ?? [] }))] }));
}
function CreateDashboardDialog({ open, onClose, connections, }) {
    const nav = useNavigate();
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
    const sorted = useMemo(() => [...connections].sort((a, b) => a.name.localeCompare(b.name)), [connections]);
    const create = useMutation({
        mutationFn: () => api.createDashboard({
            name: name.trim(),
            description: description.trim() || undefined,
            connectionId,
        }),
        onSuccess: (d) => {
            toast.success("Dashboard created");
            qc.invalidateQueries({ queryKey: ["dashboards"] });
            onClose();
            nav(`/dashboards/${d.id}`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const submit = (e) => {
        e.preventDefault();
        if (!name.trim()) {
            toast.error("Name required");
            return;
        }
        if (!connectionId) {
            toast.error("Pick a connection");
            return;
        }
        create.mutate();
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New dashboard" }), _jsx(DialogDescription, { children: "Pick a connection and give the dashboard a name. You'll add tiles (saved queries) next." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: "e.g. Signup funnel", maxLength: 120, autoFocus: true })] }), _jsxs("div", { children: [_jsx(Label, { children: "Description (optional)" }), _jsx(Input, { value: description, onChange: (e) => setDescription(e.target.value), placeholder: "What this dashboard shows at a glance", maxLength: 500 })] }), _jsxs("div", { children: [_jsx(Label, { children: "Connection" }), _jsxs(Select, { value: connectionId, onValueChange: setConnectionId, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick one" }) }), _jsx(SelectContent, { children: sorted.map((c) => (_jsx(SelectItem, { value: c.id, children: c.name }, c.id))) })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { type: "button", variant: "ghost", onClick: onClose, disabled: create.isPending, children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: create.isPending, children: [create.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Create"] })] })] })] }) }));
}
