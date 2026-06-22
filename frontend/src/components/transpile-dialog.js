import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowRightLeft, Check, Info, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";
const DIALECTS = [
    { value: "POSTGRES", label: "PostgreSQL" },
    { value: "MYSQL", label: "MySQL" },
    { value: "SQLITE", label: "SQLite" },
    { value: "MSSQL", label: "SQL Server" },
];
/**
 * Convert the current SQL to another dialect. Parses with a real AST in the
 * source dialect, regenerates in the target, and surfaces correctness warnings
 * for constructs whose semantics may not survive translation. "Apply" replaces
 * the editor content; the user always reviews the output and warnings first.
 */
export function TranspileDialog({ open, connectionId, sourceDialect, sql, onOpenChange, onApply }) {
    const [to, setTo] = useState(sourceDialect === "POSTGRES" ? "MYSQL" : "POSTGRES");
    const [result, setResult] = useState(null);
    const convert = useMutation({
        mutationFn: () => api.transpile(connectionId, { sql, to }),
        onSuccess: (r) => setResult(r),
        onError: (e) => {
            setResult(null);
            toast.error(extractErrorMessage(e));
        },
    });
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => {
            if (!v)
                setResult(null);
            onOpenChange(v);
        }, children: _jsxs(DialogContent, { className: "max-w-2xl", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { className: "flex items-center gap-2", children: [_jsx(ArrowRightLeft, { className: "h-4 w-4" }), " Convert SQL dialect"] }), _jsx(DialogDescription, { children: "Parse the query in its source dialect and regenerate it for another engine. Review the output and any warnings before applying \u2014 semantics can differ." })] }), _jsxs("div", { className: "flex items-end gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "From" }), _jsx("div", { className: "h-9 px-3 flex items-center rounded-md border border-border bg-muted text-sm text-muted-foreground", children: DIALECTS.find((d) => d.value === sourceDialect)?.label ?? sourceDialect })] }), _jsx(ArrowRightLeft, { className: "h-4 w-4 mb-2.5 text-muted-foreground" }), _jsxs("div", { className: "space-y-1.5 flex-1", children: [_jsx(Label, { children: "To" }), _jsxs(Select, { value: to, onValueChange: (v) => setTo(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: DIALECTS.filter((d) => d.value !== sourceDialect).map((d) => (_jsx(SelectItem, { value: d.value, children: d.label }, d.value))) })] })] }), _jsx(Button, { onClick: () => convert.mutate(), disabled: convert.isPending, children: convert.isPending ? _jsx(Loader2, { className: "h-4 w-4 animate-spin" }) : "Convert" })] }), result && (_jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-xs text-muted-foreground", children: "Converted SQL" }), _jsx("pre", { className: "mt-1 text-xs font-mono bg-muted rounded-md p-3 whitespace-pre-wrap max-h-60 overflow-auto", children: result.sql })] }), result.warnings.length > 0 && (_jsx("div", { className: "space-y-1.5", children: result.warnings.map((w, i) => (_jsxs("div", { className: "flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 " +
                                    (w.severity === "warn"
                                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                        : "bg-muted text-muted-foreground"), children: [w.severity === "warn" ? (_jsx(AlertTriangle, { className: "h-3.5 w-3.5 mt-0.5 shrink-0" })) : (_jsx(Info, { className: "h-3.5 w-3.5 mt-0.5 shrink-0" })), _jsx("span", { children: w.message })] }, i))) })), result.warnings.length === 0 && (_jsxs("div", { className: "flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400", children: [_jsx(Check, { className: "h-3.5 w-3.5" }), " No portability warnings detected."] }))] })), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { disabled: !result, onClick: () => {
                                if (result) {
                                    onApply(result.sql);
                                    onOpenChange(false);
                                    setResult(null);
                                    toast.success("SQL replaced with converted query");
                                }
                            }, children: "Apply to editor" })] })] }) }));
}
