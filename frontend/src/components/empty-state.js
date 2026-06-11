import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { cn } from "@/lib/utils";
/** Consistent empty-state block with an optional icon and CTA. */
export function EmptyState({ icon: Icon, title, description, action, className, size = "page" }) {
    const isCompact = size === "compact";
    return (_jsxs("div", { className: cn("flex flex-col items-center justify-center text-center", isCompact ? "p-4 gap-2" : "p-10 gap-3", className), children: [Icon && (_jsx("div", { className: cn("rounded-full bg-muted/50 border border-border flex items-center justify-center text-muted-foreground", isCompact ? "h-8 w-8" : "h-12 w-12"), children: _jsx(Icon, { className: isCompact ? "h-4 w-4" : "h-5 w-5" }) })), _jsx("div", { className: cn("font-medium", isCompact ? "text-xs" : "text-sm"), children: title }), description && (_jsx("div", { className: cn("text-muted-foreground", isCompact ? "text-[11px]" : "text-xs max-w-sm"), children: description })), action && _jsx("div", { className: cn(isCompact ? "mt-1" : "mt-2"), children: action })] }));
}
