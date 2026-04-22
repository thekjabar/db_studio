import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  /** Current items. */
  value: unknown[];
  onChange: (v: unknown[]) => void;
  /** "text" | "number" | "bool" — controls how typed input is parsed. */
  itemKind?: "text" | "number" | "bool";
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function parseItem(raw: string, kind: Props["itemKind"]): unknown {
  if (kind === "number") {
    if (raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("not a number");
    return n;
  }
  if (kind === "bool") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("must be true or false");
  }
  return raw;
}

function formatItem(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Chip-based editor for array values. Type a value and press Enter or comma to
 * add it; click × on a chip to remove. Paste-commas auto-split.
 */
export function ArrayInput({ value, onChange, itemKind = "text", placeholder, disabled, className }: Props) {
  const [buf, setBuf] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const commitBuf = () => {
    const raw = buf.trim();
    if (!raw) return;
    try {
      const parsed = parseItem(raw, itemKind);
      onChange([...value, parsed]);
      setBuf("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  return (
    <div className={cn("space-y-1", className)}>
      <div
        className={cn(
          "flex flex-wrap gap-1 items-center rounded-md border border-input bg-background px-2 py-1 min-h-9",
          disabled && "opacity-50 pointer-events-none",
        )}
      >
        {value.map((v, i) => (
          <span
            key={i}
            className="inline-flex items-center gap-1 rounded-sm bg-primary/15 border border-primary/25 px-1.5 py-0.5 text-[11px] font-mono text-primary"
          >
            {formatItem(v)}
            <button
              type="button"
              onClick={() => removeAt(i)}
              className="text-primary/70 hover:text-primary"
              aria-label="Remove item"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          value={buf}
          onChange={(e) => {
            const v = e.target.value;
            if (v.includes(",")) {
              const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
              // Commit each comma-separated segment.
              const toAdd: unknown[] = [];
              for (const p of parts) {
                try {
                  toAdd.push(parseItem(p, itemKind));
                } catch (err) {
                  setError((err as Error).message);
                  setBuf(p);
                  return;
                }
              }
              onChange([...value, ...toAdd]);
              setBuf("");
              setError(null);
              return;
            }
            setBuf(v);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitBuf();
            }
            if (e.key === "Backspace" && !buf && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={commitBuf}
          placeholder={value.length === 0 ? placeholder ?? "Type and press Enter" : ""}
          className="flex-1 min-w-[80px] bg-transparent text-sm outline-none"
          disabled={disabled}
        />
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
