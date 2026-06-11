import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";
const SKIP = "__skip__";
export function CsvImportDialog(props) {
    const { open, onOpenChange, connectionId, schema, table, tableColumns, onCommitted } = props;
    const [stage, setStage] = useState("pick");
    const [upload, setUpload] = useState(null);
    const [mappings, setMappings] = useState({});
    const [dryRun, setDryRun] = useState(null);
    const [commitResult, setCommitResult] = useState(null);
    const fileRef = useRef(null);
    const reset = () => {
        setStage("pick");
        setUpload(null);
        setMappings({});
        setDryRun(null);
        setCommitResult(null);
        if (fileRef.current)
            fileRef.current.value = "";
    };
    const close = () => {
        // Fire-and-forget session cleanup — if it fails the server will sweep it.
        if (upload && stage !== "result") {
            api.csvDiscard(connectionId, upload.sessionId).catch(() => { });
        }
        reset();
        onOpenChange(false);
    };
    const uploadMutation = useMutation({
        mutationFn: (file) => api.uploadCsv(connectionId, file),
        onSuccess: (r) => {
            setUpload(r);
            // Auto-map: match headers to target columns by exact name, then lowercase.
            const byLower = new Map(tableColumns.map((c) => [c.name.toLowerCase(), c.name]));
            const next = {};
            for (const c of tableColumns)
                next[c.name] = null;
            for (let i = 0; i < r.headers.length; i++) {
                const h = r.headers[i];
                const match = byLower.get(h.toLowerCase());
                if (match)
                    next[match] = i;
            }
            setMappings(next);
            setStage("map");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const dryRunMutation = useMutation({
        mutationFn: () => api.csvDryRun(connectionId, upload.sessionId, {
            schema,
            table,
            mappings: toApiMappings(mappings),
        }),
        onSuccess: (r) => setDryRun(r),
        onError: (e) => {
            setDryRun(null);
            toast.error(extractErrorMessage(e));
        },
    });
    const commitMutation = useMutation({
        mutationFn: (stopOnError) => api.csvCommit(connectionId, upload.sessionId, {
            schema,
            table,
            mappings: toApiMappings(mappings),
            stopOnError,
        }),
        onSuccess: (r) => {
            setCommitResult(r);
            setStage("result");
            if (r.inserted > 0)
                onCommitted?.();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const onFileChange = (e) => {
        const f = e.target.files?.[0];
        if (f)
            uploadMutation.mutate(f);
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => (v ? onOpenChange(true) : close()), children: _jsxs(DialogContent, { className: "max-w-2xl", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Import CSV" }), _jsxs(DialogDescription, { children: ["Load rows from a CSV file into ", schema, ".", table, "."] })] }), stage === "pick" && (_jsxs("div", { className: "py-8 flex flex-col items-center justify-center gap-3 border-2 border-dashed border-border rounded-md", children: [_jsx(Upload, { className: "h-8 w-8 text-muted-foreground" }), _jsx("div", { className: "text-sm text-muted-foreground", children: "Choose a CSV file to import" }), _jsx("input", { ref: fileRef, type: "file", accept: ".csv,text/csv", onChange: onFileChange, className: "hidden", id: "csv-import-file" }), _jsx("label", { htmlFor: "csv-import-file", children: _jsx(Button, { asChild: false, onClick: () => fileRef.current?.click(), disabled: uploadMutation.isPending, children: uploadMutation.isPending ? (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Uploading\u2026"] })) : ("Pick file") }) }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Max 50MB. Must include a header row." })] })), stage === "map" && upload && (_jsx(MappingStep, { upload: upload, tableColumns: tableColumns, mappings: mappings, onMappingChange: setMappings, dryRun: dryRun, dryRunPending: dryRunMutation.isPending, onDryRun: () => dryRunMutation.mutate() })), stage === "result" && commitResult && (_jsx(ResultStep, { result: commitResult, upload: upload })), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "ghost", onClick: close, children: stage === "result" ? "Close" : "Cancel" }), stage === "map" && (_jsxs(_Fragment, { children: [!dryRun && (_jsxs(Button, { variant: "outline", onClick: () => dryRunMutation.mutate(), disabled: dryRunMutation.isPending, children: [dryRunMutation.isPending && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Dry run"] })), dryRun && (_jsxs(Button, { onClick: () => commitMutation.mutate(false), disabled: commitMutation.isPending || dryRun.okRows === 0, children: [commitMutation.isPending && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Import ", dryRun.okRows, " rows"] }))] }))] })] }) }));
}
function toApiMappings(map) {
    return Object.entries(map).map(([targetColumn, csvColumn]) => ({ targetColumn, csvColumn }));
}
function MappingStep({ upload, tableColumns, mappings, onMappingChange, dryRun, dryRunPending, onDryRun, }) {
    // Re-run dry-run when user changes a mapping? Leave manual for now — the
    // dry-run is cheap but tapping each dropdown triggers a full re-parse pass.
    const setCol = (target, csvIndex) => {
        onMappingChange({ ...mappings, [target]: csvIndex });
    };
    const requiredCols = useMemo(() => tableColumns.filter((c) => !c.nullable && c.defaultValue == null && !c.isIdentity), [tableColumns]);
    const missingRequired = requiredCols.filter((c) => mappings[c.name] == null);
    return (_jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "text-xs text-muted-foreground", children: [_jsx("strong", { children: upload.filename }), " \u2014 ", upload.totalRows, " rows,", " ", upload.headers.length, " columns. Map each target column below."] }), _jsx("div", { className: "rounded-md border border-border max-h-80 overflow-auto", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground sticky top-0", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Target column" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-48", children: "CSV column" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-48", children: "Preview" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: tableColumns.map((col) => {
                                const csvIndex = mappings[col.name] ?? null;
                                const required = !col.nullable && col.defaultValue == null && !col.isIdentity;
                                return (_jsxs("tr", { children: [_jsxs("td", { className: "px-3 py-2", children: [_jsxs("div", { className: "font-medium", children: [col.name, required && _jsx("span", { className: "text-destructive", children: " *" })] }), _jsx("div", { className: "text-xs text-muted-foreground", children: col.dataType })] }), _jsx("td", { className: "px-3 py-2", children: _jsxs(Select, { value: csvIndex === null ? SKIP : String(csvIndex), onValueChange: (v) => setCol(col.name, v === SKIP ? null : parseInt(v, 10)), children: [_jsx(SelectTrigger, { className: "h-8", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: SKIP, children: "\u2014 skip \u2014" }), upload.headers.map((h, i) => (_jsx(SelectItem, { value: String(i), children: h || `(col ${i + 1})` }, i)))] })] }) }), _jsx("td", { className: "px-3 py-2 text-xs text-muted-foreground font-mono truncate max-w-xs", children: csvIndex !== null
                                                ? upload.sample
                                                    .slice(0, 3)
                                                    .map((r) => r[upload.headers[csvIndex]] ?? "")
                                                    .filter(Boolean)
                                                    .join(" · ")
                                                : "—" })] }, col.name));
                            }) })] }) }), missingRequired.length > 0 && (_jsxs("div", { className: "flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400", children: [_jsx(AlertTriangle, { className: "h-4 w-4 mt-0.5 shrink-0" }), _jsxs("div", { children: ["Required columns not yet mapped:", " ", _jsx("span", { className: "font-mono", children: missingRequired.map((c) => c.name).join(", ") })] })] })), dryRun && (_jsxs("div", { className: dryRun.errorRows.length === 0
                    ? "rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs"
                    : "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs", children: [_jsx("div", { className: "flex items-center gap-2 font-medium", children: dryRun.errorRows.length === 0 ? (_jsxs(_Fragment, { children: [_jsx(CheckCircle2, { className: "h-4 w-4 text-emerald-600" }), " Dry run passed"] })) : (_jsxs(_Fragment, { children: [_jsx(AlertTriangle, { className: "h-4 w-4 text-amber-600" }), " Dry run found errors"] })) }), _jsxs("div", { className: "mt-1 text-muted-foreground", children: [dryRun.okRows, " / ", dryRun.totalRows, " rows would be inserted.", dryRun.errorRows.length > 0 && ` ${dryRun.errorRows.length} error rows (showing first 5):`] }), dryRun.errorRows.length > 0 && (_jsx("ul", { className: "mt-2 space-y-1 font-mono", children: dryRun.errorRows.slice(0, 5).map((e) => (_jsxs("li", { children: ["row ", e.rowIndex + 1, ": ", e.message] }, e.rowIndex))) }))] })), dryRun && !dryRunPending && (_jsxs("div", { className: "text-xs text-muted-foreground", children: ["Mapping changed?", " ", _jsx("button", { type: "button", className: "underline hover:text-foreground", onClick: onDryRun, children: "Re-run dry run" })] }))] }));
}
function ResultStep({ result, upload, }) {
    const total = (upload?.totalRows ?? 0);
    return (_jsxs("div", { className: "py-4 space-y-3", children: [_jsx("div", { className: "flex items-center gap-2 text-lg font-semibold", children: result.failed.length === 0 ? (_jsxs(_Fragment, { children: [_jsx(CheckCircle2, { className: "h-6 w-6 text-emerald-600" }), " Import complete"] })) : (_jsxs(_Fragment, { children: [_jsx(AlertTriangle, { className: "h-6 w-6 text-amber-600" }), " Import finished with errors"] })) }), _jsxs("div", { className: "text-sm", children: ["Inserted ", _jsx("strong", { children: result.inserted }), " of ", _jsx("strong", { children: total }), " rows in", " ", result.durationMs, "ms."] }), result.failed.length > 0 && (_jsxs("div", { className: "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs", children: [_jsxs("div", { className: "font-medium mb-1", children: [result.failed.length, " rows failed (first 5):"] }), _jsx("ul", { className: "space-y-1 font-mono", children: result.failed.slice(0, 5).map((e) => (_jsxs("li", { children: ["row ", e.rowIndex + 1, ": ", e.message] }, e.rowIndex))) })] }))] }));
}
