import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Copy, Loader2, Play, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";
export default function AiChatRoute() {
    const { id } = useParams();
    const [sp, setSp] = useSearchParams();
    const chatId = sp.get("chat");
    const qc = useQueryClient();
    const modal = useModal();
    const listQ = useQuery({
        queryKey: ["ai-chats", id],
        queryFn: () => api.listAiChats(id),
        enabled: !!id,
    });
    const chatQ = useQuery({
        queryKey: ["ai-chat", chatId],
        queryFn: () => api.getAiChat(chatId),
        enabled: !!chatId,
    });
    const [draft, setDraft] = useState("");
    const messagesRef = useRef(null);
    const scrollToBottom = () => {
        requestAnimationFrame(() => {
            messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
        });
    };
    const send = useMutation({
        mutationFn: (content) => api.sendAiChatMessage({
            chatId: chatId ?? undefined,
            connectionId: id,
            content,
        }),
        onSuccess: (r) => {
            if (!chatId) {
                setSp((p) => {
                    p.set("chat", r.chatId);
                    return p;
                }, { replace: true });
            }
            qc.invalidateQueries({ queryKey: ["ai-chat", r.chatId] });
            qc.invalidateQueries({ queryKey: ["ai-chats", id] });
            setDraft("");
            scrollToBottom();
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const del = useMutation({
        mutationFn: (chId) => api.deleteAiChat(chId),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["ai-chats", id] });
            if (chatId) {
                setSp((p) => {
                    p.delete("chat");
                    return p;
                }, { replace: true });
            }
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const newChat = () => {
        setSp((p) => {
            p.delete("chat");
            return p;
        }, { replace: true });
        setDraft("");
    };
    // Optimistic user message: the backend doesn't return the user turn (it
    // stored it), so we render the pending text locally until the assistant
    // reply arrives and triggers a refetch.
    const pendingUser = send.isPending ? send.variables : null;
    useEffect(scrollToBottom, [chatQ.data, pendingUser]);
    return (_jsxs("div", { className: "h-full flex", children: [_jsxs("aside", { className: "w-56 shrink-0 border-r border-border bg-card flex flex-col", children: [_jsxs("div", { className: "px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-b border-border flex items-center justify-between", children: [_jsx("span", { children: "Chats" }), _jsx("button", { onClick: newChat, className: "p-0.5 rounded hover:bg-accent", title: "New chat", children: _jsx(Plus, { className: "h-3 w-3" }) })] }), _jsxs("div", { className: "flex-1 overflow-auto p-1", children: [listQ.data?.length === 0 && (_jsx("div", { className: "p-3 text-[11px] text-muted-foreground text-center", children: "No chats yet. Start a new conversation." })), listQ.data?.map((c) => (_jsxs("div", { className: cn("group flex items-center gap-1 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-xs", c.id === chatId && "bg-accent"), children: [_jsx(Link, { to: `?chat=${c.id}`, className: "flex-1 truncate", title: c.title, children: c.title }), _jsx("button", { onClick: async (e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const ok = await modal.confirm({
                                                title: "Delete chat?",
                                                description: `"${c.title}" will be permanently removed along with all of its messages.`,
                                                confirmLabel: "Delete",
                                                destructive: true,
                                            });
                                            if (ok)
                                                del.mutate(c.id);
                                        }, className: "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive", children: _jsx(Trash2, { className: "h-3 w-3" }) })] }, c.id)))] })] }), _jsxs("div", { className: "flex-1 flex flex-col min-w-0", children: [_jsxs("div", { className: "px-4 py-3 border-b border-border flex items-center gap-2", children: [_jsx(Sparkles, { className: "h-4 w-4 text-primary" }), _jsx("div", { className: "text-sm font-semibold", children: "AI chat" }), _jsx("div", { className: "ml-auto text-[11px] text-muted-foreground", children: chatId ? "Iterate on queries with the assistant. Conversation history + schema sent on every turn." : "Pick a chat or start a new one." })] }), _jsxs("div", { ref: messagesRef, className: "flex-1 overflow-auto p-4 space-y-4", children: [!chatId && !send.isPending && (_jsxs("div", { className: "max-w-xl mx-auto text-center mt-8", children: [_jsx(Sparkles, { className: "h-8 w-8 text-primary mx-auto mb-2" }), _jsx("div", { className: "font-semibold", children: "Ask me about this database" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Describe what you want to see. I'll write the SQL and we can refine across turns." }), _jsxs("div", { className: "text-xs text-muted-foreground mt-4 space-y-1", children: [_jsx("div", { children: "\u2022 \"Show me users who signed up this week\"" }), _jsx("div", { children: "\u2022 \"Now group by day and add a running total\"" }), _jsx("div", { children: "\u2022 \"Drop the null-email rows and limit to 50\"" })] })] })), chatQ.data?.messages.map((m) => _jsx(MessageBubble, { message: m, connectionId: id }, m.id)), pendingUser && (_jsx(MessageBubble, { message: {
                                    id: "pending-user",
                                    role: "user",
                                    content: pendingUser,
                                    sqlBlock: null,
                                    createdAt: new Date().toISOString(),
                                }, connectionId: id })), send.isPending && (_jsxs("div", { className: "flex items-center gap-2 text-xs text-muted-foreground", children: [_jsx(Loader2, { className: "h-3 w-3 animate-spin" }), " Thinking\u2026"] }))] }), _jsx("div", { className: "border-t border-border p-3", children: _jsxs("div", { className: "flex items-end gap-2 max-w-3xl mx-auto", children: [_jsx(Textarea, { value: draft, onChange: (e) => setDraft(e.target.value), onKeyDown: (e) => {
                                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                            e.preventDefault();
                                            if (draft.trim())
                                                send.mutate(draft.trim());
                                        }
                                    }, placeholder: "Describe what you want, Ctrl/\u2318+Enter to send", rows: 3, className: "flex-1 resize-none font-mono text-xs", maxLength: 4000 }), _jsxs(Button, { onClick: () => draft.trim() && send.mutate(draft.trim()), disabled: send.isPending || !draft.trim(), children: [_jsx(Send, { className: "h-3.5 w-3.5" }), " Send"] })] }) })] })] }));
}
function MessageBubble({ message, connectionId, }) {
    const isUser = message.role === "user";
    return (_jsxs("div", { className: cn("max-w-3xl mx-auto", isUser ? "ml-auto" : ""), children: [_jsx("div", { className: cn("rounded-md p-3 text-sm whitespace-pre-wrap break-words", isUser
                    ? "bg-primary/10 text-foreground border border-primary/20"
                    : "bg-card border border-border"), children: message.content }), !isUser && message.sqlBlock && (_jsxs("div", { className: "mt-2 rounded-md border border-border bg-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-2 py-1 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground", children: [_jsx("span", { children: "SQL" }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsx("button", { onClick: () => {
                                            navigator.clipboard.writeText(message.sqlBlock).then(() => toast.success("Copied"), () => toast.error("Copy failed"));
                                        }, className: "p-1 rounded hover:bg-accent", title: "Copy", children: _jsx(Copy, { className: "h-3 w-3" }) }), _jsx(Link, { to: `/c/${connectionId}/sql?sql=${encodeURIComponent(message.sqlBlock)}`, className: "inline-flex items-center gap-1 p-1 rounded hover:bg-accent", title: "Open in SQL editor", children: _jsx(Play, { className: "h-3 w-3" }) })] })] }), _jsx("pre", { className: "p-2 text-[11px] font-mono overflow-x-auto", children: message.sqlBlock })] })), _jsx("div", { className: "text-[10px] text-muted-foreground mt-1 px-1", children: format(new Date(message.createdAt), "HH:mm") })] }));
}
