import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Edit3, RotateCcw } from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { NumberInput } from "@/components/ui/number-input";
import { JsonFieldEditor } from "@/components/json-field-editor";
import { ArrayInput } from "@/components/ui/array-input";
import { CommentsPanel } from "@/components/comments-panel";
import { cn } from "@/lib/utils";
import { api, extractErrorMessage, type ColumnInfo } from "@/lib/api";

/** Build the polymorphic comment target key for a specific row. */
function buildRowTarget(schema: string, table: string, pk: Record<string, unknown>): string {
  // Sort PK keys so target is stable regardless of key-insert order.
  const sortedKeys = Object.keys(pk).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = pk[k];
  return `row:${schema}.${table}:${JSON.stringify(canonical)}`;
}

type Sentinel = "NULL" | "DEFAULT" | "VALUE";

interface FieldState {
  col: ColumnInfo;
  state: Sentinel;
  value: string; // raw string; parsed on submit per type
}

interface Props {
  connectionId: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  row: Record<string, unknown> | null; // null = insert, object = update
  onClose: () => void;
  onSaved: () => void;
}

type Kind = "text" | "long-text" | "number" | "bool" | "json" | "datetime" | "date" | "array";

function classifyType(dataType: string): Kind {
  const t = dataType.toLowerCase();
  // Postgres arrays report as `type[]` or, in some catalogs, `ARRAY`. Anything ending in [] is an array.
  if (t.endsWith("[]") || t === "array") return "array";
  if (t.includes("json")) return "json";
  if (t === "boolean" || t === "bool") return "bool";
  if (/(int|numeric|decimal|real|double|serial|float)/.test(t)) return "number";
  if (t.startsWith("timestamp")) return "datetime";
  if (t === "date") return "date";
  if (t === "text" || t.includes("char") && !t.includes("character varying")) return "long-text";
  return "text";
}

/** For an array type, return the item kind for ArrayInput. */
function arrayItemKind(dataType: string): "text" | "number" | "bool" {
  const t = dataType.toLowerCase().replace(/\[\]$/, "");
  if (t === "boolean" || t === "bool") return "bool";
  if (/(int|numeric|decimal|real|double|serial|float)/.test(t)) return "number";
  return "text";
}

function toInputValue(v: unknown, kind: Kind): string {
  if (v === null || v === undefined) return "";
  if (kind === "json" && typeof v === "object") return JSON.stringify(v, null, 2);
  if (kind === "array") {
    // Normalize whatever the server returned into a JSON array string. pg arrays
    // often arrive as either JS arrays or as Postgres literals like "{a,b}".
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === "string") {
      const inner = v.replace(/^\{|\}$/g, "").trim();
      if (!inner) return "[]";
      const items = inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
      return JSON.stringify(items);
    }
    return "[]";
  }
  if (kind === "datetime" && typeof v === "string") {
    // Trim trailing Z / timezone into the "yyyy-MM-ddTHH:mm" the picker expects.
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : v;
  }
  if (kind === "date" && typeof v === "string") {
    return v.slice(0, 10);
  }
  return String(v);
}

