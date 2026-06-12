import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/ui/number-input";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, extractErrorMessage, type ColumnInfo } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connectionId: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  /** PK values for each selected row. */
  pks: Record<string, unknown>[];
  onApplied: () => void;
}

type Kind = "text" | "number" | "bool" | "json" | "date" | "datetime";

function kindOf(dataType: string): Kind {
  const t = dataType.toLowerCase();
  if (t.includes("json")) return "json";
  if (t === "boolean" || t === "bool") return "bool";
  if (/(int|numeric|decimal|real|double|serial|float)/.test(t)) return "number";
  if (t.startsWith("timestamp")) return "datetime";
  if (t === "date") return "date";
  return "text";
}

export function BulkEditDialog({ open, onOpenChange, connectionId, schema, table, columns, pks, onApplied }: Props) {
  // Editable cols — no PK, no identity (those identify the row).
  const editableCols = columns.filter((c) => !c.isPrimaryKey && !c.isIdentity);
  const [colName, setColName] = useState<string>("");
  const [raw, setRaw] = useState<string>("");
  const [setNull, setSetNull] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setColName(editableCols[0]?.name ?? "");
    setRaw("");
    setSetNull(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const col = editableCols.find((c) => c.name === colName);
  const kind = col ? kindOf(col.dataType) : "text";

  const parse = (): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (setNull) return { ok: true, value: null };
    try {
      if (kind === "number") {
        if (raw === "") return { ok: false, error: "Enter a value" };
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: "Not a number" };
        return { ok: true, value: n };
      }
      if (kind === "bool") return { ok: true, value: raw === "true" };
      if (kind === "json") {
        if (raw.trim() === "") return { ok: true, value: null };
        return { ok: true, value: JSON.parse(raw) };
      }
      return { ok: true, value: raw };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  const apply = async () => {
    if (!col) return;
    const parsed = parse();
    if (!parsed.ok) {
      toast.error(parsed.error);
      return;
    }
    setBusy(true);
    try {
      const r = await api.bulkUpdateRows(connectionId, table, {
        schema,
        pks,
        values: { [col.name]: parsed.value },
      });
      toast.success(`Updated ${r.affectedRows} row${r.affectedRows === 1 ? "" : "s"}`);
      onApplied();
      onOpenChange(false);
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const renderInput = () => {
    if (setNull) {
      return <Input value="NULL" disabled className="font-mono italic text-muted-foreground" />;
    }
    if (kind === "bool") {
      return (
        <Select value={raw} onValueChange={setRaw}>
          <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="true">TRUE</SelectItem>
            <SelectItem value="false">FALSE</SelectItem>
          </SelectContent>
        </Select>
      );
    }
    if (kind === "number") {
      const integer = !!col && /int|serial/.test(col.dataType.toLowerCase());
      return <NumberInput value={raw} onChange={setRaw} integer={integer} />;
    }
    if (kind === "date") return <DatePicker value={raw} onChange={setRaw} />;
    if (kind === "datetime") return <DateTimePicker value={raw} onChange={setRaw} />;
    if (kind === "json") return <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={6} className="font-mono text-xs" />;
    return <Input value={raw} onChange={(e) => setRaw(e.target.value)} />;
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bulk edit <span className="font-mono text-primary">{pks.length}</span> row
            {pks.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Set one column to the same value on every selected row. Primary key columns are excluded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Column</Label>
            <Select value={colName} onValueChange={setColName}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {editableCols.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    <span className="font-mono">{c.name}</span>
                    <span className="ml-2 text-muted-foreground text-[10px]">{c.dataType}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>New value</Label>
            {renderInput()}
            {col?.nullable && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox checked={setNull} onCheckedChange={setSetNull} />
                Set NULL instead
              </label>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={apply} disabled={busy || !colName}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Apply to {pks.length}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
