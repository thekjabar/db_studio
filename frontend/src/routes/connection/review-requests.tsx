import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { CheckCircle2, Clock, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Status = "PENDING" | "APPROVED" | "REJECTED" | "EXECUTED" | "EXPIRED";

const STATUS_UI: Record<
  Status,
  { label: string; icon: React.ReactNode; cls: string }
> = {
  PENDING: { label: "Pending", icon: <Clock className="h-3 w-3" />, cls: "text-amber-600 dark:text-amber-400" },
  APPROVED: { label: "Approved", icon: <CheckCircle2 className="h-3 w-3" />, cls: "text-emerald-600 dark:text-emerald-400" },
  REJECTED: { label: "Rejected", icon: <XCircle className="h-3 w-3" />, cls: "text-destructive" },
  EXECUTED: { label: "Executed", icon: <CheckCircle2 className="h-3 w-3" />, cls: "text-muted-foreground" },
  EXPIRED: { label: "Expired", icon: <XCircle className="h-3 w-3" />, cls: "text-muted-foreground" },
};

export default function ReviewRequestsRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Status | "ALL">("ALL");

  const q = useQuery({
    queryKey: ["review-requests", id, filter],
    queryFn: () => api.listReviewRequests(id!, filter === "ALL" ? undefined : filter),
    enabled: !!id,
  });

  const approve = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      api.approveReviewRequest(id, comment),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review-requests", id] });
      toast.success("Approved");
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });
  const reject = useMutation({
    mutationFn: ({ id, comment }: { id: string; comment?: string }) =>
      api.rejectReviewRequest(id, comment),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review-requests", id] });
      toast.success("Rejected");
    },
    onError: (err) => toast.error(extractErrorMessage(err)),
  });

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Query review requests</div>
        <div className="ml-auto flex items-center gap-1">
          {(["ALL", "PENDING", "APPROVED", "REJECTED", "EXECUTED", "EXPIRED"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={
                "text-xs px-2 py-1 rounded border " +
                (filter === s
                  ? "bg-primary/10 text-primary border-primary/40"
                  : "text-muted-foreground border-border hover:bg-accent")
              }
            >
              {s === "ALL" ? "All" : STATUS_UI[s].label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4">
        {q.isLoading && (
          <div className="text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline" /> Loading...
          </div>
        )}
        {q.data?.length === 0 && (
          <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            No requests match this filter.
          </div>
        )}
        <div className="space-y-2">
          {q.data?.map((r) => (
            <RequestCard
              key={r.id}
              req={r}
              onApprove={(comment) => approve.mutate({ id: r.id, comment })}
              onReject={(comment) => reject.mutate({ id: r.id, comment })}
              pending={approve.isPending || reject.isPending}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RequestCard({
  req,
  onApprove,
  onReject,
  pending,
}: {
  req: {
    id: string;
    sqlText: string;
    classification: string;
    reason: string | null;
    reviewComment: string | null;
    status: Status;
    createdAt: string;
    approvedAt: string | null;
    executedAt: string | null;
    requester: { email: string; displayName: string | null };
    reviewer: { email: string; displayName: string | null } | null;
  };
  onApprove: (comment?: string) => void;
  onReject: (comment?: string) => void;
  pending: boolean;
}) {
  const [comment, setComment] = useState("");
  const ui = STATUS_UI[req.status];
  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className={"inline-flex items-center gap-1 font-medium " + ui.cls}>
          {ui.icon}
          {ui.label}
        </span>
        <span className="text-muted-foreground">
          · {req.classification} · {format(new Date(req.createdAt), "MMM d HH:mm")} · by{" "}
          {req.requester.displayName || req.requester.email}
        </span>
      </div>
      {req.reason && (
        <div className="text-xs">
          <span className="text-muted-foreground">Reason: </span>
          {req.reason}
        </div>
      )}
      <pre className="rounded bg-muted p-2 text-[11px] font-mono overflow-x-auto max-h-32">
        {req.sqlText}
      </pre>
      {req.reviewComment && (
        <div className="text-xs border-l-2 border-border pl-2">
          <span className="text-muted-foreground">
            {req.reviewer ? (req.reviewer.displayName || req.reviewer.email) : "Reviewer"}:
          </span>{" "}
          {req.reviewComment}
        </div>
      )}
      {req.status === "PENDING" && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment"
            className="h-8 text-xs flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => onReject(comment.trim() || undefined)}
            disabled={pending}
            className="text-destructive hover:text-destructive"
          >
            Reject
          </Button>
          <Button
            size="sm"
            onClick={() => onApprove(comment.trim() || undefined)}
            disabled={pending}
          >
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}
