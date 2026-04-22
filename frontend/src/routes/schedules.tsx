import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Database, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  api,
  extractErrorMessage,
  type Connection,
  type CreateScheduleInput,
  type ScheduledQuery,
  type ScheduledQueryRun,
  type ScheduledRunStatus,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { useModal } from "@/components/modal-provider";
import { useAuth } from "@/lib/auth-store";

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every Monday at 9am", value: "0 9 * * 1" },
  { label: "First day of month", value: "0 0 1 * *" },
];

function statusVariant(s: ScheduledRunStatus | null) {
  switch (s) {
    case "SUCCESS":
      return "default" as const;
    case "FAILED":
      return "destructive" as const;
    case "RUNNING":
      return "info" as const;
    case "PENDING":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
}

export default function SchedulesRoute() {
  const qc = useQueryClient();
  const modal = useModal();
  const { user } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled } as Partial<CreateScheduleInput>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.runScheduleNow(id),
    onSuccess: () => {
      toast.success("Queued — refresh to see the run");
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSuccess: () => {
      toast.success("Schedule deleted");
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="min-h-screen gradient-bg">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          DB Studio
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <span className="hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50">
            {user?.email}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold">Scheduled queries</h1>
            <p className="text-sm text-muted-foreground">Run SQL on a cron schedule and get results by email.</p>
          </div>
          <Button onClick={() => setDialogOpen(true)} disabled={!connections.data?.length}>
            <Plus className="h-4 w-4" /> New schedule
          </Button>
        </div>

        {list.isLoading ? (
          <div className="rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : list.data && list.data.length > 0 ? (
          <div className="space-y-3">
            {list.data.map((s) => (
              <ScheduleCard
                key={s.id}
                schedule={s}
                expanded={expandedId === s.id}
                onExpand={() => setExpandedId(expandedId === s.id ? null : s.id)}
                onToggle={(enabled) => toggle.mutate({ id: s.id, enabled })}
                onRunNow={() => runNow.mutate(s.id)}
                onDelete={async () => {
                  const ok = await modal.confirm({
                    title: "Delete schedule",
                    description: `Remove "${s.name}"? Run history will be kept but no more runs will fire.`,
                    confirmLabel: "Delete",
                    destructive: true,
                  });
                  if (ok) remove.mutate(s.id);
                }}
                busy={toggle.isPending || runNow.isPending || remove.isPending}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border p-10 text-center">
            <div className="text-sm font-medium mb-1">No schedules yet</div>
            <div className="text-xs text-muted-foreground mb-4">
              Create one to run a SQL query on a cron and receive the results by email.
            </div>
            <Button onClick={() => setDialogOpen(true)} disabled={!connections.data?.length}>
              <Plus className="h-4 w-4" /> New schedule
            </Button>
          </div>
        )}
      </div>

      <NewScheduleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        connections={connections.data ?? []}
      />
    </div>
  );
}

function ScheduleCard({
  schedule,
  expanded,
  onExpand,
  onToggle,
  onRunNow,
  onDelete,
  busy,
}: {
  schedule: ScheduledQuery;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const recipients = useMemo(
    () => schedule.emailTo.split(",").map((s) => s.trim()).filter(Boolean),
    [schedule.emailTo],
  );

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="p-4 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-medium">{schedule.name}</div>
            {schedule.lastStatus && (
              <Badge variant={statusVariant(schedule.lastStatus)}>{schedule.lastStatus}</Badge>
            )}
            {schedule.connection && (
              <span className="text-xs text-muted-foreground">on {schedule.connection.name}</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4">
            <span className="font-mono">{schedule.cron}</span>
            {schedule.timezone && <span>tz: {schedule.timezone}</span>}
            <span>
              {schedule.lastRunAt
                ? `ran ${formatDistanceToNow(new Date(schedule.lastRunAt), { addSuffix: true })}`
                : "never run"}
            </span>
            <span>{recipients.length} recipient{recipients.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-2 pr-2">
            <Switch checked={schedule.enabled} onCheckedChange={onToggle} disabled={busy} />
            <span className="text-xs text-muted-foreground">{schedule.enabled ? "on" : "off"}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onRunNow} disabled={busy}>
            <Play className="h-4 w-4" /> Run now
          </Button>
          <Button variant="ghost" size="sm" onClick={onExpand}>
            {expanded ? "Hide" : "History"}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onDelete} disabled={busy}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {expanded && <RunHistory scheduleId={schedule.id} />}
    </div>
  );
}

function RunHistory({ scheduleId }: { scheduleId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["schedule-runs", scheduleId],
    queryFn: () => api.listScheduleRuns(scheduleId, 30),
    refetchInterval: 5_000,
  });

  if (isLoading) {
    return (
      <div className="border-t border-border p-4 text-sm text-muted-foreground">Loading runs…</div>
    );
  }
  if (!data || data.length === 0) {
    return (
      <div className="border-t border-border p-4 text-sm text-muted-foreground">
        No runs yet. Click "Run now" to trigger one.
      </div>
    );
  }
  return (
    <div className="border-t border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Started</th>
            <th className="text-left px-3 py-2 font-medium w-24">Status</th>
            <th className="text-right px-3 py-2 font-medium w-20">Rows</th>
            <th className="text-right px-3 py-2 font-medium w-20">Duration</th>
            <th className="text-left px-3 py-2 font-medium w-24">Email</th>
            <th className="text-left px-3 py-2 font-medium">Error</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.map((r: ScheduledQueryRun) => (
            <tr key={r.id}>
              <td className="px-3 py-2 font-mono text-xs">
                {format(new Date(r.startedAt), "MMM d HH:mm:ss")}
              </td>
              <td className="px-3 py-2">
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{r.rowCount ?? "—"}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {r.durationMs != null ? `${r.durationMs}ms` : "—"}
              </td>
              <td className="px-3 py-2 text-xs">
                {r.emailDelivered ? "sent" : r.emailError ? "failed" : "—"}
              </td>
              <td className="px-3 py-2 text-xs text-destructive max-w-sm truncate" title={r.errorMessage ?? r.emailError ?? ""}>
                {r.errorMessage ?? r.emailError ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewScheduleDialog({
  open,
  onOpenChange,
  connections,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connections: Connection[];
}) {
  const qc = useQueryClient();
  const [connectionId, setConnectionId] = useState<string>("");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("");
  const [sqlText, setSqlText] = useState("SELECT 1;");
  const [emailToRaw, setEmailToRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setConnectionId("");
    setName("");
    setCron("0 * * * *");
    setTimezone("");
    setSqlText("SELECT 1;");
    setEmailToRaw("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const emailTo = emailToRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (emailTo.length === 0) {
      toast.error("Add at least one recipient email");
      return;
    }
    setSubmitting(true);
    try {
      await api.createSchedule({
        connectionId,
        name,
        cron,
        timezone: timezone || undefined,
        sqlText,
        emailTo,
        enabled: true,
      });
      toast.success("Schedule created");
      qc.invalidateQueries({ queryKey: ["schedules"] });
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New scheduled query</DialogTitle>
          <DialogDescription>
            Pick a connection, write your SQL, set a cron, and add recipients. Results get emailed as CSV.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label>Connection</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger><SelectValue placeholder="Pick a connection" /></SelectTrigger>
              <SelectContent>
                {connections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily revenue snapshot" />
          </div>
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <div className="space-y-1.5">
              <Label>Cron</Label>
              <Input required value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label>Preset</Label>
              <Select value="" onValueChange={(v) => v && setCron(v)}>
                <SelectTrigger><SelectValue placeholder="Pick…" /></SelectTrigger>
                <SelectContent>
                  {CRON_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Timezone (optional)</Label>
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC, America/New_York…" />
          </div>
          <div className="space-y-1.5">
            <Label>SQL</Label>
            <Textarea
              required
              rows={6}
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Recipients</Label>
            <Input
              required
              value={emailToRaw}
              onChange={(e) => setEmailToRaw(e.target.value)}
              placeholder="you@example.com, team@example.com"
            />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || !connectionId}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
