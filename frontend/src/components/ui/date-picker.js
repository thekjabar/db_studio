import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import * as React from "react";
import { format, parse } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
export function DatePicker({ value, onChange, disabled, placeholder = "Pick a date", className }) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef(null);
    const parsed = value ? parse(value, "yyyy-MM-dd", new Date()) : null;
    return (_jsxs(_Fragment, { children: [_jsxs("button", { ref: anchorRef, type: "button", disabled: disabled, onClick: () => setOpen(true), className: cn("flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm", "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className), children: [_jsx("span", { className: value ? "" : "text-muted-foreground", children: value ? format(parsed, "MMM d, yyyy") : placeholder }), _jsx(CalendarIcon, { className: "h-4 w-4 text-muted-foreground" })] }), _jsx(Popover, { open: open, onOpenChange: setOpen, anchorRef: anchorRef, align: "start", className: "w-auto p-0", children: _jsx(Calendar, { value: parsed, onChange: (d) => {
                        onChange(format(d, "yyyy-MM-dd"));
                        setOpen(false);
                    } }) })] }));
}
export function DateTimePicker({ value, onChange, disabled, placeholder = "Pick date & time", className }) {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef(null);
    // Split value into date / time portions.
    const [datePart, timePart] = React.useMemo(() => {
        if (!value)
            return ["", "00:00"];
        const [d, t = "00:00"] = value.split("T");
        return [d, t.slice(0, 5)];
    }, [value]);
    const parsed = datePart ? parse(datePart, "yyyy-MM-dd", new Date()) : null;
    const commit = (newDate, newTime) => {
        const d = newDate ?? datePart;
        const t = newTime ?? timePart;
        if (!d)
            return;
        onChange(`${d}T${t}`);
    };
    return (_jsxs(_Fragment, { children: [_jsxs("button", { ref: anchorRef, type: "button", disabled: disabled, onClick: () => setOpen(true), className: cn("flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm", "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className), children: [_jsx("span", { className: value ? "" : "text-muted-foreground", children: value && parsed ? `${format(parsed, "MMM d, yyyy")} · ${timePart}` : placeholder }), _jsx(CalendarIcon, { className: "h-4 w-4 text-muted-foreground" })] }), _jsxs(Popover, { open: open, onOpenChange: setOpen, anchorRef: anchorRef, align: "start", className: "w-auto p-0", children: [_jsx(Calendar, { value: parsed, onChange: (d) => commit(format(d, "yyyy-MM-dd")) }), _jsxs("div", { className: "border-t border-border px-2 py-2 flex items-center gap-2", children: [_jsx("span", { className: "text-xs text-muted-foreground", children: "Time" }), _jsx(Input, { type: "text", inputMode: "numeric", pattern: "\\d{2}:\\d{2}", value: timePart, onChange: (e) => {
                                    const t = e.target.value;
                                    // Accept partial input as user types — only commit when valid HH:MM.
                                    if (/^\d{0,2}:?\d{0,2}$/.test(t)) {
                                        const clean = t.replace(/[^\d:]/g, "");
                                        if (/^\d{2}:\d{2}$/.test(clean))
                                            commit(undefined, clean);
                                    }
                                }, className: "h-7 w-20 font-mono text-xs" })] })] })] }));
}
