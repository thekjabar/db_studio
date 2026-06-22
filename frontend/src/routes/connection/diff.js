import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitCompare, Loader2, Play } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DataGrid } from "@/components/data-grid";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
/**
 * Run the same (or different) SQL against two connections and diff the
 * result sets — the classic "does prod match staging?" check. Rows are
 * compared by full JSON identity; differences are listed as only-in-A /
 * only-in-B.
 */
export default function DiffRoute() {
    const { id } = useParams();
    const [connB, setConnB] = useState("");
    const [sqlA, setSqlA] = useState("SELECT 1 AS x;");
    const [sqlB, setSqlB] = useState("");
    const [resA, setResA] = useState(null);
    const [resB, setResB] = useState(null);
    const [view, setView] = useState("onlyA");
    const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });
    const run = useMutation({
        mutationFn: async () => {
            const [a, b] = await Promise.all([
                api.runQuery(id, { sql: sqlA, maxRows: 5000 }),
                api.runQuery(connB || id, { sql: sqlB.trim() || sqlA, maxRows: 5000 }),
            ]);
            return { a, b };
        },
        onSuccess: ({ a, b }) => {
            setResA(a);
            setResB(b);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const diff = useMemo(() => {
        if (!resA || !resB)
            return null;
        const keyOf = (r) => JSON.stringify(r);
        const setA = new Map(resA.rows.map((r) => [keyOf(r), r]));
        const setB = new Map(resB.rows.map((r) => [keyOf(r), r]));
        const onlyA = [...setA.entries()].filter(([k]) => !setB.has(k)).map(([, r]) => r);
        const onlyB = [...setB.entries()].filter(([k]) => !setA.has(k)).map(([, r]) => r);
        return { onlyA, onlyB, same: resA.rows.length - onlyA.length };
    }, [resA, resB]);
    const shownRows = view === "onlyA" ? diff?.onlyA ?? [] : diff?.onlyB ?? [];
    const shownFields = view === "onlyA" ? resA?.fields ?? [] : resB?.fields ?? [];
    return (_jsxs("div", { className: "h-full flex flex-col", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2", children: [_jsx(GitCompare, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Compare results" }), _jsx("div", { className: "ml-auto", children: _jsxs(Button, { size: "sm", onClick: () => run.mutate(), disabled: run.isPending || !sqlA.trim(), children: [run.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Play, { className: "h-3.5 w-3.5" }), "Run both"] }) })] }), _jsxs("div", { className: "p-3 grid grid-cols-1 lg:grid-cols-2 gap-3 border-b border-border", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "A \u2014 this connection" }), _jsx(Textarea, { rows: 4, value: sqlA, onChange: (e) => setSqlA(e.target.value), className: "font-mono text-xs" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Label, { children: "B \u2014" }), _jsxs(Select, { value: connB || id, onValueChange: setConnB, children: [_jsx(SelectTrigger, { className: "h-7 text-xs w-56", children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: (connsQ.data ?? []).map((c) => (_jsx(SelectItem, { value: c.id, children: c.name }, c.id))) })] })] }), _jsx(Textarea, { rows: 4, value: sqlB, onChange: (e) => setSqlB(e.target.value), placeholder: "Leave blank to reuse query A", className: "font-mono text-xs" })] })] }), _jsx("div", { className: "flex-1 min-h-0 overflow-auto", children: diff ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "px-4 py-2 border-b border-border flex items-center gap-3 text-xs", children: [_jsxs(Badge, { variant: "outline", children: [diff.same, " identical"] }), _jsxs("button", { onClick: () => setView("onlyA"), className: view === "onlyA" ? "text-primary font-medium" : "text-muted-foreground", children: ["Only in A: ", diff.onlyA.length] }), _jsxs("button", { onClick: () => setView("onlyB"), className: view === "onlyB" ? "text-primary font-medium" : "text-muted-foreground", children: ["Only in B: ", diff.onlyB.length] }), diff.onlyA.length === 0 && diff.onlyB.length === 0 && (_jsx("span", { className: "text-emerald-500 font-medium", children: "Result sets are identical \u2713" }))] }), shownRows.length > 0 ? (_jsx(DataGrid, { columns: shownFields.map((f) => ({ name: f.name, type: f.dataType })), rows: shownRows })) : (_jsx("div", { className: "p-6 text-sm text-muted-foreground", children: "No rows unique to this side." }))] })) : (_jsx("div", { className: "h-full flex items-center justify-center text-sm text-muted-foreground", children: "Write a query, pick connection B, run both." })) })] }));
}
