import { jsx as _jsx } from "react/jsx-runtime";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors", {
    variants: {
        variant: {
            default: "border-transparent bg-primary/15 text-primary",
            secondary: "border-border bg-secondary text-secondary-foreground",
            destructive: "border-transparent bg-destructive/15 text-destructive",
            outline: "text-foreground border-border",
            warning: "border-transparent bg-amber-500/15 text-amber-400",
            info: "border-transparent bg-sky-500/15 text-sky-400",
        },
    },
    defaultVariants: { variant: "default" },
});
export function Badge({ className, variant, ...props }) {
    return _jsx("div", { className: cn(badgeVariants({ variant }), className), ...props });
}
export { badgeVariants };
