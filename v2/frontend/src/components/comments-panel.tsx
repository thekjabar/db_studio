import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Loader2, MessageSquare, Send, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type Comment } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth-store";
import { useModal } from "@/components/modal-provider";

interface Props {
  connectionId: string;
  /**
   * Polymorphic target string. Examples:
   *   "table:public.users"
   *   "column:public.users.email"
   *   "row:public.users:{\"id\":\"abc-123\"}"
   */
  target: string;
  /** Optional header label shown above the thread. */
  label?: string;
}

export function CommentsPanel({ connectionId, target, label }: Props) {
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
    mutationFn: (body: string) => api.createComment(connectionId, { target, body }),
    onSuccess: () => {
      setDraft("");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (commentId: string) => api.deleteComment(connectionId, commentId),
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || create.isPending) return;
    create.mutate(draft);
  };

  return (
    <div className="space-y-3">
      {label && (
        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          <MessageSquare className="h-3 w-3" />
          <span>{label}</span>
          {q.data && q.data.length > 0 && <span className="normal-case">· {q.data.length}</span>}
        </div>
      )}
      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        {q.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        )}
        {q.data && q.data.length === 0 && !q.isLoading && (
          <div className="text-xs text-muted-foreground italic">No comments yet.</div>
        )}
        {q.data?.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            ownedByMe={c.userId === user?.id}
            onDelete={async () => {
              const ok = await modal.confirm({
                title: "Delete comment?",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) remove.mutate(c.id);
            }}
          />
        ))}
      </div>
      <form onSubmit={submit} className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment…"
          rows={2}
          className="text-xs"
          disabled={create.isPending}
        />
        {/* Left-align Post so the bottom-right floating Feedback button can't
            sit on top of it. */}
        <div className="flex justify-start">
          <Button type="submit" size="sm" disabled={!draft.trim() || create.isPending}>
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Post
          </Button>
        </div>
      </form>
    </div>
  );
}

function CommentItem({
  comment,
  ownedByMe,
  onDelete,
}: {
  comment: Comment;
  ownedByMe: boolean;
  onDelete: () => void;
}) {
  const author = comment.user?.displayName || comment.user?.email || comment.userId;
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 space-y-1 group">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">{author}</span>
        <span>·</span>
        <span>{formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}</span>
        {ownedByMe && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-auto text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="text-xs whitespace-pre-wrap break-words">{comment.body}</div>
    </div>
  );
}
