import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
export const Checkbox = React.forwardRef(({ className, indeterminate, checked, onCheckedChange, onClick, ...props }, ref) => {
    const inner = React.useRef(null);
    React.useImperativeHandle(ref, () => inner.current);
    React.useEffect(() => {
        if (inner.current)
            inner.current.indeterminate = !!indeterminate;
    }, [indeterminate]);
    return (_jsxs("label", { className: "relative inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center", children: [_jsx("input", { ref: inner, type: "checkbox", checked: !!checked, onChange: (e) => onCheckedChange?.(e.target.checked), onClick: onClick, className: "peer absolute inset-0 h-full w-full cursor-pointer appearance-none", ...props }), _jsx("span", { className: cn("flex h-4 w-4 items-center justify-center rounded-sm border border-border bg-background transition-colors", "peer-checked:border-primary peer-checked:bg-primary", "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1", "peer-disabled:opacity-50", className), children: indeterminate ? (_jsx(Minus, { className: "h-3 w-3 text-primary-foreground" })) : checked ? (_jsx(Check, { className: "h-3 w-3 text-primary-foreground" })) : null })] }));
});
Checkbox.displayName = "Checkbox";
