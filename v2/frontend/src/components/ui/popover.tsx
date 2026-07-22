import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * Minimal click-outside popover. Anchored under the trigger element passed
 * via `anchorRef`. Closes on outside click or Escape.
 */
export function Popover({
  open,
  onOpenChange,
  anchorRef,
  align = "start",
  side = "auto",
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: "start" | "center" | "end";
  /** "auto" flips to "top" when there's more space above the anchor than below. */
  side?: "auto" | "top" | "bottom";
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = React.useState<React.CSSProperties | null>(null);

  React.useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const contentH = ref.current?.getBoundingClientRect().height ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placeTop =
      side === "top" ||
      (side === "auto" && spaceBelow < Math.min(contentH, 320) && spaceAbove > spaceBelow);

    const s: React.CSSProperties = { position: "fixed", zIndex: 60 };
    if (placeTop) s.bottom = window.innerHeight - rect.top + 4;
    else s.top = rect.bottom + 4;

    const contentW = ref.current?.getBoundingClientRect().width ?? 0;
    const margin = 8;
    if (align === "end") {
      // Right edge aligned to anchor's right, but don't go off the left edge.
      const rightFromRight = window.innerWidth - rect.right;
      const leftIfEnd = window.innerWidth - rightFromRight - contentW;
      if (contentW && leftIfEnd < margin) s.left = margin;
      else s.right = rightFromRight;
    } else if (align === "center") {
      const anchorCenter = rect.left + rect.width / 2;
      const desired = contentW ? anchorCenter - contentW / 2 : rect.left;
      const max = window.innerWidth - contentW - margin;
      s.left = Math.max(margin, Math.min(desired, max));
    } else {
      // Left-aligned — if overflows the right edge, pull it back in.
      const max = window.innerWidth - contentW - margin;
      s.left = contentW ? Math.min(rect.left, max) : rect.left;
    }
    setStyle(s);
  }, [open, align, side, anchorRef]);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      // Radix components (Select, Dropdown, Dialog) render their content in a
      // portal marked with [data-radix-popper-content-wrapper] or similar.
      // Clicks inside those are "outside" this popover's DOM subtree but should
      // NOT close it — they belong to a floating child UI.
      if (t.closest("[data-radix-popper-content-wrapper]")) return;
      if (t.closest("[data-radix-portal]")) return;
      if (t.closest("[role=listbox]")) return;
      if (t.closest("[role=menu]")) return;
      onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange, anchorRef]);

  if (!open || !style) return null;
  // Portal to <body> so the popover escapes any transformed ancestor (e.g. a
  // Dialog uses -translate-* which would otherwise become the containing block
  // for `position: fixed` and pull the popover inside the dialog.)
  return createPortal(
    <div
      ref={ref}
      style={style}
      data-popover-content=""
      onPointerDownCapture={(e) => e.stopPropagation()}
      className={cn(
        "rounded-md border border-border bg-card shadow-xl p-2",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
