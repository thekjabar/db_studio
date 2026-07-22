import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Props extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: string;
  onChange: (v: string) => void;
  step?: number;
  integer?: boolean;
}

/**
 * Number input without the browser-native spinners. Custom +/- buttons and
 * inline validation (allows "-", "-12.3", "12", "", etc).
 */
export function NumberInput({ value, onChange, step = 1, integer, className, disabled, ...rest }: Props) {
  const commit = (next: number) => {
    onChange(integer ? String(Math.trunc(next)) : String(next));
  };

  const cur = () => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div className={cn("relative flex items-stretch", className)}>
      <Input
        {...rest}
        disabled={disabled}
        value={value}
        inputMode={integer ? "numeric" : "decimal"}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "" || v === "-" || v === ".") {
            onChange(v);
            return;
          }
          const re = integer ? /^-?\d*$/ : /^-?\d*(?:\.\d*)?$/;
          if (re.test(v)) onChange(v);
        }}
        className="pr-14 font-mono"
      />
      <div className="absolute right-0 top-0 bottom-0 flex border-l border-input">
        <button
          type="button"
          disabled={disabled}
          onClick={() => commit(cur() - step)}
          className="px-2 text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-50"
        >
          <Minus className="h-3 w-3" />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => commit(cur() + step)}
          className="px-2 text-muted-foreground hover:text-foreground hover:bg-accent/60 border-l border-input disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
