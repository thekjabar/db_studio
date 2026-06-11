import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, extractErrorMessage } from "@/lib/api";
export function AiQueryDialog({ open, onOpenChange, connectionId, schema, onAccept }) {
    const [prompt, setPrompt] = useState("");
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (open) {
            setPrompt("");
            setResult(null);
            setError(null);
        }
    }, [open]);
    const gen = useMutation({
        mutationFn: () => api.aiGenerateSql(connectionId, { prompt, schema }),
        onSuccess: (r) => {
            setResult(r);
            setError(null);
        },
        onError: (e) => setError(extractErrorMessage(e)),
    });
    const submit = (e) => {
        e.preventDefault();
        if (!prompt.trim())
            return;
        gen.mutate();
    };
    const accept = () => {
        if (result?.sql) {
            onAccept(result.sql);
            onOpenChange(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !gen.isPending && onOpenChange(v), children: _jsxs(DialogContent, { className: "max-w-xl", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { className: "flex items-center gap-2", children: [_jsx(Sparkles, { className: "h-4 w-4 text-primary" }), "Ask AI to write SQL"] }), _jsx(DialogDescription, { children: "Describe what you want in plain language \u2014 the current schema is sent as context so the model can use your real table and column names." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsx(Textarea, { autoFocus: true, value: prompt, onChange: (e) => setPrompt(e.target.value), placeholder: "e.g. Top 10 customers by revenue in the last 30 days", rows: 3, disabled: gen.isPending }), _jsx("div", { className: "flex justify-end", children: _jsxs(Button, { type: "submit", disabled: gen.isPending || !prompt.trim(), children: [gen.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Sparkles, { className: "h-3.5 w-3.5" }), "Generate"] }) })] }), error && (_jsx("div", { className: "rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2", children: error })), result && (_jsxs("div", { className: "space-y-2", children: [_jsxs("div", { className: "rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground", children: [result.explanation, result.tables.length > 0 && (_jsxs("div", { className: "mt-1 font-mono text-[10px]", children: ["Tables used: ", result.tables.join(", ")] }))] }), _jsx("pre", { className: "rounded-md border border-border bg-muted/60 px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-60", children: result.sql })] })), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), disabled: gen.isPending, children: "Cancel" }), _jsx(Button, { onClick: accept, disabled: !result?.sql || gen.isPending, children: "Insert into editor" })] })] }) }));
}
