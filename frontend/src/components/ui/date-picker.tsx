import * as React from "react";
import { format, parse } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface BaseProps {
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

/** YYYY-MM-DD string */
interface DateProps extends BaseProps {
  value: string; // "" or "YYYY-MM-DD"
  onChange: (v: string) => void;
}

export function DatePicker({ value, onChange, disabled, placeholder = "Pick a date", className }: DateProps) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);

  const parsed = value ? parse(value, "yyyy-MM-dd", new Date()) : null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm",
          "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <span className={value ? "" : "text-muted-foreground"}>
          {value ? format(parsed!, "MMM d, yyyy") : placeholder}
        </span>
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </button>
      <Popover open={open} onOpenChange={setOpen} anchorRef={anchorRef} align="start" className="w-auto p-0">
        <Calendar
          value={parsed}
          onChange={(d) => {
            onChange(format(d, "yyyy-MM-dd"));
            setOpen(false);
          }}
        />
      </Popover>
    </>
  );
}

/** YYYY-MM-DDTHH:mm string */
interface DateTimeProps extends BaseProps {
  value: string; // "" or "YYYY-MM-DDTHH:mm"
  onChange: (v: string) => void;
}

export function DateTimePicker({ value, onChange, disabled, placeholder = "Pick date & time", className }: DateTimeProps) {
  const [open, setOpen] = React.useState(false);
  const anchorRef = React.useRef<HTMLButtonElement | null>(null);

  // Split value into date / time portions.
  const [datePart, timePart] = React.useMemo(() => {
    if (!value) return ["", "00:00"];
    const [d, t = "00:00"] = value.split("T");
    return [d, t.slice(0, 5)];
  }, [value]);

  const parsed = datePart ? parse(datePart, "yyyy-MM-dd", new Date()) : null;

  const commit = (newDate?: string, newTime?: string) => {
    const d = newDate ?? datePart;
    const t = newTime ?? timePart;
    if (!d) return;
    onChange(`${d}T${t}`);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm",
          "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        <span className={value ? "" : "text-muted-foreground"}>
          {value && parsed ? `${format(parsed, "MMM d, yyyy")} · ${timePart}` : placeholder}
        </span>
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </button>
      <Popover open={open} onOpenChange={setOpen} anchorRef={anchorRef} align="start" className="w-auto p-0">
        <Calendar
          value={parsed}
          onChange={(d) => commit(format(d, "yyyy-MM-dd"))}
        />
        <div className="border-t border-border px-2 py-2 flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Time</span>
          <Input
            type="text"
            inputMode="numeric"
            pattern="\d{2}:\d{2}"
            value={timePart}
            onChange={(e) => {
              const t = e.target.value;
              // Accept partial input as user types — only commit when valid HH:MM.
              if (/^\d{0,2}:?\d{0,2}$/.test(t)) {
                const clean = t.replace(/[^\d:]/g, "");
                if (/^\d{2}:\d{2}$/.test(clean)) commit(undefined, clean);
              }
            }}
            className="h-7 w-20 font-mono text-xs"
          />
        </div>
      </Popover>
    </>
  );
}
