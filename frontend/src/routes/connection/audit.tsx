import { useState, useMemo, Fragment } from "react";
import { useParams } from "react-router-dom";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, Undo2 } from "lucide-react";
import { api, extractErrorMessage, type AuditAction, type AuditEntry } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";

const ACTION_COLORS: Record<AuditAction, "default" | "info" | "warning" | "destructive" | "secondary"> = {
  LOGIN: "info",
  LOGIN_FAILED: "destructive",
  LOGOUT: "secondary",
  SIGNUP: "info",
  TOTP_ENABLED: "default",
  TOTP_DISABLED: "warning",
  CONNECTION_CREATED: "default",
  CONNECTION_UPDATED: "warning",
  CONNECTION_DELETED: "destructive",
  CONNECTION_TESTED: "secondary",
  QUERY_RUN: "info",
  ROW_INSERT: "default",
  ROW_UPDATE: "warning",
  ROW_DELETE: "destructive",
  SCHEMA_CHANGE: "warning",
  MEMBER_ADDED: "default",
  MEMBER_REMOVED: "destructive",
};

const PAGE_SIZE = 100;
// Actions whose audit entries can be reverted via the UI.
const REVERTABLE_ACTIONS = new Set<AuditAction>(["ROW_INSERT", "ROW_UPDATE", "ROW_DELETE"]);

