import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { CheckCircle2, Clock, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
const STATUS_UI = {
    PENDING: { label: "Pending", icon: _jsx(Clock, { className: "h-3 w-3" }), cls: "text-amber-600 dark:text-amber-400" },
    APPROVED: { label: "Approved", icon: _jsx(CheckCircle2, { className: "h-3 w-3" }), cls: "text-emerald-600 dark:text-emerald-400" },
    REJECTED: { label: "Rejected", icon: _jsx(XCircle, { className: "h-3 w-3" }), cls: "text-destructive" },
    EXECUTED: { label: "Executed", icon: _jsx(CheckCircle2, { className: "h-3 w-3" }), cls: "text-muted-foreground" },
    EXPIRED: { label: "Expired", icon: _jsx(XCircle, { className: "h-3 w-3" }), cls: "text-muted-foreground" },
};
export default function ReviewRequestsRoute() {
    const { id } = useParams();
    const qc = useQueryClient();
    const [filter, setFilter] = useState("ALL");
    const q = useQuery({
        queryKey: ["review-requests", id, filter],
        queryFn: () => api.listReviewRequests(id, filter === "ALL" ? undefined : filter),
        enabled: !!id,
    });
    const approve = useMutation({
        mutationFn: ({ id, comment }) => api.approveReviewRequest(id, comment),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["review-requests", id] });
            toast.success("Approved");
        },
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    const reject = useMutation({
        mutationFn: ({ id, comment }) => api.rejectReviewRequest(id, comment),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["review-requests", id] });
            toast.success("Rejected");
        },
        onError: (err) => toast.error(extractErrorMessage(err)),
    });
    return (_jsxs("div", { className: "h-full overflow-auto", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10", children: [_jsx(ShieldCheck, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "Query review requests" }), _jsx("div", { className: "ml-auto flex items-center gap-1", children: ["ALL", "PENDING", "APPROVED", "REJECTED", "EXECUTED", "EXPIRED"].map((s) => (_jsx("button", { onClick: () => setFilter(s), className: "text-xs px-2 py-1 rounded border " +
                                (filter === s
                                    ? "bg-primary/10 text-primary border-primary/40"
                                    : "text-muted-foreground border-border hover:bg-accent"), children: s === "ALL" ? "All" : STATUS_UI[s].label }, s))) })] }), _jsxs("div", { className: "p-4", children: [q.isLoading && (_jsxs("div", { className: "text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin inline" }), " Loading..."] })), q.data?.length === 0 && (_jsx("div", { className: "rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground", children: "No requests match this filter." })), _jsx("div", { className: "space-y-2", children: q.data?.map((r) => (_jsx(RequestCard, { req: r, onApprove: (comment) => approve.mutate({ id: r.id, comment }), onReject: (comment) => reject.mutate({ id: r.id, comment }), pending: approve.isPending || reject.isPending }, r.id))) })] })] }));
}
function RequestCard({ req, onApprove, onReject, pending, }) {
    const [comment, setComment] = useState("");
    const ui = STATUS_UI[req.status];
    return (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2 text-xs", children: [_jsxs("span", { className: "inline-flex items-center gap-1 font-medium " + ui.cls, children: [ui.icon, ui.label] }), _jsxs("span", { className: "text-muted-foreground", children: ["\u00B7 ", req.classification, " \u00B7 ", format(new Date(req.createdAt), "MMM d HH:mm"), " \u00B7 by", " ", req.requester.displayName || req.requester.email] })] }), req.reason && (_jsxs("div", { className: "text-xs", children: [_jsx("span", { className: "text-muted-foreground", children: "Reason: " }), req.reason] })), _jsx("pre", { className: "rounded bg-muted p-2 text-[11px] font-mono overflow-x-auto max-h-32", children: req.sqlText }), req.reviewComment && (_jsxs("div", { className: "text-xs border-l-2 border-border pl-2", children: [_jsxs("span", { className: "text-muted-foreground", children: [req.reviewer ? (req.reviewer.displayName || req.reviewer.email) : "Reviewer", ":"] }), " ", req.reviewComment] })), req.status === "PENDING" && (_jsxs("div", { className: "flex items-center gap-2 pt-1", children: [_jsx(Input, { value: comment, onChange: (e) => setComment(e.target.value), placeholder: "Optional comment", className: "h-8 text-xs flex-1" }), _jsx(Button, { size: "sm", variant: "outline", onClick: () => onReject(comment.trim() || undefined), disabled: pending, className: "text-destructive hover:text-destructive", children: "Reject" }), _jsx(Button, { size: "sm", onClick: () => onApprove(comment.trim() || undefined), disabled: pending, children: "Approve" })] }))] }));
}
