import * as React from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Key, Link2, Loader2, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export interface DataGridColumn {
  name: string;
  type?: string;
  pk?: boolean;
}

/** Referenced (schema, table, column) a foreign-key column points at. */
export interface FkTarget {
  refSchema: string;
  refTable: string;
  refColumn: string;
}
/** Map of source column name → its FK target, for the current table. */
export type FkMap = Record<string, FkTarget>;

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
  /** Connection/schema/table — needed to fetch a linked row on FK-cell hover. */
  connectionId?: string;
  schema?: string;
  table?: string;
  /** Foreign keys for the current table, keyed by source column name. When a
   *  cell's column is here and its value is non-null, hovering shows the
   *  referenced row in a popover. */
  fkMap?: FkMap;
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
  // Render timestamps/dates in the viewer's LOCAL timezone. DB stores UTC
  // (the trailing "Z"); showing raw UTC confuses users in other timezones.
  // The exact raw value stays available on hover (see Cell `title`).
  if ((kind === "datetime" || kind === "date") && typeof v === "string") {
    const local = formatLocalDate(v, kind);
    if (local) return local;
  }
  return String(v);
}

/**
 * Convert an ISO-ish timestamp string to local time. Returns null if it
 * doesn't parse (so we fall back to the raw value rather than show "Invalid
 * Date"). `date`-only values render without a time component.
 */
