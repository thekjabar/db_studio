import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PG_COLUMN_TYPES } from "@/lib/column-types";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Used when the current type isn't a standard one — shown at the top. */
  currentValue?: string;
  placeholder?: string;
  className?: string;
}

/**
 * Grouped Postgres column-type picker. Shows section headers (Text / Numeric /
 * Boolean & UUID / Date & Time / JSON & Binary / Network) with aliases in
 * parentheses, matching the style of the Add Column dialog.
 */
export function ColumnTypeSelect({ value, onChange, currentValue, placeholder = "Choose a column type...", className }: Props) {
  // If the current/default value isn't one of the known types (e.g. a custom
  // domain or enum), render it first so re-typing preserves it.
  const knownSet = new Set(
    PG_COLUMN_TYPES.flatMap((g) => g.items.map((i) => i.value)),
  );
  const extra =
    currentValue && !knownSet.has(currentValue)
      ? { value: currentValue, label: `${currentValue} (current)` }
      : null;

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {extra && (
          <>
            <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              Current
            </div>
            <SelectItem value={extra.value}>{extra.label}</SelectItem>
          </>
        )}
        {PG_COLUMN_TYPES.map((g) => (
          <div key={g.group}>
            <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label ?? i.value}
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}