function parseValue(v: string, kind: Kind): unknown {
  if (kind === "number") {
    if (v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error("Invalid number");
    return n;
  }
  if (kind === "bool") {
    return v === "true" ? true : v === "false" ? false : null;
  }
  if (kind === "json" || kind === "array") {
    if (v.trim() === "") return null;
    try {
      return JSON.parse(v);
    } catch {
      throw new Error(kind === "array" ? "Invalid array" : "Invalid JSON");
    }
  }
  return v;
}

export function RowDrawer({ connectionId, schema, table, columns, row, onClose, onSaved }: Props) {
  const isInsert = row === null;
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonEditing, setJsonEditing] = useState<string | null>(null); // column name being edited in the json sheet

  useEffect(() => {
    if (!columns.length) return;
    const next: Record<string, FieldState> = {};
    for (const c of columns) {
      const kind = classifyType(c.dataType);
      if (isInsert) {
        // Insert: start with DEFAULT when a server default exists, else NULL if nullable, else empty VALUE.
        if (c.defaultValue) {
          next[c.name] = { col: c, state: "DEFAULT", value: "" };
        } else if (c.nullable) {
          next[c.name] = { col: c, state: "NULL", value: "" };
        } else {
          next[c.name] = { col: c, state: "VALUE", value: "" };
        }
      } else {
        const v = row![c.name];
        if (v === null || v === undefined) {
          next[c.name] = { col: c, state: "NULL", value: "" };
        } else {
          next[c.name] = { col: c, state: "VALUE", value: toInputValue(v, kind) };
        }
      }
    }
    setFields(next);
    setError(null);
  }, [columns, row, isInsert]);

  const [required, optional] = useMemo(() => {
    const req: ColumnInfo[] = [];
    const opt: ColumnInfo[] = [];
    for (const c of columns) {
      if (!c.nullable && c.defaultValue == null) req.push(c);
      else opt.push(c);
    }
    return [req, opt];
  }, [columns]);

  const buildValues = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    for (const name in fields) {
      const f = fields[name];
      // Skip identity cols on insert: they're auto-generated.
      if (isInsert && f.col.isIdentity) continue;
      // Never send PK columns in UPDATE — they identify the row, not a value to
      // change. Sending them would let the user silently rewrite the id.
      if (!isInsert && f.col.isPrimaryKey) continue;
      if (f.state === "DEFAULT") continue; // don't send — let the DB default apply
      if (f.state === "NULL") out[name] = null;
      else {
        try {
          out[name] = parseValue(f.value, classifyType(f.col.dataType));
        } catch (e) {
          setError(`${name}: ${(e as Error).message}`);
          return null;
        }
      }
    }
    return out;
  };

  const pkFromRow = (): Record<string, unknown> => {
    const pk: Record<string, unknown> = {};
    for (const c of columns) {
      if (c.isPrimaryKey && row) pk[c.name] = row[c.name];
    }
    return pk;
  };

  const save = async () => {
    setError(null);
    const values = buildValues();
    if (!values) return;
    setBusy(true);
    try {
      if (isInsert) {
        await api.insertRow(connectionId, table, { schema, row: values });
        toast.success("Row inserted");
      } else {
        const pk = pkFromRow();
        if (Object.keys(pk).length === 0) {
          setError("This table has no primary key — cannot update in place.");
          setBusy(false);
          return;
        }
        await api.updateRow(connectionId, table, { schema, pk, set: values });
        toast.success("Row updated");
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** A column is read-only in this drawer context (PK in update mode, identity in insert mode). */
  const isLocked = (c: ColumnInfo): boolean => {
    if (isInsert) return !!c.isIdentity;
    return !!c.isPrimaryKey;
  };

  const renderInput = (f: FieldState) => {
    const kind = classifyType(f.col.dataType);
    const setValue = (v: string) =>
      setFields((xs) => ({ ...xs, [f.col.name]: { ...xs[f.col.name], state: "VALUE", value: v } }));

    const locked = isLocked(f.col);
    // Only PK/auto-generated columns are truly locked. NULL/DEFAULT fields stay
    // editable — typing into them auto-switches to VALUE state (see setValue),
    // so there's no extra "Enter value" click for the common case of typing.
    const disabled = locked;

    if (kind === "bool") {
      return (
        <Select value={f.state === "VALUE" ? f.value : ""} onValueChange={setValue} disabled={disabled}>
          <SelectTrigger className="h-9">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">TRUE</SelectItem>
            <SelectItem value="false">FALSE</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (kind === "array") {
      let items: unknown[] = [];
      if (f.state === "VALUE" && f.value) {
        try {
          const parsed = JSON.parse(f.value);
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          items = [];
        }
      }
      return (
        <ArrayInput
          value={items}
          onChange={(next) => setValue(JSON.stringify(next))}
          itemKind={arrayItemKind(f.col.dataType)}
          disabled={disabled}
          placeholder={f.state === "NULL" ? "NULL" : "Type and press Enter"}
        />
      );
    }
    if (kind === "json") {
      const raw = f.state === "VALUE" ? f.value : "";
      const preview = raw ? raw.replace(/\s+/g, " ").slice(0, 80) : "";
      return (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setJsonEditing(f.col.name)}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm shadow-sm",
            "hover:bg-accent/40 disabled:opacity-50 disabled:cursor-not-allowed",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className={cn("font-mono text-xs truncate", !preview && "text-muted-foreground italic")}>
            {preview ||
              (f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : "Empty — click to edit")}
          </span>
          <span className="text-[10px] text-muted-foreground ml-2 shrink-0">Open editor</span>
        </button>
      );
    }
    if (kind === "long-text") {
      return (
        <Textarea
          value={f.state === "VALUE" ? f.value : ""}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          placeholder={f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : ""}
          className="text-sm"
          rows={3}
        />
      );
    }
    if (kind === "datetime") {
      return (
        <DateTimePicker
          value={f.state === "VALUE" ? f.value : ""}
          onChange={setValue}
          disabled={disabled}
          placeholder={f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : undefined}
        />
      );
    }
    if (kind === "date") {
      return (
        <DatePicker
          value={f.state === "VALUE" ? f.value : ""}
          onChange={setValue}
          disabled={disabled}
          placeholder={f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : undefined}
        />
      );
    }
    if (kind === "number") {
      const integer = /int|serial/.test(f.col.dataType.toLowerCase());
      return (
        <NumberInput
          value={f.state === "VALUE" ? f.value : ""}
          onChange={setValue}
          disabled={disabled}
          integer={integer}
          placeholder={f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : ""}
        />
      );
    }
    return (
      <Input
        value={f.state === "VALUE" ? f.value : ""}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        placeholder={f.state === "NULL" ? "NULL" : f.state === "DEFAULT" ? `Default: ${f.col.defaultValue}` : ""}
      />
    );
  };

  const renderField = (c: ColumnInfo) => {
    const f = fields[c.name];
    if (!f) return null;
    return (
      <div key={c.name} className="grid grid-cols-[180px_1fr] gap-4 items-start">
        <div className="pt-1.5">
          <div className="font-mono text-sm">
            {c.name}
            {!c.nullable && <span className="text-destructive ml-1">*</span>}
          </div>
          <div className="text-xs text-muted-foreground">{c.dataType}</div>
          {c.isPrimaryKey && <div className="text-[10px] text-amber-400 mt-0.5">PRIMARY KEY</div>}
        </div>
        <div className="space-y-1">
          {renderInput(f)}
          {isLocked(c) ? (
            <div className="text-[11px] text-muted-foreground italic">
              {isInsert ? "Auto-generated on insert." : "Primary key — read-only."}
            </div>
          ) : (
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              {c.nullable && (
                <button
                  type="button"
                  className={f.state === "NULL" ? "text-primary" : "hover:text-foreground"}
                  onClick={() => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "NULL" } }))}
                >
                  Set NULL
                </button>
              )}
              {c.defaultValue && (
                <button
                  type="button"
                  className={f.state === "DEFAULT" ? "text-primary" : "hover:text-foreground"}
                  onClick={() => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "DEFAULT" } }))}
                >
                  <RotateCcw className="h-3 w-3 inline mr-1" />Default: <span className="font-mono">{c.defaultValue}</span>
                </button>
              )}
              {f.state !== "VALUE" && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => setFields((xs) => ({ ...xs, [c.name]: { ...xs[c.name], state: "VALUE" } }))}
                >
                  <Edit3 className="h-3 w-3 inline mr-1" />Enter value
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent width="w-[560px]" resizable storageKey="rowDrawerWidth">
        <SheetHeader>
          <SheetTitle>
            {isInsert ? "Insert row into" : "Update row from"}{" "}
            <code className="text-primary font-mono">{table}</code>
          </SheetTitle>
          <SheetDescription>
            {isInsert
              ? "Required fields are marked with *. Optional fields fall back to their default or NULL."
              : "Change any field below. Primary key columns are used to identify the row — don't change them unless you mean to."}
          </SheetDescription>
        </SheetHeader>

        <SheetBody className="space-y-6">
          {required.length > 0 && (
            <div className="space-y-4">
              <div className="text-sm font-semibold">Required</div>
              {required.map(renderField)}
            </div>
          )}
          {optional.length > 0 && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-semibold">Optional fields</div>
                <div className="text-xs text-muted-foreground">
                  These columns accept NULL or use a default value.
                </div>
              </div>
              {optional.map(renderField)}
            </div>
          )}
          {!isInsert && row && (
            <div className="space-y-3 pt-4 border-t border-border">
              <CommentsPanel
                connectionId={connectionId}
                target={buildRowTarget(schema, table, pkFromRow())}
                label="Comments on this row"
              />
            </div>
          )}
        </SheetBody>

        {error && (
          <div className="mx-6 mb-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2">
            {error}
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {isInsert ? "Insert" : "Save"}
          </Button>
        </SheetFooter>
      </SheetContent>

      {jsonEditing && (
        <JsonFieldEditor
          open
          fieldName={jsonEditing}
          value={(() => {
            const f = fields[jsonEditing];
            if (!f) return null;
            if (f.state !== "VALUE" || !f.value) return null;
            try {
              return JSON.parse(f.value);
            } catch {
              return f.value;
            }
          })()}
          onClose={() => setJsonEditing(null)}
          onSave={(next) => {
            setFields((xs) => ({
              ...xs,
              [jsonEditing]: { ...xs[jsonEditing], state: "VALUE", value: JSON.stringify(next, null, 2) },
            }));
          }}
        />
      )}
    </Sheet>
  );
}
