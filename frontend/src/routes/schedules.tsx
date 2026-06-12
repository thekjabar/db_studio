import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Database, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  api,
  extractErrorMessage,
  type AlertOp,
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
  const [editing, setEditing] = useState<ScheduledQuery | null>(null);
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
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }} disabled={!connections.data?.length}>
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
                onEdit={() => { setEditing(s); setDialogOpen(true); }}
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
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }} disabled={!connections.data?.length}>
              <Plus className="h-4 w-4" /> New schedule
            </Button>
          </div>
        )}
      </div>

      <NewScheduleDialog
        open={dialogOpen}
        onOpenChange={(v) => { setDialogOpen(v); if (!v) setEditing(null); }}
        connections={connections.data ?? []}
        editing={editing}
      />
    </div>
  );
}

function ScheduleCard({
  schedule,
  expanded,
  onExpand,
  onToggle,
  onEdit,
  onRunNow,
  onDelete,
  busy,
}: {
  schedule: ScheduledQuery;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
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
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={busy}>
            <Pencil className="h-4 w-4" /> Edit
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
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connections: Connection[];
  editing?: ScheduledQuery | null;
}) {
  const qc = useQueryClient();
  const [connectionId, setConnectionId] = useState<string>("");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [timezone, setTimezone] = useState("");
  const [schemaName, setSchemaName] = useState<string>("");
  const [sqlText, setSqlText] = useState("SELECT 1;");
  const [emailToRaw, setEmailToRaw] = useState("");
  const [slackWebhook, setSlackWebhook] = useState("");
  const [alertMode, setAlertMode] = useState<"always" | "alert">("always");
  const [alertOp, setAlertOp] = useState<AlertOp>("rows_gt");
  const [alertColumn, setAlertColumn] = useState("");
  const [alertValue, setAlertValue] = useState("0");
  const [alertCooldown, setAlertCooldown] = useState("15");
  const [submitting, setSubmitting] = useState(false);

  // Prefill the form when opening in edit mode; clear it for a fresh create.
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setConnectionId(editing.connectionId);
      setName(editing.name);
      setCron(editing.cron);
      setTimezone(editing.timezone ?? "");
      setSchemaName(editing.schemaName ?? "");
      setSqlText(editing.sqlText);
      setEmailToRaw(editing.emailTo);
      setSlackWebhook(editing.slackWebhook ?? "");
      setAlertMode(editing.alertCondition ? "alert" : "always");
      if (editing.alertCondition) {
        setAlertOp(editing.alertCondition.op);
        setAlertColumn(editing.alertCondition.column ?? "");
        setAlertValue(String(editing.alertCondition.value));
      }
      setAlertCooldown(String(editing.alertCooldownMin ?? 15));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  // Schemas for the chosen connection — lets the user scope unqualified table
  // names (fixes "relation does not exist" when a table lives in a non-default
  // schema). The "__default__" sentinel means "use the connection default".
  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
    enabled: !!connectionId,
  });

  const reset = () => {
    setConnectionId("");
    setName("");
    setCron("0 * * * *");
    setTimezone("");
    setSchemaName("");
    setSqlText("SELECT 1;");
    setEmailToRaw("");
    setSlackWebhook("");
    setAlertMode("always");
    setAlertOp("rows_gt");
    setAlertColumn("");
    setAlertValue("0");
    setAlertCooldown("15");
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
    const alertCondition =
      alertMode === "alert"
        ? {
            op: alertOp,
            value: Number(alertValue) || 0,
            ...(alertOp.startsWith("rows_") ? {} : { column: alertColumn }),
          }
        : null;
    if (alertCondition && !alertCondition.op.startsWith("rows_") && !alertCondition.column) {
      toast.error("Pick a column for the alert condition");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        connectionId,
        name,
        cron,
        timezone: timezone || undefined,
        schemaName: schemaName || null,
        sqlText,
        emailTo,
        slackWebhook: slackWebhook.trim() || undefined,
        alertCondition,
        alertCooldownMin: alertMode === "alert" ? Number(alertCooldown) || null : null,
      };
      if (editing) {
        await api.updateSchedule(editing.id, payload);
        toast.success("Schedule updated");
      } else {
        await api.createSchedule({ ...payload, enabled: true });
        toast.success(alertMode === "alert" ? "Alert created" : "Schedule created");
      }
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
          <DialogTitle>{editing ? "Edit scheduled query" : "New scheduled query"}</DialogTitle>
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
              {/* Derive the selected preset from the current cron so the
                  dropdown reflects the active value. A cron that matches no
                  preset shows "Custom". */}
              <Select
                value={CRON_PRESETS.some((p) => p.value === cron) ? cron : "__custom__"}
                onValueChange={(v) => v !== "__custom__" && setCron(v)}
              >
                <SelectTrigger><SelectValue placeholder="Pick…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__custom__" disabled>Custom</SelectItem>
                  {CRON_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Timezone (optional)</Label>
            <TimezoneSelect value={timezone} onChange={setTimezone} />
          </div>
          <div className="space-y-1.5">
            <Label>Schema (optional)</Label>
            <Select
              value={schemaName || "__default__"}
              onValueChange={(v) => setSchemaName(v === "__default__" ? "" : v)}
              disabled={!connectionId}
            >
              <SelectTrigger>
                <SelectValue placeholder={
                  !connectionId ? "Pick a connection first" :
                  schemasQ.isLoading ? "Loading…" : "Connection default"
                } />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Connection default</SelectItem>
                {(schemasQ.data ?? []).map((s) => (
                  <SelectItem key={s} value={s} className="font-mono">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Scopes unqualified table names. Pick the schema your tables live in if a query says “relation does not exist”.
            </p>
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
            <Label>Email recipients</Label>
            <Input
              required
              value={emailToRaw}
              onChange={(e) => setEmailToRaw(e.target.value)}
              placeholder="you@example.com, team@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Slack webhook (optional)</Label>
            <Input
              value={slackWebhook}
              onChange={(e) => setSlackWebhook(e.target.value)}
              placeholder="https://hooks.slack.com/services/..."
              className="font-mono text-xs"
            />
          </div>

          <div className="rounded border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Label className="m-0">Mode</Label>
              <Select value={alertMode} onValueChange={(v) => setAlertMode(v as typeof alertMode)}>
                <SelectTrigger className="h-8 text-xs w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always notify (classic)</SelectItem>
                  <SelectItem value="alert">Notify only on alert</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {alertMode === "alert" && (
              <>
                <div className="grid grid-cols-[1fr_110px_110px] gap-2 items-end">
                  <div>
                    <Label className="text-[11px]">Column (blank for row-count ops)</Label>
                    <Input
                      value={alertColumn}
                      onChange={(e) => setAlertColumn(e.target.value)}
                      placeholder="e.g. count"
                      className="h-8 text-xs"
                      disabled={alertOp.startsWith("rows_")}
                    />
                  </div>
                  <div>
                    <Label className="text-[11px]">Operator</Label>
                    <Select value={alertOp} onValueChange={(v) => setAlertOp(v as typeof alertOp)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="gt">&gt;</SelectItem>
                        <SelectItem value="gte">&gt;=</SelectItem>
                        <SelectItem value="lt">&lt;</SelectItem>
                        <SelectItem value="lte">&lt;=</SelectItem>
                        <SelectItem value="eq">=</SelectItem>
                        <SelectItem value="neq">!=</SelectItem>
                        <SelectItem value="rows_gt">rows &gt;</SelectItem>
                        <SelectItem value="rows_eq">rows =</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-[11px]">Value</Label>
                    <Input
                      type="number"
                      value={alertValue}
                      onChange={(e) => setAlertValue(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-[11px]">Cooldown (min)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={alertCooldown}
                    onChange={(e) => setAlertCooldown(e.target.value)}
                    className="h-8 text-xs w-32"
                  />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    After firing, wait at least this many minutes before alerting again on the same condition.
                  </p>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || !connectionId}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// IANA timezone list — `Intl.supportedValuesOf('timeZone')` is available in
// every evergreen browser. Falls back to a short curated list for older ones.
function getTimezones(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof sv === "function") return sv("timeZone");
  } catch {
    /* ignore */
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Istanbul",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "Australia/Sydney",
  ];
}

// UTC sentinel for the Select since Radix forbids an empty-string item value.
const TZ_UTC = "__utc__";

function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const zones = useMemo(() => getTimezones(), []);
  const browserZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return "UTC";
    }
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return zones.slice(0, 200);
    return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 300);
  }, [filter, zones]);

  // Built on the standard Select so it portals + traps focus correctly inside
  // the Dialog (the old custom Popover rendered behind the modal).
  return (
    <Select
      value={value || TZ_UTC}
      onValueChange={(v) => onChange(v === TZ_UTC ? "" : v)}
    >
      <SelectTrigger>
        <SelectValue placeholder="Leave unset (UTC)" />
      </SelectTrigger>
      <SelectContent>
        <div className="p-1.5 sticky top-0 bg-popover z-10">
          <Input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search timezones…"
            className="h-8 text-sm"
            // Stop Radix from hijacking typing as type-ahead item search.
            onKeyDown={(e) => e.stopPropagation()}
          />
        </div>
        <SelectItem value={TZ_UTC}>Leave unset (UTC)</SelectItem>
        <SelectItem value={browserZone}>Your browser: {browserZone}</SelectItem>
        {filtered.map((z) => (
          <SelectItem key={z} value={z}>{z}</SelectItem>
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>
        )}
      </SelectContent>
    </Select>
  );
}
