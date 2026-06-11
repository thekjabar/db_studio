import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Archive, Download, Loader2, X } from "lucide-react";
import { api } from "@/lib/api";
import { ErrorCard } from "@/components/error-card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useBackupJob } from "@/components/backup-job-provider";
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function formatRate(bytes, ms) {
    if (ms < 100 || bytes === 0)
        return "—";
    const bps = bytes / (ms / 1000);
    return `${formatBytes(bps)}/s`;
}
function formatEta(bytes, estimate, ms) {
    if (!estimate || bytes === 0 || ms < 500)
        return "—";
    const rate = bytes / ms;
    const remaining = Math.max(0, estimate - bytes);
    const etaMs = remaining / rate;
    if (etaMs < 1000)
        return "<1s";
    if (etaMs < 60_000)
        return `${Math.round(etaMs / 1000)}s`;
    return `${Math.round(etaMs / 60_000)}m`;
}
export default function BackupRoute() {
    const { id } = useParams();
    if (!id)
        return null;
    return _jsx(BackupInner, { connectionId: id });
}
function BackupInner({ connectionId }) {
    const [format, setFormat] = useState("sql");
    const [schemaOnly, setSchemaOnly] = useState(false);
    const [schema, setSchema] = useState("");
    const { current, start, cancel, clear } = useBackupJob();
    // Only show progress for a job that belongs to *this* connection — otherwise
    // the user might see a backup from another connection if they multi-task.
    const myJob = current && current.options.connectionId === connectionId ? current : null;
    const isRunningForMe = myJob?.status === "starting" || myJob?.status === "streaming";
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const estimateQ = useQuery({
        queryKey: ["backup-estimate", connectionId, schema, schemaOnly],
        queryFn: () => api.estimateBackup(connectionId, schema || undefined),
        enabled: !schemaOnly,
    });
    const connectionName = useQuery({
        queryKey: ["connection", connectionId],
        queryFn: () => api.getConnection(connectionId),
    });
    const kickoff = () => {
        start({
            connectionId,
            connectionName: connectionName.data?.name ?? "Connection",
            format,
            schemaOnly,
            schema: schema || undefined,
        });
    };
    return (_jsxs("div", { className: "p-6 space-y-6 max-w-2xl mx-auto", children: [_jsxs("div", { children: [_jsxs("h1", { className: "text-lg font-semibold flex items-center gap-2", children: [_jsx(Archive, { className: "h-5 w-5" }), " Backup"] }), _jsxs("p", { className: "text-sm text-muted-foreground mt-1", children: ["Download a ", _jsx("code", { className: "text-xs bg-muted px-1 rounded", children: "pg_dump" }), " snapshot of this database. Runs as the connection's stored user \u2014 make sure it has access to the objects you want included."] })] }), _jsxs("div", { className: "rounded-md border border-border bg-card p-4 space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Format" }), _jsxs(Select, { value: format, onValueChange: (v) => setFormat(v), disabled: isRunningForMe, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "sql", children: "Plain SQL (.sql)" }), _jsx(SelectItem, { value: "custom", children: "Postgres custom (.dump, restore with pg_restore)" })] })] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Plain SQL is readable and portable. Custom format is smaller and supports selective restore via pg_restore." })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Schema (optional)" }), _jsxs(Select, { value: schema || "__all__", onValueChange: (v) => setSchema(v === "__all__" ? "" : v), disabled: isRunningForMe, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "__all__", children: "All schemas" }), (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, children: s }, s)))] })] })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Switch, { checked: schemaOnly, onCheckedChange: setSchemaOnly, disabled: isRunningForMe }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Schema only" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Skip row data. Useful for migrations and diffing structure." })] })] }), !schemaOnly && estimateQ.data && estimateQ.data.bytes !== null && (_jsxs("div", { className: "rounded border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground", children: ["Estimated size:", " ", _jsx("span", { className: "text-foreground font-medium", children: formatBytes(estimateQ.data.bytes) }), " ", "across ", estimateQ.data.tables, " tables.", " ", _jsx("span", { className: "text-muted-foreground/70", children: "Actual dump may be 50\u2013200% of this depending on compression and column widths." })] })), _jsxs("div", { className: "pt-2 border-t border-border flex items-center justify-between gap-3 flex-wrap", children: [_jsx("div", { className: "text-xs text-muted-foreground", children: "Backup keeps running when you change pages \u2014 watch the status in the bottom-right." }), isRunningForMe ? (_jsxs(Button, { variant: "outline", onClick: cancel, children: [_jsx(X, { className: "h-4 w-4" }), " Cancel"] })) : (_jsxs(Button, { onClick: kickoff, disabled: !!current && current.status === "streaming", children: [_jsx(Download, { className: "h-4 w-4" }), " Download"] }))] })] }), myJob && _jsx(ProgressCard, { job: myJob, onDismiss: clear, onCancel: cancel }), _jsxs("div", { className: "rounded-md border border-border bg-card p-4 text-xs text-muted-foreground space-y-1", children: [_jsx("div", { className: "font-medium text-foreground", children: "Heads up" }), _jsx("div", { children: "\u2022 Backup is supported for PostgreSQL connections today. MySQL/MSSQL return 501." }), _jsx("div", { children: "\u2022 Only connection owners can run backups." }), _jsx("div", { children: "\u2022 If the remote Postgres major version is newer than the server's bundled pg_dump, the dump may fail. Install a matching client binary on the API host when upgrading." })] })] }));
}
function ProgressCard({ job, onDismiss, onCancel, }) {
    const running = job.status === "starting" || job.status === "streaming";
    // Auto-dismiss the card after a successful download so the user isn't nagged
    // to click Dismiss. Failed/cancelled jobs stay so the user can read the
    // reason. The Dismiss button is still there as an explicit override.
    useEffect(() => {
        if (job.status !== "done")
            return;
        const t = setTimeout(onDismiss, 5000);
        return () => clearTimeout(t);
    }, [job.status, onDismiss]);
    // While streaming, cap at 99% so a bad estimate doesn't park us at "100%"
    // forever. Once the job is done, snap to 100% — the bytes-on-disk are
    // authoritative regardless of whether they matched the estimate.
    const percent = !running && job.status === "done"
        ? 100
        : job.estimateBytes
            ? Math.min(99, Math.round((job.bytes / job.estimateBytes) * 100))
            : null;
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-4 space-y-3", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [running ? (_jsx(Loader2, { className: "h-4 w-4 animate-spin text-primary" })) : (_jsx(Archive, { className: "h-4 w-4 text-emerald-500" })), _jsx("div", { className: "text-sm font-medium", children: !running
                                    ? job.status === "done"
                                        ? "Download complete"
                                        : job.status === "cancelled"
                                            ? "Cancelled"
                                            : "Failed"
                                    : job.bytes === 0
                                        ? "Starting — pg_dump is connecting…"
                                        : "Streaming…" })] }), _jsxs("div", { className: "flex items-center gap-2", children: [percent !== null && job.bytes > 0 && (_jsxs("div", { className: "text-sm font-mono", children: [percent, "%"] })), running && (_jsxs(Button, { variant: "outline", size: "sm", onClick: onCancel, children: [_jsx(X, { className: "h-3.5 w-3.5" }), " Cancel"] })), !running && (_jsx("button", { onClick: onDismiss, className: "text-xs text-muted-foreground hover:text-foreground", children: "Dismiss" }))] })] }), percent !== null && job.bytes > 0 && (_jsx("div", { className: "h-2 w-full rounded bg-muted overflow-hidden", children: _jsx("div", { className: "h-full bg-primary transition-all duration-200", style: { width: `${percent}%` } }) })), percent === null && running && job.bytes > 0 && (_jsx("div", { className: "h-2 w-full rounded bg-muted overflow-hidden", children: _jsx("div", { className: "h-full w-1/3 bg-primary animate-pulse" }) })), _jsxs("div", { className: "grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs", children: [_jsx(Stat, { label: "Downloaded", value: formatBytes(job.bytes) }), _jsx(Stat, { label: "Estimated", value: job.estimateBytes ? formatBytes(job.estimateBytes) : "unknown" }), _jsx(Stat, { label: "Rate", value: formatRate(job.bytes, job.elapsedMs) }), _jsx(Stat, { label: running ? "ETA" : "Elapsed", value: running
                            ? formatEta(job.bytes, job.estimateBytes, job.elapsedMs)
                            : `${(job.elapsedMs / 1000).toFixed(1)}s` })] }), job.status === "error" && job.error && (_jsx(ErrorCard, { title: "Backup failed", message: job.error, onDismiss: onDismiss }))] }));
}
function Stat({ label, value }) {
    return (_jsxs("div", { children: [_jsx("div", { className: "text-muted-foreground", children: label }), _jsx("div", { className: "font-mono", children: value })] }));
}
