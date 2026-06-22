import { jsx as _jsx } from "react/jsx-runtime";
import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "@/lib/utils";
/**
 * Thin shadcn-style wrapper around react-resizable-panels.
 *
 * Usage:
 *   <ResizablePanelGroup direction="vertical" autoSaveId="sql-editor">
 *     <ResizablePanel defaultSize={60} minSize={20}>…editor…</ResizablePanel>
 *     <ResizableHandle withHandle />
 *     <ResizablePanel defaultSize={40} minSize={15} collapsible>…results…</ResizablePanel>
 *   </ResizablePanelGroup>
 *
 * `autoSaveId` persists the layout to localStorage so the user's sizing sticks
 * across reloads.
 */
function ResizablePanelGroup({ className, ...props }) {
    return (_jsx(ResizablePrimitive.PanelGroup, { className: cn("flex h-full w-full data-[panel-group-direction=vertical]:flex-col", className), ...props }));
}
const ResizablePanel = ResizablePrimitive.Panel;
function ResizableHandle({ withHandle, className, ...props }) {
    return (_jsx(ResizablePrimitive.PanelResizeHandle, { className: cn(
        // Base hit area + the visible 1px line via a centered pseudo-element.
        "relative flex w-px items-center justify-center bg-border transition-colors", "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2", "hover:bg-primary/50 data-[resize-handle-state=drag]:bg-primary", "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", 
        // Vertical groups: handle is a horizontal bar instead.
        "data-[panel-group-direction=vertical]:h-px data-[panel-group-direction=vertical]:w-full", "data-[panel-group-direction=vertical]:after:left-0 data-[panel-group-direction=vertical]:after:h-2 data-[panel-group-direction=vertical]:after:w-full data-[panel-group-direction=vertical]:after:-translate-y-1/2 data-[panel-group-direction=vertical]:after:translate-x-0", className), ...props, children: withHandle && (_jsx("div", { className: "z-10 flex h-5 w-3 items-center justify-center rounded-sm border border-border bg-card data-[panel-group-direction=vertical]:h-3 data-[panel-group-direction=vertical]:w-5 data-[panel-group-direction=vertical]:rotate-90", children: _jsx(GripVertical, { className: "h-3 w-3 text-muted-foreground" }) })) }));
}
export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
