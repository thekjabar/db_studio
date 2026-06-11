import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ArrowLeft, BookOpen, Database, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";
export default function NotebooksListRoute() {
    const nav = useNavigate();
    const qc = useQueryClient();
    const modal = useModal();
    const [dialogOpen, setDialogOpen] = useState(false);
    const nbQ = useQuery({ queryKey: ["notebooks"], queryFn: () => api.listNotebooks() });
    const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });
    const del = useMutation({
        mutationFn: (id) => api.deleteNotebook(id),
        onSuccess: () => {
            toast.success("Notebook deleted");
            qc.invalidateQueries({ queryKey: ["notebooks"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "min-h-screen bg-background text-foreground", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { type: "button", onClick: () => nav("/connections"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1", children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), " Back"] }), _jsx("div", { className: "h-4 w-px bg-border" }), _jsxs("div", { className: "flex items-center gap-2 font-semibold", children: [_jsx(BookOpen, { className: "h-5 w-5 text-primary" }), "Notebooks"] })] }), _jsxs(Button, { onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " New notebook"] })] }), _jsxs("div", { className: "max-w-5xl mx-auto px-6 py-8", children: [nbQ.isLoading && _jsx("div", { className: "text-muted-foreground", children: "Loading..." }), nbQ.data?.length === 0 && (_jsxs("div", { className: "rounded-md border border-border bg-card p-10 text-center", children: [_jsx(BookOpen, { className: "h-10 w-10 text-muted-foreground mx-auto mb-2" }), _jsx("div", { className: "font-semibold", children: "No notebooks yet" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1 max-w-md mx-auto", children: "A notebook mixes markdown docs with SQL cells \u2014 perfect for runbooks, postmortem queries, or step-by-step investigations." }), _jsxs(Button, { className: "mt-4", onClick: () => setDialogOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " Create notebook"] })] })), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3", children: nbQ.data?.map((n) => {
                            const conn = connsQ.data?.find((c) => c.id === n.connectionId);
                            return (_jsxs("div", { className: "relative rounded-md border border-border bg-card p-4 hover:border-primary/40 transition-colors group", children: [_jsxs(Link, { to: `/notebooks/${n.id}`, className: "block", children: [_jsx("div", { className: "font-semibold truncate", children: n.name }), n.description && (_jsx("p", { className: "text-xs text-muted-foreground line-clamp-2 mt-1", children: n.description })), _jsxs("div", { className: "text-[11px] text-muted-foreground space-y-0.5 mt-2", children: [_jsxs("div", { className: "flex items-center gap-1.5", children: [_jsx(Database, { className: "h-3 w-3" }), conn?.name ?? "(unknown connection)"] }), _jsxs("div", { children: ["Updated ", format(new Date(n.updatedAt), "MMM d, HH:mm")] })] })] }), _jsx("button", { type: "button", onClick: async () => {
                                            const ok = await modal.confirm({
                                                title: `Delete "${n.name}"?`,
                                                description: "This removes the notebook and all its cells.",
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                del.mutate(n.id);
                                        }, className: "opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] }, n.id));
                        }) })] }), dialogOpen && (_jsx(CreateNotebookDialog, { open: dialogOpen, onClose: () => setDialogOpen(false), connections: connsQ.data ?? [] }))] }));
}
function CreateNotebookDialog({ open, onClose, connections, }) {
    const nav = useNavigate();
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
    const create = useMutation({
        mutationFn: () => api.createNotebook({
            name: name.trim(),
            description: description.trim() || undefined,
            connectionId,
        }),
        onSuccess: (n) => {
            toast.success("Notebook created");
            qc.invalidateQueries({ queryKey: ["notebooks"] });
            onClose();
            nav(`/notebooks/${n.id}`);
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
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New notebook" }), _jsx(DialogDescription, { children: "A notebook owns an ordered list of markdown + SQL cells. Pick the connection its SQL cells will run against \u2014 that can't be changed later." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), autoFocus: true, maxLength: 120 })] }), _jsxs("div", { children: [_jsx(Label, { children: "Description (optional)" }), _jsx(Input, { value: description, onChange: (e) => setDescription(e.target.value), maxLength: 500 })] }), _jsxs("div", { children: [_jsx(Label, { children: "Connection" }), _jsxs(Select, { value: connectionId, onValueChange: setConnectionId, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick one" }) }), _jsx(SelectContent, { children: connections.map((c) => (_jsx(SelectItem, { value: c.id, children: c.name }, c.id))) })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { type: "button", variant: "ghost", onClick: onClose, disabled: create.isPending, children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: create.isPending, children: [create.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Create"] })] })] })] }) }));
}
