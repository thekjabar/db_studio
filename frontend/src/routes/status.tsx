import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { AlertTriangle, CheckCircle2, Database, Loader2, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const OVERALL_UI: Record<
  "operational" | "degraded" | "outage",
  { label: string; cls: string; icon: React.ReactNode }
> = {
  operational: {
    label: "All systems operational",
    cls: "bg-emerald-500/10 text-emerald-700 border-emerald-500/40 dark:text-emerald-400",
    icon: <CheckCircle2 className="h-5 w-5" />,
  },
  degraded: {
    label: "Degraded performance",
    cls: "bg-amber-500/10 text-amber-700 border-amber-500/40 dark:text-amber-400",
    icon: <AlertTriangle className="h-5 w-5" />,
  },
  outage: {
    label: "Major outage",
    cls: "bg-destructive/10 text-destructive border-destructive/40",
    icon: <XCircle className="h-5 w-5" />,
  },
};

const SEV_CLS: Record<"MINOR" | "MAJOR" | "CRITICAL", string> = {
  MINOR: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  MAJOR: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  CRITICAL: "bg-destructive/10 text-destructive",
};

export default function StatusPage() {
  const q = useQuery({
    queryKey: ["public-status"],
    queryFn: () => api.publicStatus(),
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!q.data) return <div className="p-8 text-destructive">Status unavailable</div>;
  const s = q.data;
  const ui = OVERALL_UI[s.overall];

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 flex items-center px-6 border-b border-border bg-card/50">
        <Database className="h-5 w-5 text-primary mr-2" />
        <span className="font-semibold">DB Studio · Status</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          As of {format(new Date(s.asOf), "MMM d HH:mm:ss")}
        </span>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div className={cn("rounded-md border p-4 flex items-center gap-3", ui.cls)}>
          {ui.icon}
          <div className="font-semibold">{ui.label}</div>
        </div>

        <section>
          <h2 className="text-sm font-semibold mb-2">Components</h2>
          <div className="rounded-md border border-border bg-card divide-y divide-border">
            {s.components.map((c) => (
              <div key={c.name} className="flex items-center gap-3 px-3 py-2 text-sm">
                <StatusDot status={c.status} />
                <span className="flex-1">{c.name}</span>
                {c.detail && <span className="text-[11px] text-muted-foreground">{c.detail}</span>}
              </div>
            ))}
          </div>
        </section>

        {s.activeIncidents.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold mb-2">Active incidents</h2>
            <div className="space-y-3">
              {s.activeIncidents.map((i) => (
                <div key={i.id} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "text-[10px] font-medium rounded px-2 py-0.5",
                        SEV_CLS[i.severity],
                      )}
                    >
                      {i.severity}
                    </span>
                    <span className="font-semibold">{i.title}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      Started {format(new Date(i.startedAt), "MMM d HH:mm")}
                    </span>
                  </div>
                  <div className="mt-2 space-y-1 text-xs">
                    {i.updates
                      .slice()
                      .reverse()
                      .map((u, idx) => (
                        <div key={idx} className="flex gap-2">
                          <span className="text-muted-foreground w-28 shrink-0 font-mono">
                            {format(new Date(u.at), "MMM d HH:mm")}
                          </span>
                          <span className="font-medium uppercase tracking-wider text-[10px] text-primary w-28 shrink-0">
                            {u.status}
                          </span>
                          <span className="flex-1">{u.message}</span>
                        </div>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-sm font-semibold mb-2">Recent incidents</h2>
          {s.recentIncidents.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              No recent incidents.
            </div>
          ) : (
            <div className="rounded-md border border-border bg-card divide-y divide-border">
              {s.recentIncidents.map((i) => (
                <div key={i.id} className="px-3 py-2 text-sm flex items-center gap-3">
                  <span
                    className={cn(
                      "text-[10px] font-medium rounded px-2 py-0.5",
                      SEV_CLS[i.severity],
                    )}
                  >
                    {i.severity}
                  </span>
                  <span className="flex-1">{i.title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {format(new Date(i.startedAt), "MMM d")} →{" "}
                    {format(new Date(i.resolvedAt), "MMM d")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "ok" | "degraded" | "down" }) {
  const cls =
    status === "ok"
      ? "bg-emerald-500"
      : status === "degraded"
        ? "bg-amber-500"
        : "bg-destructive";
  return <span className={cn("h-2.5 w-2.5 rounded-full", cls)} />;
}
