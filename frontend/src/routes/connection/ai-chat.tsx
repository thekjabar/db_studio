import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { Copy, Loader2, Play, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sqlBlock: string | null;
  createdAt: string;
};

export default function AiChatRoute() {
  const { id } = useParams<{ id: string }>();
  const [sp, setSp] = useSearchParams();
  const chatId = sp.get("chat");
  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ["ai-chats", id],
    queryFn: () => api.listAiChats(id!),
    enabled: !!id,
  });
  const chatQ = useQuery({
    queryKey: ["ai-chat", chatId],
    queryFn: () => api.getAiChat(chatId!),
    enabled: !!chatId,
  });

  const [draft, setDraft] = useState("");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const send = useMutation({
    mutationFn: (content: string) =>
      api.sendAiChatMessage({
        chatId: chatId ?? undefined,
        connectionId: id!,
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
    mutationFn: (chId: string) => api.deleteAiChat(chId),
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

  return (
    <div className="h-full flex">
      {/* Sidebar — chat history */}
      <aside className="w-56 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-3 py-2 text-[10px] uppercase font-medium tracking-wider text-muted-foreground border-b border-border flex items-center justify-between">
          <span>Chats</span>
          <button
            onClick={newChat}
            className="p-0.5 rounded hover:bg-accent"
            title="New chat"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1">
          {listQ.data?.length === 0 && (
            <div className="p-3 text-[11px] text-muted-foreground text-center">
              No chats yet. Start a new conversation.
            </div>
          )}
          {listQ.data?.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-xs",
                c.id === chatId && "bg-accent",
              )}
            >
              <Link
                to={`?chat=${c.id}`}
                className="flex-1 truncate"
                title={c.title}
              >
                {c.title}
              </Link>
              <button
                onClick={() => del.mutate(c.id)}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <div className="text-sm font-semibold">AI chat</div>
          <div className="ml-auto text-[11px] text-muted-foreground">
            {chatId ? "Iterate on queries with the assistant. Conversation history + schema sent on every turn." : "Pick a chat or start a new one."}
          </div>
        </div>

        <div
          ref={messagesRef}
          className="flex-1 overflow-auto p-4 space-y-4"
        >
          {!chatId && !send.isPending && (
            <div className="max-w-xl mx-auto text-center mt-8">
              <Sparkles className="h-8 w-8 text-primary mx-auto mb-2" />
              <div className="font-semibold">Ask me about this database</div>
              <p className="text-sm text-muted-foreground mt-1">
                Describe what you want to see. I'll write the SQL and we can refine across turns.
              </p>
              <div className="text-xs text-muted-foreground mt-4 space-y-1">
                <div>• "Show me users who signed up this week"</div>
                <div>• "Now group by day and add a running total"</div>
                <div>• "Drop the null-email rows and limit to 50"</div>
              </div>
            </div>
          )}
          {chatQ.data?.messages.map((m) => <MessageBubble key={m.id} message={m} connectionId={id!} />)}
          {pendingUser && (
            <MessageBubble
              message={{
                id: "pending-user",
                role: "user",
                content: pendingUser,
                sqlBlock: null,
                createdAt: new Date().toISOString(),
              }}
              connectionId={id!}
            />
          )}
          {send.isPending && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
            </div>
          )}
        </div>

        <div className="border-t border-border p-3">
          <div className="flex items-end gap-2 max-w-3xl mx-auto">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (draft.trim()) send.mutate(draft.trim());
                }
              }}
              placeholder="Describe what you want, Ctrl/⌘+Enter to send"
              rows={3}
              className="flex-1 resize-none font-mono text-xs"
              maxLength={4000}
            />
            <Button
              onClick={() => draft.trim() && send.mutate(draft.trim())}
              disabled={send.isPending || !draft.trim()}
            >
              <Send className="h-3.5 w-3.5" /> Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  connectionId,
}: {
  message: Message;
  connectionId: string;
}) {
  const isUser = message.role === "user";
  return (
    <div className={cn("max-w-3xl mx-auto", isUser ? "ml-auto" : "")}>
      <div
        className={cn(
          "rounded-md p-3 text-sm whitespace-pre-wrap break-words",
          isUser
            ? "bg-primary/10 text-foreground border border-primary/20"
            : "bg-card border border-border",
        )}
      >
        {message.content}
      </div>
      {!isUser && message.sqlBlock && (
        <div className="mt-2 rounded-md border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>SQL</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(message.sqlBlock!).then(
                    () => toast.success("Copied"),
                    () => toast.error("Copy failed"),
                  );
                }}
                className="p-1 rounded hover:bg-accent"
                title="Copy"
              >
                <Copy className="h-3 w-3" />
              </button>
              <Link
                to={`/c/${connectionId}/sql?sql=${encodeURIComponent(message.sqlBlock)}`}
                className="inline-flex items-center gap-1 p-1 rounded hover:bg-accent"
                title="Open in SQL editor"
              >
                <Play className="h-3 w-3" />
              </Link>
            </div>
          </div>
          <pre className="p-2 text-[11px] font-mono overflow-x-auto">{message.sqlBlock}</pre>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground mt-1 px-1">
        {format(new Date(message.createdAt), "HH:mm")}
      </div>
    </div>
  );
}
