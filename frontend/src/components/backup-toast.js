import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useLocation, useNavigate } from "react-router-dom";
import { Archive, CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import { useBackupJob } from "@/components/backup-job-provider";
import { cn } from "@/lib/utils";
/**
 * Bottom-right floating indicator for the active global backup job. Stays
 * visible across page navigations since it reads from the provider at app
 * root. Clicks the card to return to the backup page.
 */
export function BackupToast() {
    const { current, cancel, clear } = useBackupJob();
    const nav = useNavigate();
    const location = useLocation();
    if (!current)
        return null;
    // The Backup page renders its own progress card inline, so the floating
    // toast would be redundant there. Hide when the user is already looking at
    // the backup page for this same connection.
    const onOwnBackupPage = location.pathname === `/c/${current.options.connectionId}/backup`;
    if (onOwnBackupPage)
        return null;
    const isActive = current.status === "starting" || current.status === "streaming";
    // Snap to 100% on completion — same reason as the main page's card.
    const percent = current.status === "done"
        ? 100
        : current.estimateBytes
            ? Math.min(99, Math.round((current.bytes / current.estimateBytes) * 100))
            : null;
    const rate = current.elapsedMs > 500 && current.bytes > 0
        ? formatBytes(current.bytes / (current.elapsedMs / 1000)) + "/s"
        : null;
    const goToBackup = () => nav(`/c/${current.options.connectionId}/backup`);
    const headline = (() => {
        switch (current.status) {
            case "starting":
                return "Backup starting…";
            case "streaming":
                return `Backing up ${current.options.connectionName}`;
            case "done":
                return "Backup complete";
            case "cancelled":
                return "Backup cancelled";
            case "error":
                return "Backup failed";
        }
    })();
    return (_jsx("div", { 
        // Above toasts (sonner z-index is ~2147483646), slightly inset.
        className: "fixed bottom-4 right-4 z-[2147483647] w-80 max-w-[calc(100vw-2rem)]", children: _jsxs("div", { onClick: goToBackup, className: cn("rounded-lg border bg-card shadow-2xl p-3 cursor-pointer hover:shadow-3xl transition-shadow", isActive && "border-primary/40", current.status === "done" && "border-emerald-500/40", (current.status === "error" || current.status === "cancelled") && "border-destructive/40"), children: [_jsxs("div", { className: "flex items-start gap-2", children: [_jsx("div", { className: "mt-0.5", children: current.status === "starting" || current.status === "streaming" ? (_jsx(Loader2, { className: "h-4 w-4 animate-spin text-primary" })) : current.status === "done" ? (_jsx(CheckCircle2, { className: "h-4 w-4 text-emerald-500" })) : current.status === "error" ? (_jsx(XCircle, { className: "h-4 w-4 text-destructive" })) : (_jsx(Archive, { className: "h-4 w-4 text-muted-foreground" })) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "text-sm font-medium", children: headline }), _jsxs("div", { className: "text-xs text-muted-foreground truncate", children: [current.options.connectionName, isActive && current.bytes > 0 && (_jsxs(_Fragment, { children: [" \u00B7 ", formatBytes(current.bytes), rate && ` · ${rate}`] })), current.status === "done" && _jsxs(_Fragment, { children: [" \u00B7 ", formatBytes(current.bytes), " saved"] }), current.status === "error" && current.error && _jsxs(_Fragment, { children: [" \u00B7 ", current.error.slice(0, 80)] })] })] }), _jsx("button", { className: "text-muted-foreground hover:text-foreground", "aria-label": isActive ? "Cancel backup" : "Dismiss", onClick: (e) => {
                                e.stopPropagation();
                                if (isActive)
                                    cancel();
                                else
                                    clear();
                            }, children: _jsx(X, { className: "h-3.5 w-3.5" }) })] }), percent !== null && isActive && (_jsxs("div", { className: "mt-2 space-y-1", children: [_jsx("div", { className: "h-1.5 w-full rounded bg-muted overflow-hidden", children: _jsx("div", { className: "h-full bg-primary transition-all duration-200", style: { width: `${percent}%` } }) }), _jsxs("div", { className: "text-xs font-mono text-muted-foreground text-right", children: [percent, "%"] })] })), percent === null && isActive && current.bytes > 0 && (
                // Indeterminate: no estimate (schema-only). Pulsing bar.
                _jsx("div", { className: "mt-2 h-1.5 w-full rounded bg-muted overflow-hidden", children: _jsx("div", { className: "h-full w-1/3 bg-primary animate-pulse" }) }))] }) }));
}
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024)
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
