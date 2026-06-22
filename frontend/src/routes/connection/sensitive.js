import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ScanSearch, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useModal } from "@/components/modal-provider";
/**
 * Sensitive-data scanner: heuristically flags likely-PII columns (emails,
 * phones, passwords, card numbers…) so the owner can mask them for specific
 * team members. Pairs with the existing column-masks feature — "Mask" creates
 * a mask right from a finding.
 */
export default function SensitiveScanRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const modal = useModal();
    const [findings, setFindings] = useState(null);
    const [tablesScanned, setTablesScanned] = useState(0);
    const masksQ = useQuery({
        queryKey: ["column-masks", id],
        queryFn: () => api.listColumnMasks(id),
        enabled: !!id,
    });
    const membersQ = useQuery({
        queryKey: ["conn-members", id],
        queryFn: () => api.listConnectionMembers(id),
        enabled: !!id,
    });
    const scan = useMutation({
        mutationFn: () => api.scanSensitive(id),
        onSuccess: (r) => {
            setFindings(r.findings);
            setTablesScanned(r.tablesScanned);
            toast.success(`Scanned ${r.tablesScanned} tables — ${r.findings.length} potential finding(s)`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const isMasked = (f) => (masksQ.data ?? []).some((m) => m.schemaName === f.schema && m.tableName === f.table && m.columnName === f.column);
    const maskFinding = async (f) => {
        const members = membersQ.data ?? [];
        if (members.length === 0) {
            toast.error("Add a connection member first — masks apply per member.");
            return;
        }
        const email = await modal.select({
            title: `Mask ${f.table}.${f.column} for…`,
            description: "The selected member will see this column masked.",
            options: members.map((m) => ({ value: m.email, label: m.email })),
        });
        if (!email)
            return;
        try {
            await api.createColumnMask(id, {
                email,
                schemaName: f.schema,
                tableName: f.table,
                columnName: f.column,
            });
            toast.success("Column mask created");
            qc.invalidateQueries({ queryKey: ["column-masks", id] });
        }
        catch (e) {
            toast.error(extractErrorMessage(e));
        }
    };
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(ScanSearch, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Sensitive data scanner" }), _jsx("div", { className: "ml-auto", children: _jsxs(Button, { size: "sm", onClick: () => scan.mutate(), disabled: scan.isPending, children: [scan.isPending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(ScanSearch, { className: "h-3.5 w-3.5" }), findings ? "Re-scan" : "Scan now"] }) })] }), _jsxs("div", { className: "max-w-4xl mx-auto p-4 space-y-4", children: [_jsx("p", { className: "text-xs text-muted-foreground", children: "Scans column names and types for likely PII \u2014 emails, phones, passwords, national IDs, payment cards. Findings are heuristic: review each before masking. Masks apply per team member via the existing column-mask feature. Introspection only \u2014 no row data is read." }), !findings && !scan.isPending && (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground", children: ["Click ", _jsx("strong", { children: "Scan now" }), " to analyze this connection's schema."] })), findings && findings.length === 0 && (_jsxs("div", { className: "rounded-md border border-border p-8 text-center", children: [_jsx(ShieldCheck, { className: "h-8 w-8 text-emerald-500 mx-auto mb-2" }), _jsx("div", { className: "text-sm font-medium", children: "No likely-sensitive columns found" }), _jsxs("div", { className: "text-xs text-muted-foreground mt-1", children: [tablesScanned, " tables scanned."] })] })), findings && findings.length > 0 && (_jsx("div", { className: "rounded-md border border-border overflow-hidden", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { className: "text-left", children: [_jsx("th", { className: "px-3 py-2 font-medium", children: "Column" }), _jsx("th", { className: "px-3 py-2 font-medium", children: "Looks like" }), _jsx("th", { className: "px-3 py-2 font-medium", children: "Type" }), _jsx("th", { className: "px-3 py-2 font-medium", children: "Confidence" }), _jsx("th", { className: "px-3 py-2 font-medium text-right", children: "Action" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: findings.map((f, i) => (_jsxs("tr", { children: [_jsxs("td", { className: "px-3 py-2 font-mono text-xs", children: [f.table, ".", _jsx("span", { className: "text-foreground font-semibold", children: f.column })] }), _jsx("td", { className: "px-3 py-2", children: _jsxs(Badge, { variant: f.kind === "password" || f.kind === "secret/token" ? "destructive" : "secondary", children: [_jsx(ShieldAlert, { className: "h-3 w-3 mr-1" }), " ", f.kind] }) }), _jsx("td", { className: "px-3 py-2 font-mono text-xs text-muted-foreground", children: f.dataType }), _jsx("td", { className: "px-3 py-2 text-xs", children: f.confidence }), _jsx("td", { className: "px-3 py-2 text-right", children: isMasked(f) ? (_jsx(Badge, { variant: "outline", className: "text-emerald-500 border-emerald-500/30", children: "Masked" })) : (_jsx(Button, { size: "sm", variant: "outline", onClick: () => maskFinding(f), children: "Mask\u2026" })) })] }, i))) })] }) }))] })] }));
}
