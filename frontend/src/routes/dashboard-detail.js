import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, BarChart3, Copy, Edit2, Loader2, Pencil, Plus, RefreshCw, Share2, Trash2, } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { QueryChart } from "@/components/query-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";
const REFRESH_PRESETS = [
    { label: "Off", value: null },
    { label: "30 s", value: 30 },
    { label: "1 min", value: 60 },
    { label: "5 min", value: 300 },
    { label: "15 min", value: 900 },
];
export default function DashboardDetailRoute() {
    const { id } = useParams();
    const nav = useNavigate();
    const qc = useQueryClient();
    const modal = useModal();
    const [addTileOpen, setAddTileOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const dashQ = useQuery({
        queryKey: ["dashboard", id],
        queryFn: () => api.getDashboard(id),
        enabled: !!id,
    });
    const del = useMutation({
        mutationFn: () => api.deleteDashboard(id),
        onSuccess: () => {
            toast.success("Deleted");
            nav("/dashboards");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const setRefresh = useMutation({
        mutationFn: (refreshSec) => api.updateDashboard(id, { refreshSec }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", id] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const removeTile = useMutation({
        mutationFn: (tileId) => api.removeDashboardTile(id, tileId),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", id] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const d = dashQ.data;
    if (dashQ.isLoading) {
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-5 w-5 animate-spin" }) }));
    }
    if (!d) {
        return _jsx("div", { className: "p-8 text-destructive", children: "Dashboard not found." });
    }
    return (_jsxs("div", { className: "min-h-screen bg-background", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3 min-w-0 flex-1", children: [_jsx("button", { type: "button", onClick: () => nav("/dashboards"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0", children: _jsx(ArrowLeft, { className: "h-4 w-4" }) }), _jsx("div", { className: "h-4 w-px bg-border shrink-0" }), _jsx(BarChart3, { className: "h-5 w-5 text-primary shrink-0" }), _jsxs("div", { className: "min-w-0", children: [_jsx("div", { className: "font-semibold truncate", children: d.name }), d.description && (_jsx("div", { className: "text-[11px] text-muted-foreground truncate", children: d.description }))] }), _jsx("button", { type: "button", onClick: () => setRenameOpen(true), className: "text-muted-foreground hover:text-foreground shrink-0", title: "Edit name/description", children: _jsx(Pencil, { className: "h-3.5 w-3.5" }) })] }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsxs(Select, { value: String(d.refreshSec ?? "null"), onValueChange: (v) => setRefresh.mutate(v === "null" ? null : Number(v)), children: [_jsx(SelectTrigger, { className: "h-8 w-28 text-xs", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: REFRESH_PRESETS.map((p) => (_jsx(SelectItem, { value: String(p.value ?? "null"), children: p.label }, String(p.value)))) })] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: () => setShareOpen(true), children: [_jsx(Share2, { className: "h-3.5 w-3.5" }), " Share"] }), _jsxs(Button, { size: "sm", onClick: () => setAddTileOpen(true), children: [_jsx(Plus, { className: "h-3.5 w-3.5" }), " Add tile"] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: async () => {
                                    const ok = await modal.confirm({
                                        title: `Delete "${d.name}"?`,
                                        description: "Tiles and share link are also removed.",
                                        confirmLabel: "Delete",
                                        destructive: true,
                                    });
                                    if (ok)
                                        del.mutate();
                                }, className: "text-destructive hover:text-destructive", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }), _jsxs("div", { className: "p-6", children: [d.tiles.length === 0 && (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center max-w-xl mx-auto", children: [_jsx(BarChart3, { className: "h-10 w-10 text-muted-foreground mx-auto mb-2" }), _jsx("div", { className: "font-semibold", children: "No tiles yet" }), _jsxs("p", { className: "text-sm text-muted-foreground mt-1", children: ["Pin a saved query as a tile. Use the ", _jsx("strong", { children: "Save" }), " button in the SQL editor first to create saved queries against this connection."] }), _jsxs(Button, { className: "mt-4", onClick: () => setAddTileOpen(true), children: [_jsx(Plus, { className: "h-4 w-4" }), " Add tile"] })] })), _jsx("div", { className: "grid gap-3", style: { gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }, children: d.tiles.map((t) => (_jsx(TileCard, { dashboardId: d.id, tile: t, refreshSec: d.refreshSec ?? null, onRemove: () => removeTile.mutate(t.id) }, t.id))) })] }), addTileOpen && (_jsx(AddTileDialog, { open: addTileOpen, onClose: () => setAddTileOpen(false), dashboard: d })), renameOpen && (_jsx(RenameDialog, { open: renameOpen, onClose: () => setRenameOpen(false), dashboard: d })), shareOpen && (_jsx(ShareDialog, { open: shareOpen, onClose: () => setShareOpen(false), dashboard: d }))] }));
}
function TileCard({ dashboardId, tile, refreshSec, onRemove, }) {
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const runRef = useRef(() => Promise.resolve());
    const chart = (tile.chartOverride ?? tile.savedQuery.chartConfig);
    runRef.current = async () => {
        setLoading(true);
        setError(null);
        try {
            const r = await api.runDashboardTile(dashboardId, tile.id);
            setResult(r);
        }
        catch (err) {
            setError(extractErrorMessage(err));
        }
        finally {
            setLoading(false);
        }
    };
    // Initial run + polling.
    useEffect(() => {
        void runRef.current();
        if (!refreshSec)
            return;
        const iv = setInterval(() => void runRef.current(), refreshSec * 1000);
        return () => clearInterval(iv);
    }, [refreshSec, tile.id]);
    return (_jsxs("div", { className: "rounded-md border border-border bg-card overflow-hidden flex flex-col", style: { gridColumn: `span ${tile.w} / span ${tile.w}`, minHeight: tile.h * 60 + 60 }, children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-b border-border", children: [_jsx("div", { className: "text-sm font-medium truncate", children: tile.title ?? tile.savedQuery.name }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [_jsx("button", { type: "button", className: "text-muted-foreground hover:text-foreground p-1", onClick: () => void runRef.current(), title: "Refresh now", disabled: loading, children: _jsx(RefreshCw, { className: "h-3.5 w-3.5 " + (loading ? "animate-spin" : "") }) }), _jsx("button", { type: "button", className: "text-muted-foreground hover:text-destructive p-1", onClick: onRemove, title: "Remove tile", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] })] }), _jsxs("div", { className: "flex-1 min-h-0 p-2", children: [error && _jsx("div", { className: "p-3 text-xs text-destructive", children: error }), !error && !result && loading && (_jsx("div", { className: "h-full flex items-center justify-center text-muted-foreground", children: _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) })), !error && result && chart && _jsx(QueryChart, { config: chart, rows: result.rows, height: tile.h * 60 }), !error && result && !chart && _jsx(TileTable, { result: result, maxHeight: tile.h * 60 + 40 })] })] }));
}
function TileTable({ result, maxHeight }) {
    const cols = result.fields.map((f) => f.name);
    return (_jsx("div", { className: "overflow-auto text-xs", style: { maxHeight }, children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "sticky top-0 bg-card", children: _jsx("tr", { children: cols.map((c) => (_jsx("th", { className: "text-left px-2 py-1 font-medium text-muted-foreground border-b border-border", children: c }, c))) }) }), _jsx("tbody", { children: result.rows.slice(0, 200).map((r, i) => (_jsx("tr", { className: "border-b border-border last:border-b-0", children: cols.map((c) => (_jsx("td", { className: "px-2 py-1 font-mono", children: formatCell(r[c]) }, c))) }, i))) })] }) }));
}
function formatCell(v) {
    if (v === null || v === undefined)
        return "";
    if (typeof v === "object")
        return JSON.stringify(v);
    return String(v);
}
function AddTileDialog({ open, onClose, dashboard, }) {
    const qc = useQueryClient();
    const [savedQueryId, setSavedQueryId] = useState("");
    const [title, setTitle] = useState("");
    const [width, setWidth] = useState(6);
    const [height, setHeight] = useState(4);
    const savedQ = useQuery({
        queryKey: ["saved-queries", dashboard.connectionId],
        queryFn: () => api.listSavedQueries(dashboard.connectionId),
    });
    const add = useMutation({
        mutationFn: () => api.addDashboardTile(dashboard.id, {
            savedQueryId,
            title: title.trim() || undefined,
            w: width,
            h: height,
        }),
        onSuccess: () => {
            toast.success("Tile added");
            qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
            onClose();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const available = (savedQ.data ?? []);
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Add tile" }), _jsx(DialogDescription, { children: "Pick a saved query. To create one, open the SQL editor on this connection and click Save." })] }), available.length === 0 ? (_jsxs("div", { className: "text-sm text-muted-foreground py-4", children: ["No saved queries on this connection yet.", " ", _jsx(Link, { to: `/c/${dashboard.connectionId}/sql`, className: "text-primary hover:underline", onClick: onClose, children: "Open SQL editor" })] })) : (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Saved query" }), _jsxs(Select, { value: savedQueryId, onValueChange: setSavedQueryId, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick a saved query" }) }), _jsx(SelectContent, { children: available.map((q) => (_jsxs(SelectItem, { value: q.id, children: [q.name, q.chartConfig ? ` (${q.chartConfig.type})` : ""] }, q.id))) })] })] }), _jsxs("div", { children: [_jsx(Label, { children: "Title override (optional)" }), _jsx(Input, { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Defaults to the saved query's name", maxLength: 120 })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Width (1\u201312)" }), _jsx(Input, { type: "number", min: 1, max: 12, value: width, onChange: (e) => setWidth(Math.max(1, Math.min(12, Number(e.target.value)))) })] }), _jsxs("div", { children: [_jsx(Label, { children: "Height (1\u201320)" }), _jsx(Input, { type: "number", min: 1, max: 20, value: height, onChange: (e) => setHeight(Math.max(1, Math.min(20, Number(e.target.value)))) })] })] })] })), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsxs(Button, { onClick: () => {
                                if (!savedQueryId) {
                                    toast.error("Pick a saved query");
                                    return;
                                }
                                add.mutate();
                            }, disabled: add.isPending || !savedQueryId, children: [add.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Add"] })] })] }) }));
}
function RenameDialog({ open, onClose, dashboard, }) {
    const qc = useQueryClient();
    const [name, setName] = useState(dashboard.name);
    const [description, setDescription] = useState(dashboard.description ?? "");
    const save = useMutation({
        mutationFn: () => api.updateDashboard(dashboard.id, {
            name: name.trim(),
            description: description.trim() || null,
        }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
            qc.invalidateQueries({ queryKey: ["dashboards"] });
            toast.success("Saved");
            onClose();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsx(DialogHeader, { children: _jsx(DialogTitle, { children: "Edit dashboard" }) }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), maxLength: 120 })] }), _jsxs("div", { children: [_jsx(Label, { children: "Description" }), _jsx(Input, { value: description, onChange: (e) => setDescription(e.target.value), maxLength: 500 })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: onClose, children: "Cancel" }), _jsxs(Button, { onClick: () => save.mutate(), disabled: save.isPending || !name.trim(), children: [save.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Save"] })] })] }) }));
}
function ShareDialog({ open, onClose, dashboard, }) {
    const qc = useQueryClient();
    const [token, setToken] = useState(dashboard.shareToken);
    const publicUrl = useMemo(() => (token ? `${window.location.origin}/d/${token}` : null), [token]);
    const rotate = useMutation({
        mutationFn: (share) => api.shareDashboard(dashboard.id, share),
        onSuccess: (r) => {
            setToken(r.shareToken);
            qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
            qc.invalidateQueries({ queryKey: ["dashboards"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const copy = async () => {
        if (!publicUrl)
            return;
        await navigator.clipboard.writeText(publicUrl);
        toast.success("Link copied");
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Share dashboard" }), _jsx(DialogDescription, { children: "Anyone with the link can view this dashboard without signing in. Tiles run with viewer role; no destructive SQL is allowed." })] }), _jsx("div", { className: "space-y-3", children: publicUrl ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Input, { value: publicUrl, readOnly: true, className: "font-mono text-xs" }), _jsxs(Button, { size: "sm", variant: "outline", onClick: copy, children: [_jsx(Copy, { className: "h-3.5 w-3.5" }), " Copy"] })] }), _jsxs("div", { className: "flex items-center justify-between pt-2 border-t border-border", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: () => rotate.mutate(true), disabled: rotate.isPending, children: [_jsx(Edit2, { className: "h-3.5 w-3.5" }), " Rotate link"] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: () => rotate.mutate(false), disabled: rotate.isPending, className: "text-destructive hover:text-destructive", children: "Revoke" })] })] })) : (_jsxs("div", { className: "text-center py-4", children: [_jsx("p", { className: "text-sm text-muted-foreground mb-3", children: "No share link yet. Enable it to get a public URL." }), _jsxs(Button, { onClick: () => rotate.mutate(true), disabled: rotate.isPending, children: [rotate.isPending && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Enable sharing"] })] })) }), _jsx(DialogFooter, { children: _jsx(Button, { variant: "ghost", onClick: onClose, children: "Close" }) })] }) }));
}
