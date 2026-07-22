import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, X, AlertTriangle, Info, AlertOctagon } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Announcement = Awaited<ReturnType<typeof api.activeAnnouncements>>[number];

/**
 * Shared hook — both `AnnouncementBanner` (top-of-viewport strip) and
 * `AnnouncementBell` (dropdown button for the topbar) read from the same
 * 60-second polling query, so only one HTTP call fires per minute.
 */
function useAnnouncements() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["announcements-active"],
    queryFn: () => api.activeAnnouncements(),
    refetchInterval: 60_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismissAnnouncement(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-active"] }),
  });
  const markSeen = useMutation({
    mutationFn: (id: string) => api.markAnnouncementSeen(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["announcements-active"] }),
  });
  return { list: q.data ?? [], dismiss, markSeen };
}

export function AnnouncementBanner() {
  const { list, dismiss } = useAnnouncements();
  const banner = useMemo(() => {
    const undismissed = list.filter((a) => !a.dismissedAt);
    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    return undismissed.sort((a, b) => order[a.severity] - order[b.severity])[0] ?? null;
  }, [list]);
  if (!banner) return null;
  return <Banner a={banner} onDismiss={() => dismiss.mutate(banner.id)} />;
}

export function AnnouncementBell() {
  const { list, markSeen } = useAnnouncements();
  const unread = list.filter((a) => !a.seen).length;
  return (
    <Bellbox
      items={list}
      unread={unread}
      onOpen={() => {
        for (const a of list) {
          if (!a.seen) markSeen.mutate(a.id);
        }
      }}
    />
  );
}

function Banner({ a, onDismiss }: { a: Announcement; onDismiss: () => void }) {
  const Icon = a.severity === "CRITICAL" ? AlertOctagon : a.severity === "WARNING" ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        "w-full px-4 py-2 flex items-center gap-3 text-sm",
        a.severity === "CRITICAL" && "bg-destructive text-destructive-foreground",
        a.severity === "WARNING" && "bg-amber-500/15 text-amber-400 border-b border-amber-500/30",
        a.severity === "INFO" && "bg-primary/15 text-primary border-b border-primary/30",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-semibold">{a.title}</span>
        <span className="mx-2 opacity-60">·</span>
        <span className="opacity-90">{a.body}</span>
      </div>
      <button
        onClick={onDismiss}
        className="opacity-70 hover:opacity-100 shrink-0"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function Bellbox({
  items,
  unread,
  onOpen,
}: {
  items: Announcement[];
  unread: number;
  onOpen: () => void;
}) {
  return (
    <DropdownMenu onOpenChange={(o) => o && onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" title="Announcements" className="relative">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-destructive" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="p-3 border-b border-border">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Announcements</div>
        </div>
        <div className="max-h-96 overflow-auto">
          {items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">Nothing new.</div>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((a) => (
                <li key={a.id} className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{a.title}</span>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide",
                        a.severity === "CRITICAL" && "bg-destructive/15 text-destructive",
                        a.severity === "WARNING" && "bg-amber-500/15 text-amber-500",
                        a.severity === "INFO" && "bg-primary/15 text-primary",
                      )}
                    >
                      {a.severity}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                    {a.body}
                  </p>
                  <div className="text-[10px] text-muted-foreground mt-1">
                    {new Date(a.startsAt).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
