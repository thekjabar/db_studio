import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Use "compact" in narrow sidebars; "page" for full-page emptiness. */
  size?: "compact" | "page";
}

/** Consistent empty-state block with an optional icon and CTA. */
export function EmptyState({ icon: Icon, title, description, action, className, size = "page" }: Props) {
  const isCompact = size === "compact";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        isCompact ? "p-4 gap-2" : "p-10 gap-3",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "rounded-full bg-muted/50 border border-border flex items-center justify-center text-muted-foreground",
            isCompact ? "h-8 w-8" : "h-12 w-12",
          )}
        >
          <Icon className={isCompact ? "h-4 w-4" : "h-5 w-5"} />
        </div>
      )}
      <div className={cn("font-medium", isCompact ? "text-xs" : "text-sm")}>{title}</div>
      {description && (
        <div className={cn("text-muted-foreground", isCompact ? "text-[11px]" : "text-xs max-w-sm")}>
          {description}
        </div>
      )}
      {action && <div className={cn(isCompact ? "mt-1" : "mt-2")}>{action}</div>}
    </div>
  );
}
