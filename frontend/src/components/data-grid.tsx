import * as React from "react";
import { Check, Key, Maximize2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";

export interface DataGridColumn {
  name: string;
  type?: string;
  pk?: boolean;
}

interface DataGridProps {
  columns: DataGridColumn[];
  rows: Record<string, unknown>[];
  loading?: boolean;
  selectable?: boolean;
  selected?: Set<number>;
  onToggleSelect?: (idx: number) => void;
  onToggleSelectAll?: (all: boolean) => void;
  onEditCell?: (rowIdx: number, column: string, value: unknown) => void;
  onEditJsonCell?: (rowIdx: number, column: string) => void;
  onExpandRow?: (rowIdx: number) => void;
  /** Key to persist column widths under in localStorage. Unique per-table. */
  widthStorageKey?: string;
  emptyMessage?: string;
}

type CellKind = "null" | "bool" | "number" | "json" | "date" | "datetime" | "text";

function detectKind(type: string | undefined, value: unknown): CellKind {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value === "object") return "json";
  if (typeof value === "string") {
    const t = (type ?? "").toLowerCase();
    if (t.startsWith("timestamp")) return "datetime";
    if (t === "date") return "date";
    if (t.startsWith("time")) return "datetime";
    if (/^(?:int|numeric|decimal|real|double|serial|float)/.test(t)) {
      // Server may serialize bigint as string — still render right-aligned.
      if (/^-?\d+(?:\.\d+)?$/.test(value)) return "number";
    }
  }
  return "text";
}