function formatLocalDate(raw: string, kind: CellKind): string | null {
  // Only attempt parsing on strings that look like a date/timestamp — avoids
  // mangling e.g. a "time" column like "14:30:00" or odd text.
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw)) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  if (kind === "date") {
    return d.toLocaleDateString();
  }
  return d.toLocaleString();
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
  connectionId,
  schema,
  table,
  fkMap,
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

  // ---- Foreign-key hover lookup ----------------------------------------
  // Cache resolved rows so re-hovering a value is instant (and we never
  // refetch). Keyed by `${refTable}:${refColumn}:${value}`. Held in a ref so
  // it survives re-renders without being state.
  const fkCache = React.useRef<Map<string, Record<string, unknown> | null>>(new Map());
  // The currently-open FK popover: which cell, its target, and the cursor
  // position to anchor at. `null` when nothing is hovered.
  const [fkHover, setFkHover] = React.useState<{
    key: string;
    target: FkTarget;
    value: string;
    x: number;
    y: number;
  } | null>(null);
  const hoverTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  const fkEnabled = !!fkMap && !!connectionId && !!schema && !!table;

  const openFkHover = (target: FkTarget, value: unknown, x: number, y: number) => {
    if (!fkEnabled || value === null || value === undefined) return;
    const strVal = String(value);
    const key = `${target.refTable}:${target.refColumn}:${strVal}`;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    // ~350ms delay so a quick mouse pass doesn't fire a fetch.
    hoverTimer.current = setTimeout(() => {
      setFkHover({ key, target, value: strVal, x, y });
    }, 350);
  };
  const closeFkHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setFkHover(null);
  };

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
                  className="group/th relative bg-card/95 backdrop-blur border-b border-r border-border px-3 py-2 text-left font-medium whitespace-nowrap"
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
                  {/* Full-name popover on hover — shows the complete column name +
                      type when the header is too narrow to display it all. */}
                  <div
                    className="pointer-events-none absolute left-2 top-full z-40 mt-1 hidden whitespace-nowrap rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg group-hover/th:block"
                  >
                    <div className="flex items-center gap-2">
                      {col.pk && <Key className="h-3 w-3 text-amber-400 shrink-0" />}
                      <span className="font-mono text-sm text-foreground">{col.name}</span>
                    </div>
                    {col.type && (
                      <div className={cn("mt-0.5 text-[11px]", typeIconColor(col.type))}>{col.type}</div>
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
                    const fkTarget = fkMap?.[col.name];
                    const isFk = !!fkTarget && value !== null && value !== undefined && !isEditing;
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
                        onMouseEnter={
                          isFk
                            ? (e) => openFkHover(fkTarget, value, e.clientX, e.clientY)
                            : undefined
                        }
                        onMouseLeave={isFk ? closeFkHover : undefined}
                        style={{ width: w, minWidth: w, maxWidth: w }}
                        className={cn(
                          "group/cell relative border-b border-r border-border px-3 py-1.5 whitespace-nowrap overflow-hidden",
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
                          <>
                            <Cell kind={kind} value={value} />
                            {isFk && (
                              <Link2
                                className="pointer-events-none absolute left-0.5 top-1/2 -translate-y-1/2 h-3 w-3 text-primary/50 opacity-0 group-hover/cell:opacity-100 transition-opacity"
                                aria-hidden
                              />
                            )}
                            {kind !== "null" && <CopyCellButton value={value} kind={kind} />}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
        </tbody>
      </table>

      {fkHover && connectionId && schema && (
        <FkPopover
          connectionId={connectionId}
          target={fkHover.target}
          value={fkHover.value}
          x={fkHover.x}
          y={fkHover.y}
          cache={fkCache.current}
          cacheKey={fkHover.key}
        />
      )}
    </div>
  );
}

/**
 * Popover card showing the linked (referenced) row for a hovered FK cell.
 * Rendered in a portal to <body> so the grid's `overflow-auto` never clips it,
 * and positioned near the cursor. Results are memoized in the shared `cache`
 * Map so re-hovering the same value never refetches.
 */
function FkPopover({
  connectionId,
  target,
  value,
  x,
  y,
  cache,
  cacheKey,
}: {
  connectionId: string;
  target: FkTarget;
  value: string;
  x: number;
  y: number;
  cache: Map<string, Record<string, unknown> | null>;
  cacheKey: string;
}) {
  const cached = cache.has(cacheKey);
  const [row, setRow] = React.useState<Record<string, unknown> | null>(
    cached ? cache.get(cacheKey) ?? null : null,
  );
  const [loading, setLoading] = React.useState(!cached);

  React.useEffect(() => {
    let alive = true;
    if (cache.has(cacheKey)) {
      setRow(cache.get(cacheKey) ?? null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .lookupRow(connectionId, target.refTable, target.refSchema, target.refColumn, value)
      .then((r) => {
        cache.set(cacheKey, r.row);
        if (!alive) return;
        setRow(r.row);
        setLoading(false);
      })
      .catch(() => {
        cache.set(cacheKey, null);
        if (!alive) return;
        setRow(null);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connectionId, target, value, cache, cacheKey]);

  // Position near the cursor, clamped so a ~320px card stays on-screen.
  const CARD_W = 320;
  const left = Math.max(8, Math.min(x + 12, window.innerWidth - CARD_W - 8));
  const top = Math.min(y + 16, window.innerHeight - 40);

  const fields = row ? pickFkFields(row) : [];

  return createPortal(
    <div
      style={{ position: "fixed", left, top, width: CARD_W, zIndex: 70 }}
      className="pointer-events-none rounded-lg border border-border bg-popover text-popover-foreground shadow-xl overflow-hidden"
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] font-medium">
        <Link2 className="h-3 w-3 text-primary shrink-0" />
        <span className="font-mono text-foreground truncate">
          {target.refTable}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground truncate">{target.refColumn} = {value}</span>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : row === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground italic">No matching record</div>
      ) : (
        <dl className="px-3 py-2 space-y-1">
          {fields.map(([k, v]) => (
            <div key={k} className="flex items-baseline gap-2 text-xs">
              <dt className="font-mono text-[11px] text-muted-foreground shrink-0 max-w-[38%] truncate">
                {k}
              </dt>
              <dd className="font-mono text-foreground truncate flex-1 text-right">
                {formatFkValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>,
    document.body,
  );
}

/** Priority column names to surface first in an FK popover, in order. */
const FK_PRIORITY = ["name", "title", "label", "status", "email", "slug", "code"];

/** Pick up to 6 informative, non-null fields from a linked row. Prioritizes
 *  human-friendly columns (name/title/…) then falls back to first columns. */
function pickFkFields(row: Record<string, unknown>): [string, unknown][] {
  const entries = Object.entries(row).filter(([, v]) => v !== null && v !== undefined);
  const seen = new Set<string>();
  const out: [string, unknown][] = [];
  for (const p of FK_PRIORITY) {
    const hit = entries.find(([k]) => k.toLowerCase() === p);
    if (hit && !seen.has(hit[0])) {
      out.push(hit);
      seen.add(hit[0]);
    }
  }
  for (const e of entries) {
    if (out.length >= 6) break;
    if (!seen.has(e[0])) {
      out.push(e);
      seen.add(e[0]);
    }
  }
  return out.slice(0, 6);
}

/** Render an FK field value compactly (objects → JSON, long strings truncated). */
function formatFkValue(v: unknown): string {
  let s: string;
  if (typeof v === "object") {
    try { s = JSON.stringify(v); } catch { s = String(v); }
  } else {
    s = String(v);
  }
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
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

/** The text we copy for a cell: the raw stored value (full JSON, raw
 *  timestamp, exact string) — what you'd paste into a query, not the
 *  truncated/localized display. */
function copyText(value: unknown, kind: CellKind): string {
  if (value === null || value === undefined) return "";
  if (kind === "json") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/** Hover-to-copy button shown on the right of every data cell. */
function CopyCellButton({ value, kind }: { value: unknown; kind: CellKind }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async (e: React.MouseEvent) => {
    // Don't let the click select/edit the cell underneath.
    e.stopPropagation();
    const text = copyText(value, kind);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("Copied to clipboard");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onCopy}
      title="Copy value"
      aria-label="Copy cell value"
      className={cn(
        "absolute right-1 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded",
        "bg-card/90 border border-border text-muted-foreground shadow-sm backdrop-blur",
        "opacity-0 group-hover/cell:opacity-100 hover:text-foreground hover:border-primary/50 transition-opacity",
      )}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
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
    // Local-time display (formatValue converts UTC → viewer's timezone);
    // raw stored value (usually UTC) stays on hover.
    const pretty = formatValue(value, kind);
    return (
      <span className="font-mono text-cyan-700 dark:text-cyan-400" title={`${raw} (raw)`}>
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
