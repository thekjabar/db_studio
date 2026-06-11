import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { AlertTriangle, Copy, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
/**
 * Persistent error surface for destructive operations (backup, import,
 * schedule run, webhook delivery). Toasts disappear before the user can
 * read them — this sticks until dismissed, offers Copy (so support gets
 * the raw text + request id) and Retry.
 */
export function ErrorCard({ title = "Something went wrong", message, requestId, detail, onRetry, onDismiss, className, }) {
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
        }
        catch {
            toast.error("Clipboard blocked — select and copy manually");
        }
    };
    return (_jsx("div", { className: cn("rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm", className), role: "alert", children: _jsxs("div", { className: "flex items-start gap-2", children: [_jsx(AlertTriangle, { className: "h-4 w-4 mt-0.5 text-destructive shrink-0" }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "font-medium text-destructive", children: title }), _jsx("div", { className: "text-sm mt-0.5 break-words", children: message }), requestId && (_jsxs("div", { className: "text-[11px] text-muted-foreground font-mono mt-1", children: ["request-id: ", requestId] })), detail && (_jsx("button", { type: "button", className: "text-xs text-muted-foreground underline hover:text-foreground mt-2", onClick: () => setShowDetail((v) => !v), children: showDetail ? "Hide details" : "Show details" })), showDetail && detail && (_jsx("pre", { className: "mt-2 rounded bg-background/50 border border-border p-2 text-[11px] font-mono overflow-x-auto max-h-48", children: detail }))] }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [_jsxs(Button, { size: "sm", variant: "ghost", className: "h-7 px-2", onClick: copy, children: [_jsx(Copy, { className: "h-3.5 w-3.5" }), _jsx("span", { className: "hidden sm:inline ml-1 text-xs", children: "Copy" })] }), onRetry && (_jsxs(Button, { size: "sm", variant: "outline", className: "h-7 px-2", onClick: onRetry, children: [_jsx(RotateCw, { className: "h-3.5 w-3.5" }), _jsx("span", { className: "hidden sm:inline ml-1 text-xs", children: "Retry" })] })), onDismiss && (_jsx(Button, { size: "sm", variant: "ghost", className: "h-7 w-7 p-0", onClick: onDismiss, children: _jsx(X, { className: "h-3.5 w-3.5" }) }))] })] }) }));
}
/**
 * Pull useful fields out of an axios error so ErrorCard props can be filled
 * with one line. Falls back to sensible defaults for non-axios errors.
 */
export function errorToCardProps(err) {
    const e = err;
    const data = e?.response?.data;
    let message = "Unknown error";
    if (data?.message) {
        message = Array.isArray(data.message) ? data.message.join(", ") : data.message;
    }
    else if (e?.message) {
        message = e.message;
    }
    const requestId = data?.requestId ?? null;
    const detail = e?.response?.status
        ? `HTTP ${e.response.status}\n${JSON.stringify(data ?? {}, null, 2)}`
        : undefined;
    return { message, requestId, detail };
}