function formatValue(v: unknown, kind: CellKind): string {
  if (kind === "null") return "";
  if (kind === "json") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function typeIconColor(type?: string): string {
  if (!type) return "text-muted-foreground";
  const t = type.toLowerCase();
  if (t.includes("uuid")) return "text-purple-600 dark:text-purple-400";
  if (t.includes("json")) return "text-amber-600 dark:text-amber-400";
  if (t.includes("bool")) return "text-emerald-600 dark:text-emerald-400";
  if (/(int|numeric|decimal|real|double|serial|float)/.test(t)) return "text-sky-600 dark:text-sky-400";
  if (t.includes("time") || t === "date") return "text-cyan-600 dark:text-cyan-400";
  return "text-muted-foreground";
}

const DEFAULT_WIDTH = 220;
// Rendered-row cap. See comment at the map call site for rationale.
const MAX_RENDER_ROWS = 5000;
const MIN_WIDTH = 80;

export function DataGrid({
  columns,
  rows,
  loading,
  selectable,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  onEditCell,
  onEditJsonCell,
  onExpandRow,
  widthStorageKey,
  emptyMessage = "No rows",
}: DataGridProps) {
  const [editing, setEditing] = React.useState<{ r: number; c: string } | null>(null);
  const [widths, setWidths] = React.useState<Record<string, number>>(() => {
    if (!widthStorageKey || typeof localStorage === "undefined") return {};
    try {
      const raw = localStorage.getItem(`dbdash.colWidths.${widthStorageKey}`);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Re-hydrate when the storage key changes (navigating between tables).
  React.useEffect(() => {
    if (!widthStorageKey || typeof localStorage === "undefined") {
      setWidths({});
      return;
    }
    try {
      const raw = localStorage.getItem(`dbdash.colWidths.${widthStorageKey}`);
      setWidths(raw ? JSON.parse(raw) : {});
    } catch {
      setWidths({});
    }
  }, [widthStorageKey]);

  // Persist on change, debounced.
  React.useEffect(() => {
    if (!widthStorageKey || typeof localStorage === "undefined") return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(`dbdash.colWidths.${widthStorageKey}`, JSON.stringify(widths));
      } catch {
        // Storage full / disabled — silently skip.
      }
    }, 250);
    return () => clearTimeout(t);
  }, [widths, widthStorageKey]);
  // Arrow-key navigation state — the focused cell in the grid.
  const [activeCell, setActiveCell] = React.useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  // Keep activeCell in range when rows/columns shrink.
  React.useEffect(() => {
    setActiveCell((p) => ({
      r: Math.max(0, Math.min(p.r, rows.length - 1)),
      c: Math.max(0, Math.min(p.c, columns.length - 1)),
    }));
  }, [rows.length, columns.length]);

  const onGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return; // let the cell editor own keys while editing
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!rows.length || !columns.length) return;
    const move = (dr: number, dc: number) => {
      setActiveCell((p) => ({
        r: Math.max(0, Math.min(p.r + dr, rows.length - 1)),
        c: Math.max(0, Math.min(p.c + dc, columns.length - 1)),
      }));
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(1, 0); break;
      case "ArrowUp": e.preventDefault(); move(-1, 0); break;
      case "ArrowRight": e.preventDefault(); move(0, 1); break;
      case "ArrowLeft": e.preventDefault(); move(0, -1); break;
      case "Home": e.preventDefault(); setActiveCell((p) => ({ ...p, c: 0 })); break;
      case "End": e.preventDefault(); setActiveCell((p) => ({ ...p, c: columns.length - 1 })); break;
      case "PageDown": e.preventDefault(); move(10, 0); break;
      case "PageUp": e.preventDefault(); move(-10, 0); break;
      case " ":
        if (selectable) {
          e.preventDefault();
          onToggleSelect?.(activeCell.r);
        }
        break;
      case "Enter":
        if (onEditCell || onEditJsonCell) {
          e.preventDefault();
          const col = columns[activeCell.c];
          const kind = detectKind(col.type, rows[activeCell.r]?.[col.name]);
          if (kind === "json" && onEditJsonCell) onEditJsonCell(activeCell.r, col.name);
          else setEditing({ r: activeCell.r, c: col.name });
        }
        break;
    }
  };

  // Resize logic — drag the right edge of the header <th>.
  const resizeState = React.useRef<{ name: string; startX: number; startWidth: number } | null>(null);

  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = resizeState.current;
      if (!s) return;
      const next = Math.max(MIN_WIDTH, s.startWidth + (e.clientX - s.startX));
      setWidths((w) => ({ ...w, [s.name]: next }));
    };
    const onUp = () => {
      resizeState.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startResize = (name: string, e: React.MouseEvent) => {
    e.preventDefault();
    const w = widths[name] ?? DEFAULT_WIDTH;
    resizeState.current = { name, startX: e.clientX, startWidth: w };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const allSelected = selected ? selected.size === rows.length && rows.length > 0 : false;
  const someSelected = !!selected && selected.size > 0 && !allSelected;

  const colSpan = columns.length + (selectable ? 1 : 0);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onGridKeyDown}
      className="relative w-full h-full overflow-auto bg-background focus:outline-none"
    >
      <table className="border-separate border-spacing-0 text-xs" style={{ minWidth: "100%" }}>
        <thead className="sticky top-0 z-20">
          <tr>
            {selectable && (
              <th
                className="sticky left-0 z-30 bg-card/95 backdrop-blur border-b border-r border-border px-0 py-0 align-middle"
                style={{ width: 64, minWidth: 64 }}
              >
                <div className="relative h-9">
                  <div className="absolute inset-y-0 left-3 flex items-center">
                    <Checkbox
                      checked={allSelected}
                      indeterminate={someSelected}
                      onCheckedChange={(v) => onToggleSelectAll?.(v)}
                    />
                  </div>
                </div>
              </th>
            )}
            {columns.map((col) => {
              const w = widths[col.name] ?? DEFAULT_WIDTH;
              return (
                <th
                  key={col.name}
                  style={{ width: w, minWidth: w, maxWidth: w }}
                  className="relative bg-card/95 backdrop-blur border-b border-r border-border px-3 py-2 text-left font-medium whitespace-nowrap"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {col.pk ? (
                      <Key className="h-3 w-3 text-amber-400 shrink-0" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span className="text-foreground font-mono truncate">{col.name}</span>
                    {col.type && (
                      <span
                        className={cn(
                          "text-[10px] font-normal shrink-0",
                          typeIconColor(col.type),
                        )}
                      >
                        {col.type}
                      </span>
                    )}
                  </div>
                  {/* Resize handle */}
                  <div
                    onMouseDown={(e) => startResize(col.name, e)}
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                    style={{ touchAction: "none" }}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && (
            <>
              {Array.from({ length: 8 }).map((_, i) => (
                <tr key={`s${i}`}>
                  {selectable && (
                    <td className="sticky left-0 bg-card border-b border-r border-border px-3 py-2">
                      <div className="h-3 w-3 bg-muted rounded animate-pulse" />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.name}
                      className="border-b border-r border-border px-3 py-2"
                      style={{ width: widths[col.name] ?? DEFAULT_WIDTH }}
                    >
                      <div className="h-3 bg-muted rounded animate-pulse" style={{ width: `${40 + ((i * 7) % 40)}%` }} />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="p-12 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          )}
          {!loading &&
            // Hard cap on rendered rows. The server already truncates at the
            // user's configured cap (default 1000), but a federated query or
            // local result from `pnpm dev` could still hand us 50k rows — and
            // rendering 50k <tr>s will pin a browser tab. 5000 is enough for
            // any meaningful scroll-through; anything over that, the user
            // should narrow the SELECT. Real virtualization is a larger
            // refactor than this cap's pragmatic trade-off.
            rows.slice(0, MAX_RENDER_ROWS).map((row, i) => {
              const isSel = selected?.has(i);
              return (
                <tr
                  key={i}
                  className={cn(
                    "group transition-colors",
                    isSel
                      ? "bg-primary/15 dark:bg-primary/20"
                      : "hover:bg-accent/80 dark:hover:bg-accent/40",
                  )}
                >
                  {selectable && (
                    <td
                      className={cn(
                        "sticky left-0 z-5 border-b border-r border-border px-0 py-0 align-middle relative",
                        isSel
                          ? "bg-primary/15 dark:bg-primary/20 before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-primary"
                          : "bg-card group-hover:bg-accent/80 dark:group-hover:bg-accent/40",
                      )}
                    >
                      <div className="relative h-7 w-16">
                        <div className="absolute inset-y-0 left-3 flex items-center">
                          <Checkbox
                            checked={!!isSel}
                            onCheckedChange={() => onToggleSelect?.(i)}
                          />
                        </div>
                        {onExpandRow && (
                          <button
                            type="button"
                            onClick={() => onExpandRow(i)}
                            title="Expand row"
                            aria-label="Expand row"
                            className="absolute inset-y-0 right-2 flex items-center opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                  {columns.map((col, ci) => {
                    const isEditing = editing?.r === i && editing.c === col.name;
                    const isActive = activeCell.r === i && activeCell.c === ci;
                    const value = row[col.name];
                    const kind = detectKind(col.type, value);
                    const w = widths[col.name] ?? DEFAULT_WIDTH;
                    return (
                      <td
                        key={col.name}
                        onMouseDown={() => setActiveCell({ r: i, c: ci })}
                        onDoubleClick={() => {
                          if (kind === "json" && onEditJsonCell) {
                            onEditJsonCell(i, col.name);
                          } else if (onEditCell) {
                            setEditing({ r: i, c: col.name });
                          }
                        }}
                        style={{ width: w, minWidth: w, maxWidth: w }}
                        className={cn(
                          "border-b border-r border-border px-3 py-1.5 whitespace-nowrap overflow-hidden",
                          kind === "number" && "text-right tabular-nums",
                          isActive && "ring-1 ring-inset ring-primary bg-primary/5",
                        )}
                      >
                        {isEditing ? (
                          <InlineEditor
                            kind={kind}
                            value={value}
                            onCommit={(next) => {
                              if (next !== value) onEditCell?.(i, col.name, next);
                              setEditing(null);
                            }}
                            onCancel={() => setEditing(null)}
                          />
                        ) : (
                          <Cell kind={kind} value={value} />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

function InlineEditor({
  kind,
  value,
  onCommit,
  onCancel,
}: {
  kind: CellKind;
  value: unknown;
  onCommit: (next: unknown) => void;
  onCancel: () => void;
}) {
  // Bool — small select, commits on change.
  if (kind === "bool") {
    const cur = value === true ? "true" : value === false ? "false" : "";
    return (
      <Select
        value={cur}
        onValueChange={(v) => onCommit(v === "true")}
        open
        onOpenChange={(o) => !o && onCancel()}
      >
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">TRUE</SelectItem>
          <SelectItem value="false">FALSE</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  if (kind === "date") {
    const raw = typeof value === "string" ? value : "";
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return (
      <DatePicker value={m ? m[1] : ""} onChange={(v) => onCommit(v || null)} />
    );
  }
  if (kind === "datetime") {
    const raw = typeof value === "string" ? value : "";
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return (
      <DateTimePicker
        value={m ? `${m[1]}T${m[2]}` : ""}
        onChange={(v) => onCommit(v || null)}
      />
    );
  }

  // Default — text input.
  return (
    <input
      autoFocus
      defaultValue={value === null || value === undefined ? "" : String(value)}
      onBlur={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onCancel();
      }}
      className="w-full bg-background border border-ring rounded px-1.5 py-0.5 outline-none text-xs"
    />
  );
}

function Cell({ kind, value }: { kind: CellKind; value: unknown }) {
  if (kind === "null") {
    return <span className="text-muted-foreground/70 italic text-[11px]">NULL</span>;
  }
  if (kind === "bool") {
    const v = value as boolean;
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium font-mono border",
          v
            ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-400 dark:border-emerald-500/20"
            : "bg-rose-500/15 text-rose-700 border-rose-500/40 dark:text-rose-400 dark:border-rose-500/20",
        )}
      >
        {v && <Check className="h-2.5 w-2.5" />}
        {v ? "TRUE" : "FALSE"}
      </span>
    );
  }
  if (kind === "json") {
    const text = formatValue(value, kind);
    // Collapse whitespace so pretty-printed JSON doesn't explode a cell's
    // visual height. Full value still accessible via tooltip.
    const inline = text.replace(/\s+/g, " ").slice(0, 80);
    const truncated = text.length > 80;
    return (
      <span
        className="font-mono text-amber-700 dark:text-amber-400 truncate block"
        title={text}
      >
        {inline}{truncated ? "…" : ""}
      </span>
    );
  }
  if (kind === "number") {
    return (
      <span className="font-mono text-sky-700 dark:text-sky-400 block text-right tabular-nums">
        {formatValue(value, kind)}
      </span>
    );
  }
  if (kind === "date" || kind === "datetime") {
    const raw = String(value);
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
    const pretty = m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : raw;
    return (
      <span className="font-mono text-cyan-700 dark:text-cyan-400" title={raw}>
        {pretty}
      </span>
    );
  }
  const text = formatValue(value, kind);
  return (
    <span
      className="text-foreground truncate block"
      title={text.length > 80 ? text : undefined}
    >
      {text}
    </span>
  );
}
