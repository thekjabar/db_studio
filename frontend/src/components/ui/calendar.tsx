import * as React from "react";
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CalendarProps {
  value?: Date | null;
  onChange?: (d: Date) => void;
  initialMonth?: Date;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function Calendar({ value, onChange, initialMonth }: CalendarProps) {
  const [cursor, setCursor] = React.useState<Date>(() => initialMonth ?? value ?? new Date());
  const today = new Date();

  const days = React.useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  return (
    <div className="p-2 select-none">
      <div className="flex items-center justify-between mb-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setCursor((c) => subMonths(c, 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-sm font-medium">{format(cursor, "MMMM yyyy")}</div>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setCursor((c) => addMonths(c, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-[10px] text-muted-foreground mb-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const inMonth = isSameMonth(d, cursor);
          const selected = value && isSameDay(d, value);
          const isToday = isSameDay(d, today);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onChange?.(d)}
              className={cn(
                "h-7 w-7 rounded text-xs transition-colors",
                !inMonth && "text-muted-foreground/40",
                inMonth && "hover:bg-accent",
                isToday && !selected && "ring-1 ring-primary/40",
                selected && "bg-primary text-primary-foreground hover:bg-primary",
              )}
            >
              {format(d, "d")}
            </button>
          );
        })}
      </div>
    </div>
  );
}
