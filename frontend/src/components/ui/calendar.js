import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths, } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export function Calendar({ value, onChange, initialMonth }) {
    const [cursor, setCursor] = React.useState(() => initialMonth ?? value ?? new Date());
    const today = new Date();
    const days = React.useMemo(() => {
        const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
        const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
        return eachDayOfInterval({ start, end });
    }, [cursor]);
    return (_jsxs("div", { className: "p-2 select-none", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", onClick: () => setCursor((c) => subMonths(c, 1)), children: _jsx(ChevronLeft, { className: "h-4 w-4" }) }), _jsx("div", { className: "text-sm font-medium", children: format(cursor, "MMMM yyyy") }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-7 w-7", onClick: () => setCursor((c) => addMonths(c, 1)), children: _jsx(ChevronRight, { className: "h-4 w-4" }) })] }), _jsx("div", { className: "grid grid-cols-7 gap-1 text-[10px] text-muted-foreground mb-1", children: WEEKDAYS.map((w) => (_jsx("div", { className: "text-center", children: w }, w))) }), _jsx("div", { className: "grid grid-cols-7 gap-1", children: days.map((d) => {
                    const inMonth = isSameMonth(d, cursor);
                    const selected = value && isSameDay(d, value);
                    const isToday = isSameDay(d, today);
                    return (_jsx("button", { type: "button", onClick: () => onChange?.(d), className: cn("h-7 w-7 rounded text-xs transition-colors", !inMonth && "text-muted-foreground/40", inMonth && "hover:bg-accent", isToday && !selected && "ring-1 ring-primary/40", selected && "bg-primary text-primary-foreground hover:bg-primary"), children: format(d, "d") }, d.toISOString()));
                }) })] }));
}
