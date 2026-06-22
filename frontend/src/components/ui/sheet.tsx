import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-[1px]",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "right" | "left";
    width?: string;
    /** When true, the user can drag the inner edge to resize the sheet. */
    resizable?: boolean;
    /** localStorage key for persisting the resized width. */
    storageKey?: string;
  }
>(({ className, children, side = "right", width = "w-[480px]", resizable, storageKey, ...props }, ref) => {
  const [px, setPx] = React.useState<number | null>(() => {
    if (!resizable || !storageKey) return null;
    const saved = Number(localStorage.getItem(storageKey));
    return saved >= 360 && saved <= 1000 ? saved : 560;
  });

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = px ?? 560;
    const onMove = (ev: PointerEvent) => {
      // Right-side sheet grows when dragging the left edge leftwards.
      const delta = side === "right" ? startX - ev.clientX : ev.clientX - startX;
      setPx(Math.min(1000, Math.max(360, startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setPx((w) => {
        if (storageKey && w != null) localStorage.setItem(storageKey, String(w));
        return w;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const useStyleWidth = resizable && px != null;
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        style={useStyleWidth ? { width: px } : undefined}
        className={cn(
          "fixed top-0 bottom-0 z-50 flex flex-col bg-card shadow-2xl border-border",
          side === "right" ? "right-0 border-l" : "left-0 border-r",
          !useStyleWidth && width,
          "data-[state=open]:animate-in data-[state=closed]:animate-out duration-200",
          side === "right"
            ? "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
            : "data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
          className,
        )}
        {...props}
      >
        {resizable && (
          <div
            onPointerDown={startResize}
            className={cn(
              "absolute top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 active:bg-primary z-10",
              side === "right" ? "left-0" : "right-0",
            )}
            title="Drag to resize"
          />
        )}
        {children}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 transition-opacity">
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
SheetContent.displayName = "SheetContent";

export const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-6 py-4 border-b border-border", className)} {...props} />
);
export const SheetBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex-1 overflow-y-auto px-6 py-4", className)} {...props} />
);
export const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("px-6 py-3 border-t border-border flex items-center justify-end gap-2", className)} {...props} />
);
export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold", className)} {...props} />
));
SheetTitle.displayName = "SheetTitle";
export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-xs text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = "SheetDescription";
