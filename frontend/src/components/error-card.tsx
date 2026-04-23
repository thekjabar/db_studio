import { useState } from "react";
import { AlertTriangle, Copy, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ErrorCardProps {
  title?: string;
  /** Main human-readable message. */
  message: string;
  /** Server-side request id from our HttpExceptionFilter — helps support trace the error. */
  requestId?: string | null;
  /** Optional raw server response / stack snippet (copyable but collapsed by default). */
  detail?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Persistent error surface for destructive operations (backup, import,
 * schedule run, webhook delivery). Toasts disappear before the user can
 * read them — this sticks until dismissed, offers Copy (so support gets
 * the raw text + request id) and Retry.
 */
export function ErrorCard({
  title = "Something went wrong",
  message,
  requestId,
  detail,
  onRetry,
  onDismiss,
  className,
}: ErrorCardProps) {
  const [showDetail, setShowDetail] = useState(false);
  const copy = async () => {
    const text = [
      title,
      message,
      requestId ? `request-id: ${requestId}` : null,
      detail ? `---\n${detail}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Clipboard blocked — select and copy manually");
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm",
        className,
      )}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-destructive">{title}</div>
          <div className="text-sm mt-0.5 break-words">{message}</div>
          {requestId && (
            <div className="text-[11px] text-muted-foreground font-mono mt-1">
              request-id: {requestId}
            </div>
          )}
          {detail && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground mt-2"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? "Hide details" : "Show details"}
            </button>
          )}
          {showDetail && detail && (
            <pre className="mt-2 rounded bg-background/50 border border-border p-2 text-[11px] font-mono overflow-x-auto max-h-48">
              {detail}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={copy}>
            <Copy className="h-3.5 w-3.5" />
            <span className="hidden sm:inline ml-1 text-xs">Copy</span>
          </Button>
          {onRetry && (
            <Button size="sm" variant="outline" className="h-7 px-2" onClick={onRetry}>
              <RotateCw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline ml-1 text-xs">Retry</span>
            </Button>
          )}
          {onDismiss && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onDismiss}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Pull useful fields out of an axios error so ErrorCard props can be filled
 * with one line. Falls back to sensible defaults for non-axios errors.
 */
export function errorToCardProps(err: unknown): Pick<ErrorCardProps, "message" | "requestId" | "detail"> {
  const e = err as {
    message?: string;
    response?: {
      status?: number;
      data?: {
        message?: string | string[];
        requestId?: string;
        error?: string;
      };
    };
  };
  const data = e?.response?.data;
  let message = "Unknown error";
  if (data?.message) {
    message = Array.isArray(data.message) ? data.message.join(", ") : data.message;
  } else if (e?.message) {
    message = e.message;
  }
  const requestId = data?.requestId ?? null;
  const detail = e?.response?.status
    ? `HTTP ${e.response.status}\n${JSON.stringify(data ?? {}, null, 2)}`
    : undefined;
  return { message, requestId, detail };
}
