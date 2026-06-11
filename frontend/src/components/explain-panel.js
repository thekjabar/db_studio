import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AlertTriangle, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
function severityIcon(s) {
    switch (s) {
        case "warn":
            return _jsx(TriangleAlert, { className: "h-3.5 w-3.5 text-amber-500" });
        case "error":
            return _jsx(AlertTriangle, { className: "h-3.5 w-3.5 text-destructive" });
        default:
            return _jsx(Info, { className: "h-3.5 w-3.5 text-blue-500" });
    }
}
function severityRowBg(s) {
    switch (s) {
        case "warn":
            return "border-amber-500/30 bg-amber-500/5";
        case "error":
            return "border-destructive/30 bg-destructive/10";
        default:
            return "border-blue-500/30 bg-blue-500/5";
    }
}
export function ExplainPanel({ result }) {
    return (_jsxs("div", { className: "flex flex-col h-full overflow-hidden", children: [_jsxs("div", { className: "flex items-center gap-4 border-b border-border px-3 py-2 text-xs", children: [_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Mode:" }), " ", _jsx("span", { className: "font-medium", children: result.mode === "analyze" ? "EXPLAIN ANALYZE" : "EXPLAIN" })] }), result.totalCost !== undefined && (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Root cost:" }), " ", _jsx("span", { className: "font-mono", children: result.totalCost.toFixed(0) })] })), result.planTimeMs !== undefined && (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Plan:" }), " ", _jsxs("span", { className: "font-mono", children: [result.planTimeMs.toFixed(2), "ms"] })] })), result.executionTimeMs !== undefined && (_jsxs("div", { children: [_jsx("span", { className: "text-muted-foreground", children: "Exec:" }), " ", _jsxs("span", { className: "font-mono", children: [result.executionTimeMs.toFixed(2), "ms"] })] }))] }), result.warnings.length > 0 && (_jsx("div", { className: "border-b border-border p-2 space-y-1", children: result.warnings.map((w, i) => (_jsx(WarningRow, { warning: w }, i))) })), _jsx("div", { className: "flex-1 overflow-auto p-2", children: result.nodes.length === 0 ? (_jsx("pre", { className: "text-xs font-mono whitespace-pre-wrap text-muted-foreground", children: typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw, null, 2) })) : (_jsx("ul", { className: "space-y-1", children: result.nodes.map((n) => (_jsx(PlanNodeRow, { node: n }, n.id))) })) })] }));
}
function WarningRow({ warning }) {
    return (_jsxs("div", { className: cn("flex items-start gap-2 rounded border px-2 py-1 text-xs", severityRowBg(warning.severity)), children: [_jsx("div", { className: "mt-0.5", children: severityIcon(warning.severity) }), _jsxs("div", { className: "min-w-0 flex-1", children: [_jsx("div", { children: warning.message }), warning.nodePath && (_jsx("div", { className: "text-muted-foreground font-mono truncate", children: warning.nodePath }))] })] }));
}
function PlanNodeRow({ node }) {
    const hasWarning = node.warnings.length > 0;
    return (_jsx("li", { className: cn("flex items-start gap-2 rounded border border-border/50 px-2 py-1 text-xs font-mono", hasWarning && "bg-amber-500/5 border-amber-500/30"), style: { marginLeft: `${node.depth * 16}px` }, children: _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "font-semibold", children: node.label }), node.totalCost !== undefined && (_jsxs(Badge, { variant: "secondary", className: "text-[10px]", children: ["cost ", node.totalCost.toFixed(0)] })), node.actualRows !== undefined && (_jsxs(Badge, { variant: "secondary", className: "text-[10px]", children: ["actual ", node.actualRows] })), node.planRows !== undefined && node.actualRows === undefined && (_jsxs(Badge, { variant: "secondary", className: "text-[10px]", children: ["plan ", node.planRows] })), node.actualTotalMs !== undefined && (_jsxs(Badge, { variant: "secondary", className: "text-[10px]", children: [node.actualTotalMs.toFixed(1), "ms"] }))] }), node.warnings.map((w, i) => (_jsxs("div", { className: "flex items-center gap-1 mt-0.5 text-muted-foreground", children: [severityIcon(w.severity), _jsx("span", { children: w.message })] }, i)))] }) }));
}
