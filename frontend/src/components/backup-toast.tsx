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
  if (!current) return null;

  // The Backup page renders its own progress card inline, so the floating
  // toast would be redundant there. Hide when the user is already looking at
  // the backup page for this same connection.
  const onOwnBackupPage = location.pathname === `/c/${current.options.connectionId}/backup`;
  if (onOwnBackupPage) return null;

  const isActive = current.status === "starting" || current.status === "streaming";
  const percent = current.estimateBytes
    ? Math.min(99, Math.round((current.bytes / current.estimateBytes) * 100))
    : null;
  const rate =
    current.elapsedMs > 500 && current.bytes > 0
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

  return (
    <div
      // Above toasts (sonner z-index is ~2147483646), slightly inset.
      className="fixed bottom-4 right-4 z-[2147483647] w-80 max-w-[calc(100vw-2rem)]"
    >
      <div
        onClick={goToBackup}
        className={cn(
          "rounded-lg border bg-card shadow-2xl p-3 cursor-pointer hover:shadow-3xl transition-shadow",
          isActive && "border-primary/40",
          current.status === "done" && "border-emerald-500/40",
          (current.status === "error" || current.status === "cancelled") && "border-destructive/40",
        )}
      >
        <div className="flex items-start gap-2">
          <div className="mt-0.5">
            {current.status === "starting" || current.status === "streaming" ? (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            ) : current.status === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            ) : current.status === "error" ? (
              <XCircle className="h-4 w-4 text-destructive" />
            ) : (
              <Archive className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">{headline}</div>
            <div className="text-xs text-muted-foreground truncate">
              {current.options.connectionName}
              {isActive && current.bytes > 0 && (
                <> · {formatBytes(current.bytes)}{rate && ` · ${rate}`}</>
              )}
              {current.status === "done" && <> · {formatBytes(current.bytes)} saved</>}
              {current.status === "error" && current.error && <> · {current.error.slice(0, 80)}</>}
            </div>
          </div>
          <button
            className="text-muted-foreground hover:text-foreground"
            aria-label={isActive ? "Cancel backup" : "Dismiss"}
            onClick={(e) => {
              e.stopPropagation();
              if (isActive) cancel();
              else clear();
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {percent !== null && isActive && (
          <div className="mt-2 space-y-1">
            <div className="h-1.5 w-full rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="text-xs font-mono text-muted-foreground text-right">{percent}%</div>
          </div>
        )}
        {percent === null && isActive && current.bytes > 0 && (
          // Indeterminate: no estimate (schema-only). Pulsing bar.
          <div className="mt-2 h-1.5 w-full rounded bg-muted overflow-hidden">
            <div className="h-full w-1/3 bg-primary animate-pulse" />
          </div>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
