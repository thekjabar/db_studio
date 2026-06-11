import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, Copy, Download, FileCode2, GitCompare, Loader2, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useModal } from "@/components/modal-provider";
const TARGET_LABELS = {
    prisma: "Prisma (schema.prisma)",
    drizzle: "Drizzle ORM (schema.ts)",
    sql: "Raw SQL (CREATE TABLE)",
};
const HINTS = {
    prisma: "Drop into your Prisma project's prisma/ folder. Run `prisma format` and `prisma migrate dev --create-only` to integrate.",
    drizzle: "Drop into src/db/schema.ts in a Drizzle project. Wire relations() manually for each FK comment.",
    sql: "Plain DDL. Good for bootstrapping a clean DB or diffing by hand.",
};
export default function MigrationExportRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(Inner, { connectionId: id });
}
function Inner({ connectionId }) {
    const qc = useQueryClient();
    const modal = useModal();
    const [target, setTarget] = useState("prisma");
    const [schema, setSchema] = useState("");
    const [output, setOutput] = useState(null);
    const [snapshotName, setSnapshotName] = useState("");
    const [diffOutput, setDiffOutput] = useState(null);
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const snapshotsQ = useQuery({
        queryKey: ["snapshots", connectionId],
        queryFn: () => api.listSchemaSnapshots(connectionId),
    });
    const createSnap = useMutation({
        mutationFn: () => api.createSchemaSnapshot(connectionId, {
            name: snapshotName,
            schema: schema || undefined,
        }),
        onSuccess: () => {
            toast.success("Snapshot saved");
            setSnapshotName("");
            qc.invalidateQueries({ queryKey: ["snapshots", connectionId] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const deleteSnap = useMutation({
        mutationFn: (id) => api.deleteSchemaSnapshot(connectionId, id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["snapshots", connectionId] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const diffMut = useMutation({
        mutationFn: (id) => api.diffSchemaSnapshot(connectionId, id),
        onSuccess: (r) => {
            setDiffOutput({ sql: r.sql, summary: r.summary });
            toast.success("Diff generated");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const mut = useMutation({
        mutationFn: () => api.migrationExport(connectionId, target, schema || undefined),
        onSuccess: (r) => {
            setOutput({ filename: r.filename, content: r.content });
            toast.success(`Generated ${r.filename}`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const copy = async () => {
        if (!output)
            return;
        try {
            await navigator.clipboard.writeText(output.content);
            toast.success("Copied");
        }
        catch {
            toast.error("Copy failed");
        }
    };
    const download = () => {
        if (!output)
            return;
        const blob = new Blob([output.content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = output.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-4xl mx-auto", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-lg font-semibold flex items-center gap-2", children: [_jsx(FileCode2, { className: "h-5 w-5" }), " Migration export"] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Generate a schema file for Prisma, Drizzle, or raw SQL based on this database's current structure. This is a snapshot, not a diff \u2014 regenerate after schema changes." })] }), _jsxs("div", { className: "rounded-md border border-border bg-card p-4 space-y-4", children: [_jsxs("div", { className: "grid grid-cols-1 sm:grid-cols-2 gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Target" }), _jsxs(Select, { value: target, onValueChange: (v) => setTarget(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "prisma", children: TARGET_LABELS.prisma }), _jsx(SelectItem, { value: "drizzle", children: TARGET_LABELS.drizzle }), _jsx(SelectItem, { value: "sql", children: TARGET_LABELS.sql })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Schema (optional)" }), _jsxs(Select, { value: schema || "__all__", onValueChange: (v) => setSchema(v === "__all__" ? "" : v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "__all__", children: "All schemas" }), (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, children: s }, s)))] })] })] })] }), _jsx("div", { className: "text-xs text-muted-foreground", children: HINTS[target] }), _jsx("div", { className: "flex items-center justify-end gap-2 pt-2 border-t border-border", children: _jsxs(Button, { onClick: () => mut.mutate(), disabled: mut.isPending, children: [mut.isPending ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : _jsx(FileCode2, { className: "h-4 w-4" }), "Generate"] }) })] }), output && (_jsxs("div", { className: "rounded-md border border-border bg-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-b border-border", children: [_jsx("div", { className: "text-sm font-mono", children: output.filename }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: copy, children: [_jsx(Copy, { className: "h-3.5 w-3.5" }), " Copy"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: download, children: [_jsx(Download, { className: "h-3.5 w-3.5" }), " Download"] })] })] }), _jsx("pre", { className: "p-3 text-xs font-mono overflow-auto max-h-[60vh] bg-muted/20", children: output.content })] })), _jsxs("div", { className: "rounded-md border border-border bg-card p-4 space-y-3", children: [_jsx("div", { className: "flex items-center justify-between", children: _jsxs("div", { children: [_jsxs("h2", { className: "text-sm font-semibold flex items-center gap-2", children: [_jsx(Camera, { className: "h-4 w-4" }), " Snapshots & diff"] }), _jsx("p", { className: "text-xs text-muted-foreground mt-0.5", children: "Save a schema snapshot now. Later, generate an ALTER-statement diff between the snapshot and the live DB." })] }) }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Input, { placeholder: "Snapshot name (e.g. 'pre v3.1 release')", value: snapshotName, onChange: (e) => setSnapshotName(e.target.value), className: "max-w-sm", maxLength: 200 }), _jsxs(Button, { onClick: () => createSnap.mutate(), disabled: !snapshotName.trim() || createSnap.isPending, variant: "outline", children: [createSnap.isPending ? (_jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" })) : (_jsx(Camera, { className: "h-3.5 w-3.5" })), "Snapshot now"] })] }), _jsx("div", { className: "border-t border-border pt-2", children: snapshotsQ.isLoading ? (_jsx("div", { className: "text-xs text-muted-foreground", children: "Loading snapshots..." })) : (snapshotsQ.data?.length ?? 0) === 0 ? (_jsx("div", { className: "text-xs text-muted-foreground", children: "No snapshots yet. Save one above, then return here to compare." })) : (_jsx("div", { className: "space-y-1", children: snapshotsQ.data.map((s) => (_jsxs("div", { className: "flex items-center gap-2 py-1.5 text-xs", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "font-medium truncate", children: s.name }), _jsxs("div", { className: "text-muted-foreground", children: [format(new Date(s.createdAt), "PPP p"), " \u00B7", " ", s.createdBy?.displayName || s.createdBy?.email || "unknown", s.dbSchema ? ` · schema: ${s.dbSchema}` : ""] })] }), _jsxs(Button, { size: "sm", variant: "ghost", onClick: () => diffMut.mutate(s.id), disabled: diffMut.isPending, children: [diffMut.isPending ? (_jsx(Loader2, { className: "h-3 w-3 animate-spin" })) : (_jsx(GitCompare, { className: "h-3 w-3" })), "Diff"] }), _jsx(Button, { size: "sm", variant: "ghost", onClick: async () => {
                                            const ok = await modal.confirm({
                                                title: `Delete snapshot "${s.name}"?`,
                                                description: "The snapshot can't be recovered.",
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                deleteSnap.mutate(s.id);
                                        }, title: "Delete snapshot", children: _jsx(Trash2, { className: "h-3 w-3" }) })] }, s.id))) })) }), diffOutput && (_jsxs("div", { className: "mt-2 rounded border border-border bg-muted/10 overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-b border-border text-xs", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "font-semibold", children: "Diff summary" }), _jsxs("span", { className: "text-muted-foreground", children: ["+", diffOutput.summary.addedTables.length, " tables,", " ", "-", diffOutput.summary.droppedTables.length, " tables,", " ", "+", diffOutput.summary.addedColumns.length, " cols,", " ", "-", diffOutput.summary.droppedColumns.length, " cols,", " ", "~", diffOutput.summary.changedColumns.length, " changed"] })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs(Button, { size: "sm", variant: "outline", onClick: async () => {
                                                    await navigator.clipboard.writeText(diffOutput.sql);
                                                    toast.success("Copied");
                                                }, children: [_jsx(Copy, { className: "h-3 w-3" }), " Copy"] }), _jsxs(Button, { size: "sm", variant: "outline", onClick: () => {
                                                    const blob = new Blob([diffOutput.sql], { type: "text/plain" });
                                                    const url = URL.createObjectURL(blob);
                                                    const a = document.createElement("a");
                                                    a.href = url;
                                                    a.download = `diff-${Date.now()}.sql`;
                                                    a.click();
                                                    URL.revokeObjectURL(url);
                                                }, children: [_jsx(Download, { className: "h-3 w-3" }), " Download"] })] })] }), _jsx("pre", { className: "p-3 text-xs font-mono overflow-auto max-h-[50vh]", children: diffOutput.sql })] }))] }), _jsxs("div", { className: "rounded-md border border-border bg-card p-4 text-xs text-muted-foreground space-y-1", children: [_jsx("div", { className: "font-medium text-foreground", children: "Scope notes" }), _jsx("div", { children: "\u2022 Snapshot export \u2014 no diff against a previous version. Regenerate after schema changes." }), _jsx("div", { children: "\u2022 Type mapping is best-effort. Review before committing \u2014 domain types, custom precisions, and enums may need manual tuning." }), _jsx("div", { children: "\u2022 Prisma: composite relations and advanced options (@map, @@unique) are emitted where detected; tune the output to match your project conventions." }), _jsx("div", { children: "\u2022 Drizzle FK relations are emitted as comments. Wire them explicitly with relations() in your project." })] })] }));
}
