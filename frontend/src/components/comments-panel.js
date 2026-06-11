import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MessageSquare, Send, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-store";
import { useModal } from "@/components/modal-provider";
export function CommentsPanel({ connectionId, target, label }) {
    const qc = useQueryClient();
    const modal = useModal();
    const { user } = useAuth();
    const [draft, setDraft] = useState("");
    const q = useQuery({
        queryKey: ["comments", connectionId, target],
        queryFn: () => api.listComments(connectionId, target),
        enabled: !!connectionId && !!target,
    });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["comments", connectionId, target] });
        qc.invalidateQueries({ queryKey: ["comment-counts", connectionId] });
    };
    const create = useMutation({
        mutationFn: (body) => api.createComment(connectionId, { target, body }),
        onSuccess: () => {
            setDraft("");
            invalidate();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const remove = useMutation({
        mutationFn: (commentId) => api.deleteComment(connectionId, commentId),
        onSuccess: () => invalidate(),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const submit = (e) => {
        e.preventDefault();
        if (!draft.trim() || create.isPending)
            return;
        create.mutate(draft);
    };
    return (_jsxs("div", { className: "space-y-3", children: [label && (_jsxs("div", { className: "flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider", children: [_jsx(MessageSquare, { className: "h-3 w-3" }), _jsx("span", { children: label }), q.data && q.data.length > 0 && _jsxs("span", { className: "normal-case", children: ["\u00B7 ", q.data.length] })] })), _jsxs("div", { className: "space-y-2 max-h-72 overflow-y-auto pr-1", children: [q.isLoading && (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx(Loader2, { className: "h-3 w-3 animate-spin" }), " Loading\u2026"] })), q.data && q.data.length === 0 && !q.isLoading && (_jsx("div", { className: "text-xs text-muted-foreground italic", children: "No comments yet." })), q.data?.map((c) => (_jsx(CommentItem, { comment: c, ownedByMe: c.userId === user?.id, onDelete: async () => {
                            const ok = await modal.confirm({
                                title: "Delete comment?",
                                confirmLabel: "Delete",
                                destructive: true,
                            });
                            if (ok)
                                remove.mutate(c.id);
                        } }, c.id)))] }), _jsxs("form", { onSubmit: submit, className: "space-y-2", children: [_jsx(Textarea, { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: "Write a comment\u2026", rows: 2, className: "text-xs", disabled: create.isPending }), _jsx("div", { className: "flex justify-end", children: _jsxs(Button, { type: "submit", size: "sm", disabled: !draft.trim() || create.isPending, children: [create.isPending ? _jsx(Loader2, { className: "h-3 w-3 animate-spin" }) : _jsx(Send, { className: "h-3 w-3" }), "Post"] }) })] })] }));
}
function CommentItem({ comment, ownedByMe, onDelete, }) {
    const author = comment.user?.displayName || comment.user?.email || comment.userId;
    return (_jsxs("div", { className: "rounded-md border border-border bg-card px-3 py-2 space-y-1 group", children: [_jsxs("div", { className: "flex items-center gap-2 text-[10px] text-muted-foreground", children: [_jsx("span", { className: "font-medium text-foreground", children: author }), _jsx("span", { children: "\u00B7" }), _jsx("span", { children: formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true }) }), ownedByMe && (_jsx("button", { type: "button", onClick: onDelete, className: "ml-auto text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100", title: "Delete", children: _jsx(Trash2, { className: "h-3 w-3" }) }))] }), _jsx("div", { className: "text-xs whitespace-pre-wrap break-words", children: comment.body })] }));
}
