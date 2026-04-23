import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Play, Loader2 } from "lucide-react";
import { api, extractErrorMessage, type AuditEntry } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

type Window = "24h" | "7d" | "30d" | "all";
const WINDOW_MS: Record<Window, number | undefined> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  all: undefined,
};

type ActionFilter = "all" | "QUERY_RUN" | "SCHEMA_CHANGE";

export default function QueryHistoryRoute() {
  const { id } = useParams<{ id: string }>();
  const [search, setSearch] = useState("");
  const [window, setWindow] = useState<Window>("7d");
  const [actionFilter, setActionFilter] = useState<ActionFilter>("all");

  const params = {
    limit: PAGE_SIZE,
    sinceMs: WINDOW_MS[window],
    search: search.trim() || undefined,
    action: actionFilter === "all" ? undefined : actionFilter,
  } as const;

  const q = useInfiniteQuery({
    queryKey: ["query-history", id, window, actionFilter, search.trim()],
    queryFn: ({ pageParam }) =>
      api.listQueryHistory(id!, { ...params, cursor: pageParam as string | undefined }),
    getNextPageParam: (last) => last.nextCursor,
    initialPageParam: undefined as string | undefined,
    enabled: !!id,
  });

  const items = useMemo<AuditEntry[]>(
    () => q.data?.pages.flatMap((p) => p.items) ?? [],
    [q.data],
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 flex-wrap">
        <Input
          placeholder="Search SQL text..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-xs font-mono max-w-xs"
        />
        <Select value={window} onValueChange={(v) => setWindow(v as Window)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24h">Last 24 h</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={(v) => setActionFilter(v as ActionFilter)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Reads + Writes</SelectItem>
            <SelectItem value="QUERY_RUN">Queries only</SelectItem>
            <SelectItem value="SCHEMA_CHANGE">Schema changes</SelectItem>
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-muted-foreground">
          {items.length} entr{items.length === 1 ? "y" : "ies"}
          {q.hasNextPage ? "+" : ""}
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        {q.isLoading && (
          <div className="p-6 text-sm text-muted-foreground">Loading history...</div>
        )}
        {q.error && (
          <div className="p-6 text-sm text-destructive">{extractErrorMessage(q.error)}</div>
        )}
        {!q.isLoading && items.length === 0 && (
          <div className="p-12 text-center text-sm text-muted-foreground">
            No queries in this window. Try widening the filter above.
          </div>
        )}

        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border">
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-40">When</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Kind</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground w-40">User</th>
              <th className="text-left px-4 py-2 font-medium text-muted-foreground">SQL</th>
              <th className="text-right px-4 py-2 font-medium text-muted-foreground w-20">Rows</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-b border-border align-top hover:bg-accent/30">
                <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                  {format(new Date(e.createdAt), "MMM d, HH:mm:ss")}
                </td>
                <td className="px-4 py-2">
                  <Badge
                    variant={e.action === "SCHEMA_CHANGE" ? "warning" : "info"}
                    className="text-[10px]"
                  >
                    {e.action === "SCHEMA_CHANGE" ? "Schema" : "Query"}
                  </Badge>
                </td>
                <td className="px-4 py-2 text-foreground">{e.user ?? "—"}</td>
                <td className="px-4 py-2">
                  <code className={cn("block max-h-16 overflow-hidden text-ellipsis whitespace-pre-wrap text-[11px]")}>
                    {e.sqlText ?? "(no SQL captured)"}
                  </code>
                </td>
                <td className="px-4 py-2 text-right text-muted-foreground">
                  {e.affectedRows ?? "—"}
                </td>
                <td className="px-2 py-2">
                  {e.sqlText && (
                    <Link
                      to={`/c/${id}/sql?sql=${encodeURIComponent(e.sqlText)}`}
                      className="inline-flex items-center gap-1 text-primary hover:underline text-[11px]"
                      title="Open in SQL editor"
                    >
                      <Play className="h-3 w-3" /> Open
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {q.hasNextPage && (
          <div className="p-3 flex justify-center">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
