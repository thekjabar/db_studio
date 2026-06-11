import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Database, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage, } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Check, ChevronDown } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { useModal } from "@/components/modal-provider";
import { useAuth } from "@/lib/auth-store";
const CRON_PRESETS = [
    { label: "Every 5 minutes", value: "*/5 * * * *" },
    { label: "Every hour", value: "0 * * * *" },
    { label: "Every day at 8am", value: "0 8 * * *" },
    { label: "Every Monday at 9am", value: "0 9 * * 1" },
    { label: "First day of month", value: "0 0 1 * *" },
];
function statusVariant(s) {
    switch (s) {
        case "SUCCESS":
            return "default";
        case "FAILED":
            return "destructive";
        case "RUNNING":
            return "info";
        case "PENDING":
            return "secondary";
        default:
            return "secondary";
    }
}
export default function SchedulesRoute() {
    const qc = useQueryClient();
    const modal = useModal();
    const { user } = useAuth();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const list = useQuery({ queryKey: ["schedules"], queryFn: api.listSchedules });
    const connections = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });
    const toggle = useMutation({
        mutationFn: ({ id, enabled }) => api.updateSchedule(id, { enabled }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["schedules"] }),
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const runNow = useMutation({
        mutationFn: (id) => api.runScheduleNow(id),
        onSuccess: () => {
            toast.success("Queued — refresh to see the run");
            qc.invalidateQueries({ queryKey: ["schedules"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const remove = useMutation({
        mutationFn: (id) => api.deleteSchedule(id),
        onSuccess: () => {
            toast.success("Schedule deleted");
            qc.invalidateQueries({ queryKey: ["schedules"] });
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "min-h-screen gradient-bg", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm", children: [_jsxs(Link, { to: "/connections", className: "flex items-center gap-2 font-semibold", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), "DB Studio"] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Link, { to: "/connections", className: "text-sm text-muted-foreground hover:text-foreground", children: "Connections" }), _jsx("span", { className: "hidden sm:inline text-sm text-muted-foreground mr-2 truncate max-w-50", children: user?.email }), _jsx(ThemeToggle, {})] })] }), _jsxs("div", { className: "max-w-6xl mx-auto px-6 py-10", children: [_jsxs("div", { className: "flex items-center justify-between mb-6", children: [_jsxs("div", { children: [_jsx("h1", { className: "text-2xl font-semibold", children: "Scheduled queries" }), _jsx("p", { className: "text-sm text-muted-foreground", children: "Run SQL on a cron schedule and get results by email." })] }), _jsxs(Button, { onClick: () => setDialogOpen(true), disabled: !connections.data?.length, children: [_jsx(Plus, { className: "h-4 w-4" }), " New schedule"] })] }), list.isLoading ? (_jsxs("div", { className: "rounded-md border border-border p-8 text-sm text-muted-foreground flex items-center justify-center gap-2", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading\u2026"] })) : list.data && list.data.length > 0 ? (_jsx("div", { className: "space-y-3", children: list.data.map((s) => (_jsx(ScheduleCard, { schedule: s, expanded: expandedId === s.id, onExpand: () => setExpandedId(expandedId === s.id ? null : s.id), onToggle: (enabled) => toggle.mutate({ id: s.id, enabled }), onRunNow: () => runNow.mutate(s.id), onDelete: async () => {
                                const ok = await modal.confirm({
                                    title: "Delete schedule",
                                    description: `Remove "${s.name}"? Run history will be kept but no more runs will fire.`,
                                    confirmLabel: "Delete",
                                    destructive: true,
                                });
                                if (ok)
                                    remove.mutate(s.id);
                            }, busy: toggle.isPending || runNow.isPending || remove.isPending }, s.id))) })) : (_jsxs("div", { className: "rounded-md border border-dashed border-border p-10 text-center", children: [_jsx("div", { className: "text-sm font-medium mb-1", children: "No schedules yet" }), _jsx("div", { className: "text-xs text-muted-foreground mb-4", children: "Create one to run a SQL query on a cron and receive the results by email." }), _jsxs(Button, { onClick: () => setDialogOpen(true), disabled: !connections.data?.length, children: [_jsx(Plus, { className: "h-4 w-4" }), " New schedule"] })] }))] }), _jsx(NewScheduleDialog, { open: dialogOpen, onOpenChange: setDialogOpen, connections: connections.data ?? [] })] }));
}
function ScheduleCard({ schedule, expanded, onExpand, onToggle, onRunNow, onDelete, busy, }) {
    const recipients = useMemo(() => schedule.emailTo.split(",").map((s) => s.trim()).filter(Boolean), [schedule.emailTo]);
    return (_jsxs("div", { className: "rounded-md border border-border bg-card", children: [_jsxs("div", { className: "p-4 flex items-start gap-4", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("div", { className: "font-medium", children: schedule.name }), schedule.lastStatus && (_jsx(Badge, { variant: statusVariant(schedule.lastStatus), children: schedule.lastStatus })), schedule.connection && (_jsxs("span", { className: "text-xs text-muted-foreground", children: ["on ", schedule.connection.name] }))] }), _jsxs("div", { className: "text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-4", children: [_jsx("span", { className: "font-mono", children: schedule.cron }), schedule.timezone && _jsxs("span", { children: ["tz: ", schedule.timezone] }), _jsx("span", { children: schedule.lastRunAt
                                            ? `ran ${formatDistanceToNow(new Date(schedule.lastRunAt), { addSuffix: true })}`
                                            : "never run" }), _jsxs("span", { children: [recipients.length, " recipient", recipients.length === 1 ? "" : "s"] })] })] }), _jsxs("div", { className: "flex items-center gap-1", children: [_jsxs("div", { className: "flex items-center gap-2 pr-2", children: [_jsx(Switch, { checked: schedule.enabled, onCheckedChange: onToggle, disabled: busy }), _jsx("span", { className: "text-xs text-muted-foreground", children: schedule.enabled ? "on" : "off" })] }), _jsxs(Button, { variant: "ghost", size: "sm", onClick: onRunNow, disabled: busy, children: [_jsx(Play, { className: "h-4 w-4" }), " Run now"] }), _jsx(Button, { variant: "ghost", size: "sm", onClick: onExpand, children: expanded ? "Hide" : "History" }), _jsx(Button, { variant: "ghost", size: "icon", className: "h-8 w-8 text-destructive", onClick: onDelete, disabled: busy, children: _jsx(Trash2, { className: "h-4 w-4" }) })] })] }), expanded && _jsx(RunHistory, { scheduleId: schedule.id })] }));
}
function RunHistory({ scheduleId }) {
    const { data, isLoading } = useQuery({
        queryKey: ["schedule-runs", scheduleId],
        queryFn: () => api.listScheduleRuns(scheduleId, 30),
        refetchInterval: 5_000,
    });
    if (isLoading) {
        return (_jsx("div", { className: "border-t border-border p-4 text-sm text-muted-foreground", children: "Loading runs\u2026" }));
    }
    if (!data || data.length === 0) {
        return (_jsx("div", { className: "border-t border-border p-4 text-sm text-muted-foreground", children: "No runs yet. Click \"Run now\" to trigger one." }));
    }
    return (_jsx("div", { className: "border-t border-border", children: _jsxs("table", { className: "w-full text-sm", children: [_jsx("thead", { className: "bg-muted/40 text-xs uppercase text-muted-foreground", children: _jsxs("tr", { children: [_jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Started" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-24", children: "Status" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-20", children: "Rows" }), _jsx("th", { className: "text-right px-3 py-2 font-medium w-20", children: "Duration" }), _jsx("th", { className: "text-left px-3 py-2 font-medium w-24", children: "Email" }), _jsx("th", { className: "text-left px-3 py-2 font-medium", children: "Error" })] }) }), _jsx("tbody", { className: "divide-y divide-border", children: data.map((r) => (_jsxs("tr", { children: [_jsx("td", { className: "px-3 py-2 font-mono text-xs", children: format(new Date(r.startedAt), "MMM d HH:mm:ss") }), _jsx("td", { className: "px-3 py-2", children: _jsx(Badge, { variant: statusVariant(r.status), children: r.status }) }), _jsx("td", { className: "px-3 py-2 text-right font-mono text-xs", children: r.rowCount ?? "—" }), _jsx("td", { className: "px-3 py-2 text-right font-mono text-xs", children: r.durationMs != null ? `${r.durationMs}ms` : "—" }), _jsx("td", { className: "px-3 py-2 text-xs", children: r.emailDelivered ? "sent" : r.emailError ? "failed" : "—" }), _jsx("td", { className: "px-3 py-2 text-xs text-destructive max-w-sm truncate", title: r.errorMessage ?? r.emailError ?? "", children: r.errorMessage ?? r.emailError ?? "" })] }, r.id))) })] }) }));
}
function NewScheduleDialog({ open, onOpenChange, connections, }) {
    const qc = useQueryClient();
    const [connectionId, setConnectionId] = useState("");
    const [name, setName] = useState("");
    const [cron, setCron] = useState("0 * * * *");
    const [timezone, setTimezone] = useState("");
    const [sqlText, setSqlText] = useState("SELECT 1;");
    const [emailToRaw, setEmailToRaw] = useState("");
    const [slackWebhook, setSlackWebhook] = useState("");
    const [alertMode, setAlertMode] = useState("always");
    const [alertOp, setAlertOp] = useState("rows_gt");
    const [alertColumn, setAlertColumn] = useState("");
    const [alertValue, setAlertValue] = useState("0");
    const [alertCooldown, setAlertCooldown] = useState("15");
    const [submitting, setSubmitting] = useState(false);
    const reset = () => {
        setConnectionId("");
        setName("");
        setCron("0 * * * *");
        setTimezone("");
        setSqlText("SELECT 1;");
        setEmailToRaw("");
        setSlackWebhook("");
        setAlertMode("always");
        setAlertOp("rows_gt");
        setAlertColumn("");
        setAlertValue("0");
        setAlertCooldown("15");
    };
    const submit = async (e) => {
        e.preventDefault();
        const emailTo = emailToRaw
            .split(/[\s,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (emailTo.length === 0) {
            toast.error("Add at least one recipient email");
            return;
        }
        const alertCondition = alertMode === "alert"
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
            await api.createSchedule({
                connectionId,
                name,
                cron,
                timezone: timezone || undefined,
                sqlText,
                emailTo,
                slackWebhook: slackWebhook.trim() || undefined,
                alertCondition,
                alertCooldownMin: alertMode === "alert" ? Number(alertCooldown) || null : null,
                enabled: true,
            });
            toast.success(alertMode === "alert" ? "Alert created" : "Schedule created");
            qc.invalidateQueries({ queryKey: ["schedules"] });
            reset();
            onOpenChange(false);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setSubmitting(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "New scheduled query" }), _jsx(DialogDescription, { children: "Pick a connection, write your SQL, set a cron, and add recipients. Results get emailed as CSV." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Connection" }), _jsxs(Select, { value: connectionId, onValueChange: setConnectionId, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick a connection" }) }), _jsx(SelectContent, { children: connections.map((c) => (_jsx(SelectItem, { value: c.id, children: c.name }, c.id))) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { required: true, value: name, onChange: (e) => setName(e.target.value), placeholder: "Daily revenue snapshot" })] }), _jsxs("div", { className: "grid grid-cols-[1fr_160px] gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Cron" }), _jsx(Input, { required: true, value: cron, onChange: (e) => setCron(e.target.value), className: "font-mono" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Preset" }), _jsxs(Select, { value: "", onValueChange: (v) => v && setCron(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick\u2026" }) }), _jsx(SelectContent, { children: CRON_PRESETS.map((p) => (_jsx(SelectItem, { value: p.value, children: p.label }, p.value))) })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Timezone (optional)" }), _jsx(TimezoneSelect, { value: timezone, onChange: setTimezone })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SQL" }), _jsx(Textarea, { required: true, rows: 6, value: sqlText, onChange: (e) => setSqlText(e.target.value), className: "font-mono text-xs" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email recipients" }), _jsx(Input, { required: true, value: emailToRaw, onChange: (e) => setEmailToRaw(e.target.value), placeholder: "you@example.com, team@example.com" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Slack webhook (optional)" }), _jsx(Input, { value: slackWebhook, onChange: (e) => setSlackWebhook(e.target.value), placeholder: "https://hooks.slack.com/services/...", className: "font-mono text-xs" })] }), _jsxs("div", { className: "rounded border border-border bg-muted/30 p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Label, { className: "m-0", children: "Mode" }), _jsxs(Select, { value: alertMode, onValueChange: (v) => setAlertMode(v), children: [_jsx(SelectTrigger, { className: "h-8 text-xs w-48", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "always", children: "Always notify (classic)" }), _jsx(SelectItem, { value: "alert", children: "Notify only on alert" })] })] })] }), alertMode === "alert" && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-[1fr_110px_110px] gap-2 items-end", children: [_jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Column (blank for row-count ops)" }), _jsx(Input, { value: alertColumn, onChange: (e) => setAlertColumn(e.target.value), placeholder: "e.g. count", className: "h-8 text-xs", disabled: alertOp.startsWith("rows_") })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Operator" }), _jsxs(Select, { value: alertOp, onValueChange: (v) => setAlertOp(v), children: [_jsx(SelectTrigger, { className: "h-8 text-xs", children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "gt", children: ">" }), _jsx(SelectItem, { value: "gte", children: ">=" }), _jsx(SelectItem, { value: "lt", children: "<" }), _jsx(SelectItem, { value: "lte", children: "<=" }), _jsx(SelectItem, { value: "eq", children: "=" }), _jsx(SelectItem, { value: "neq", children: "!=" }), _jsx(SelectItem, { value: "rows_gt", children: "rows >" }), _jsx(SelectItem, { value: "rows_eq", children: "rows =" })] })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Value" }), _jsx(Input, { type: "number", value: alertValue, onChange: (e) => setAlertValue(e.target.value), className: "h-8 text-xs" })] })] }), _jsxs("div", { children: [_jsx(Label, { className: "text-[11px]", children: "Cooldown (min)" }), _jsx(Input, { type: "number", min: 1, max: 1440, value: alertCooldown, onChange: (e) => setAlertCooldown(e.target.value), className: "h-8 text-xs w-32" }), _jsx("p", { className: "text-[10px] text-muted-foreground mt-1", children: "After firing, wait at least this many minutes before alerting again on the same condition." })] })] }))] }), _jsxs(DialogFooter, { className: "pt-2", children: [_jsx(Button, { type: "button", variant: "ghost", onClick: () => onOpenChange(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: submitting || !connectionId, children: [submitting && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Create"] })] })] })] }) }));
}
// IANA timezone list — `Intl.supportedValuesOf('timeZone')` is available in
// every evergreen browser. Falls back to a short curated list for older ones.
function getTimezones() {
    try {
        const sv = Intl.supportedValuesOf;
        if (typeof sv === "function")
            return sv("timeZone");
    }
    catch {
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
function TimezoneSelect({ value, onChange, }) {
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const anchorRef = useRef(null);
    const zones = useMemo(() => getTimezones(), []);
    const browserZone = useMemo(() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone;
        }
        catch {
            return "UTC";
        }
    }, []);
    const filtered = useMemo(() => {
        const q = filter.trim().toLowerCase();
        if (!q)
            return zones.slice(0, 100);
        return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 200);
    }, [filter, zones]);
    const display = value || "Leave unset (UTC)";
    return (_jsxs(_Fragment, { children: [_jsxs("button", { ref: anchorRef, type: "button", onClick: () => setOpen((v) => !v), className: "flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", children: [_jsx("span", { className: value ? "" : "text-muted-foreground", children: display }), _jsx(ChevronDown, { className: "h-4 w-4 opacity-60" })] }), _jsxs(Popover, { open: open, onOpenChange: setOpen, anchorRef: anchorRef, align: "start", className: "w-72 p-0", children: [_jsx("div", { className: "p-2 border-b border-border", children: _jsx("input", { autoFocus: true, value: filter, onChange: (e) => setFilter(e.target.value), placeholder: "Search timezones\u2026", className: "h-8 w-full rounded border border-input bg-transparent px-2 text-sm focus-visible:outline-none" }) }), _jsxs("div", { className: "max-h-60 overflow-y-auto py-1", children: [value && (_jsx("button", { type: "button", onClick: () => {
                                    onChange("");
                                    setOpen(false);
                                    setFilter("");
                                }, className: "flex w-full items-center justify-between px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent", children: "Clear (use UTC)" })), _jsxs("button", { type: "button", onClick: () => {
                                    onChange(browserZone);
                                    setOpen(false);
                                    setFilter("");
                                }, className: "flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-accent", children: [_jsxs("span", { children: ["Your browser: ", browserZone] }), value === browserZone && _jsx(Check, { className: "h-3.5 w-3.5" })] }), _jsx("div", { className: "my-1 border-t border-border" }), filtered.map((z) => (_jsxs("button", { type: "button", onClick: () => {
                                    onChange(z);
                                    setOpen(false);
                                    setFilter("");
                                }, className: "flex w-full items-center justify-between px-3 py-1.5 text-sm hover:bg-accent", children: [_jsx("span", { children: z }), value === z && _jsx(Check, { className: "h-3.5 w-3.5" })] }, z))), filtered.length === 0 && (_jsx("div", { className: "px-3 py-2 text-xs text-muted-foreground", children: "No matches" }))] })] })] }));
}