export default function AuditRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const modal = useModal();
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: ["audit", id],
    queryFn: ({ pageParam }) =>
      api.listAudit(id!, { limit: PAGE_SIZE, cursor: pageParam as string | undefined }),
    getNextPageParam: (last) => last.nextCursor,
    initialPageParam: undefined as string | undefined,
    enabled: !!id,
  });

  const items = useMemo<AuditEntry[]>(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

  const filtered = useMemo(() => {
    if (!filter) return items;
    const f = filter.toLowerCase();
    return items.filter(
      (i) =>
        i.action?.toLowerCase().includes(f) ||
        i.user?.toLowerCase().includes(f) ||
        i.sqlText?.toLowerCase().includes(f),
    );
  }, [items, filter]);

  const revert = useMutation({
    mutationFn: (entryId: string) => api.auditRevert(id!, entryId),
    onSuccess: (r) => {
      toast.success(`Reverted ${r.affected} row${r.affected === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["audit", id] });
      // The data the user is browsing may have changed.
      qc.invalidateQueries({ queryKey: ["data"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const onRevertClick = async (e: AuditEntry) => {
    try {
      const preview = await api.auditRevertPreview(id!, e.id);
      const ok = await modal.confirm({
        title: "Revert this change?",
        description: preview.description,
        confirmLabel: "Revert",
        destructive: true,
      });
      if (ok) revert.mutate(e.id);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  const describe = (e: AuditEntry): string => {
    if (e.sqlText) return e.sqlText;
    const m = e.metadata as { table?: string; bulk?: number } | null | undefined;
    if (m?.table) {
      return m.bulk ? `${m.table} (${m.bulk} rows)` : m.table;
    }
    if (e.metadata && typeof e.metadata === "object") return JSON.stringify(e.metadata);
    return "";
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Input
          placeholder="Filter by action, user, or SQL..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-8 text-xs font-mono max-w-md"
        />
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {filter ? `of ${items.length}` : ""} entries
          {q.hasNextPage && !filter ? "+" : ""}
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        {q.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading audit log...</div>}
        {q.error && <div className="p-6 text-sm text-destructive">{extractErrorMessage(q.error)}</div>}
        {!q.isLoading && filtered.length === 0 && (
          <div className="p-12 text-center text-sm text-muted-foreground">No audit entries</div>
        )}
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border">
              <th className="w-8" />
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">When</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Action</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">User</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground">Rows</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">Table / Details</th>
              <th className="w-24" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => {
              const isExpanded = expanded === e.id;
              const hasDetails = hasRevertDetails(e);
              return (
                <Fragment key={e.id}>
                  <tr
                    className={cn(
                      "border-b border-border hover:bg-accent/30 cursor-pointer",
                      isExpanded && "bg-accent/30",
                    )}
                    onClick={() => hasDetails && setExpanded(isExpanded ? null : e.id)}
                  >
                    <td className="pl-4 pr-1 py-2 text-muted-foreground">
                      {hasDetails ? (
                        isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                      {e.createdAt ? format(new Date(e.createdAt), "yyyy-MM-dd HH:mm:ss") : ""}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={ACTION_COLORS[e.action] ?? "secondary"}>{e.action}</Badge>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{e.user || e.userId || "—"}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                      {e.affectedRows ?? ""}
                    </td>
                    <td className="px-4 py-2 max-w-[600px] truncate" title={describe(e)}>
                      {describe(e)}
                    </td>
                    <td className="px-4 py-2">
                      {hasDetails && REVERTABLE_ACTIONS.has(e.action) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          disabled={revert.isPending && revert.variables === e.id}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onRevertClick(e);
                          }}
                        >
                          {revert.isPending && revert.variables === e.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Undo2 className="h-3 w-3" />
                          )}
                          Revert
                        </Button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-muted/30 border-b border-border">
                      <td />
                      <td colSpan={6} className="px-4 py-3">
                        <DiffView entry={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {q.hasNextPage && (
          <div className="p-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface RowAuditMeta {
  table?: string;
  schema?: string;
  tableName?: string;
  pk?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  beforeRows?: Record<string, unknown>[];
  afterValues?: Record<string, unknown>;
  bulk?: number;
  revertedFrom?: string;
}

function getMeta(e: AuditEntry): RowAuditMeta {
  return (e.metadata ?? {}) as RowAuditMeta;
}

function hasRevertDetails(e: AuditEntry): boolean {
  const m = getMeta(e);
  return !!(m.before || m.after || m.beforeRows?.length);
}

function DiffView({ entry }: { entry: AuditEntry }) {
  const m = getMeta(entry);

  if (m.bulk && m.beforeRows?.length) {
    return (
      <div className="space-y-2">
        <div className="text-[11px] text-muted-foreground">
          {entry.action} of {m.bulk} rows
          {m.afterValues && (
            <>
              {" "}→ set{" "}
              <span className="text-foreground font-mono">{JSON.stringify(m.afterValues)}</span>
            </>
          )}
        </div>
        <div className="rounded border border-border bg-card overflow-auto max-h-64">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                {Object.keys(m.beforeRows[0]).map((k) => (
                  <th key={k} className="text-left px-2 py-1 font-medium">{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.beforeRows.slice(0, 50).map((r, i) => (
                <tr key={i} className="border-t border-border">
                  {Object.values(r).map((v, j) => (
                    <td key={j} className="px-2 py-1 whitespace-nowrap">
                      {v === null || v === undefined ? (
                        <span className="text-muted-foreground italic">NULL</span>
                      ) : typeof v === "object" ? (
                        JSON.stringify(v)
                      ) : (
                        String(v)
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {m.beforeRows.length > 50 && (
            <div className="p-2 text-[10px] text-muted-foreground text-center">
              showing 50 of {m.beforeRows.length}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Single-row diff
  const before = m.before ?? null;
  const after = m.after ?? null;
  const allKeys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])).sort();

  if (!allKeys.length) {
    return <div className="text-[11px] text-muted-foreground italic">No row snapshot available.</div>;
  }

  return (
    <div className="rounded border border-border bg-card overflow-auto">
      <table className="w-full text-[11px] font-mono">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-1.5 font-medium w-40">Column</th>
            <th className="text-left px-3 py-1.5 font-medium">Before</th>
            <th className="text-left px-3 py-1.5 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {allKeys.map((k) => {
            const bv = before?.[k];
            const av = after?.[k];
            const changed = JSON.stringify(bv) !== JSON.stringify(av);
            return (
              <tr
                key={k}
                className={cn(
                  "border-t border-border",
                  changed && "bg-amber-500/10",
                )}
              >
                <td className="px-3 py-1.5 text-muted-foreground">{k}</td>
                <td className={cn("px-3 py-1.5", changed && "text-rose-700 dark:text-rose-400")}>
                  <RenderValue v={bv} />
                </td>
                <td className={cn("px-3 py-1.5", changed && "text-emerald-700 dark:text-emerald-400")}>
                  <RenderValue v={av} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RenderValue({ v }: { v: unknown }) {
  if (v === null || v === undefined) {
    return <span className="text-muted-foreground italic">NULL</span>;
  }
  if (typeof v === "object") {
    return <span>{JSON.stringify(v)}</span>;
  }
  return <span>{String(v)}</span>;
}
