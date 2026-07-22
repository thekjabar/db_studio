import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type ColumnSpec, type ForeignKeySpec } from "@/lib/api";
import { ColumnTypeSelect } from "@/components/column-type-select";

interface Props {
  connectionId: string;
  schema: string;
  table: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: (columnName: string) => void;
}

type FkDraft = {
  refTable: string;
  refSchema: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
};

const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

export function AddColumnDialog({ connectionId, schema, table, open, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [baseType, setBaseType] = useState("");
  const [isArray, setIsArray] = useState(false);
  const [defaultValue, setDefaultValue] = useState("");
  const [isPrimaryKey, setIsPrimaryKey] = useState(false);
  const [nullable, setNullable] = useState(true);
  const [isUnique, setIsUnique] = useState(false);
  const [check, setCheck] = useState("");
  const [fks, setFks] = useState<FkDraft[]>([]);
  const [previewSql, setPreviewSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setComment("");
    setBaseType("");
    setIsArray(false);
    setDefaultValue("");
    setIsPrimaryKey(false);
    setNullable(true);
    setIsUnique(false);
    setCheck("");
    setFks([]);
    setPreviewSql(null);
    setError(null);
  }, [open]);

  // Need to know other tables in the schema for FK picker
  const tablesQ = useQuery({
    queryKey: ["tables", connectionId, schema],
    queryFn: () => api.listTables(connectionId, schema),
    enabled: open && fks.length > 0,
  });

  const buildSpec = (): ColumnSpec | null => {
    if (!name.trim()) {
      setError("Column name is required.");
      return null;
    }
    if (!baseType) {
      setError("Choose a column type.");
      return null;
    }
    const type = isArray ? `${baseType}[]` : baseType;
    const defaultTrim = defaultValue.trim();
    let defValue: string | null = null;
    let defIsExpr = false;
    if (defaultTrim) {
      // Supabase convention: "(expr)" means expression, otherwise literal.
      if (defaultTrim.startsWith("(") && defaultTrim.endsWith(")")) {
        defValue = defaultTrim.slice(1, -1);
        defIsExpr = true;
      } else {
        defValue = defaultTrim;
      }
    }
    return {
      name: name.trim(),
      type,
      nullable: !isPrimaryKey && nullable,
      primaryKey: isPrimaryKey,
      unique: isUnique,
      default: defValue,
      defaultIsExpression: defIsExpr || undefined,
      check: check.trim() || null,
      comment: comment.trim() || null,
    };
  };

  const buildRequest = (confirm: boolean) => {
    const spec = buildSpec();
    if (!spec) return null;
    const fkSpecs: ForeignKeySpec[] = fks
      .filter((f) => f.refTable && f.refColumn)
      .map((f) => ({
        columns: [spec.name],
        refSchema: f.refSchema || schema,
        refTable: f.refTable,
        refColumns: [f.refColumn],
        onDelete: f.onDelete || undefined,
        onUpdate: f.onUpdate || undefined,
      }));
    return {
      schema,
      name: table,
      addColumns: [spec],
      addForeignKeys: fkSpecs.length ? fkSpecs : undefined,
      confirm,
    };
  };

  const doPreview = async () => {
    setError(null);
    const req = buildRequest(false);
    if (!req) return;
    setBusy(true);
    try {
      const r = await api.alterTable(connectionId, req);
      setPreviewSql(r.preview);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join("; ") : msg || "Failed to build preview");
    } finally {
      setBusy(false);
    }
  };

  const doSave = async () => {
    setError(null);
    const req = buildRequest(true);
    if (!req) return;
    setBusy(true);
    try {
      await api.alterTable(connectionId, req);
      onSaved(name);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join("; ") : msg || "Failed to apply change");
    } finally {
      setBusy(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Add new column to <span className="font-mono">{table}</span>
          </DialogTitle>
          <DialogDescription>
            Column is applied with <code>ALTER TABLE</code>. Use Preview to see the generated SQL first.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[140px_1fr] gap-x-6 gap-y-5">
          {/* General */}
          <div className="text-sm font-semibold pt-1">General</div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="column_name" />
              <p className="text-xs text-muted-foreground">
                Recommended to use lowercase and underscores — e.g. <code>column_name</code>
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="flex justify-between">
                <span>Description</span>
                <span className="text-xs text-muted-foreground">Optional</span>
              </Label>
              <Input value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
          </div>

          {/* Data Type */}
          <div className="text-sm font-semibold pt-1">Data Type</div>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <ColumnTypeSelect value={baseType} onChange={setBaseType} />
            </div>
            <div className="flex items-start gap-3">
              <Switch checked={isArray} onCheckedChange={setIsArray} />
              <div>
                <div className="text-sm font-medium">Define as Array</div>
                <div className="text-xs text-muted-foreground">
                  Allow column to be defined as a variable-length array (e.g. <code>text[]</code>)
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Default Value</Label>
              <Input
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
                placeholder="NULL"
              />
              <p className="text-xs text-muted-foreground">
                Can be a literal or an expression. Wrap expressions in brackets — e.g.{" "}
                <code>(gen_random_uuid())</code>
              </p>
            </div>
          </div>

          {/* Foreign Keys */}
          <div className="text-sm font-semibold pt-1">Foreign Keys</div>
          <div className="space-y-3">
            {fks.map((fk, i) => (
              <div key={i} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-medium">FK #{i + 1}</div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => setFks((xs) => xs.filter((_, j) => j !== i))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Referenced table</Label>
                    <Select
                      value={fk.refTable}
                      onValueChange={(v) =>
                        setFks((xs) => xs.map((x, j) => (j === i ? { ...x, refTable: v, refColumn: "" } : x)))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Choose table..." />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        {(tablesQ.data ?? []).map((t) => (
                          <SelectItem key={`${t.schema}.${t.name}`} value={t.name}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Referenced column</Label>
                    <Input
                      value={fk.refColumn}
                      onChange={(e) =>
                        setFks((xs) => xs.map((x, j) => (j === i ? { ...x, refColumn: e.target.value } : x)))
                      }
                      placeholder="id"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">ON DELETE</Label>
                    <Select
                      value={fk.onDelete}
                      onValueChange={(v) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, onDelete: v } : x)))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="NO ACTION" />
                      </SelectTrigger>
                      <SelectContent>
                        {FK_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">ON UPDATE</Label>
                    <Select
                      value={fk.onUpdate}
                      onValueChange={(v) => setFks((xs) => xs.map((x, j) => (j === i ? { ...x, onUpdate: v } : x)))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="NO ACTION" />
                      </SelectTrigger>
                      <SelectContent>
                        {FK_ACTIONS.map((a) => (
                          <SelectItem key={a} value={a}>{a}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setFks((xs) => [...xs, { refTable: "", refSchema: schema, refColumn: "", onDelete: "", onUpdate: "" }])
              }
            >
              <Plus className="h-3.5 w-3.5" /> Add foreign key
            </Button>
          </div>

          {/* Constraints */}
          <div className="text-sm font-semibold pt-1">Constraints</div>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Switch checked={isPrimaryKey} onCheckedChange={(v) => { setIsPrimaryKey(v); if (v) setNullable(false); }} />
              <div>
                <div className="text-sm font-medium">Is Primary Key</div>
                <div className="text-xs text-muted-foreground">
                  Marks this column as the table's primary key. Implies NOT NULL.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Switch checked={nullable} onCheckedChange={setNullable} disabled={isPrimaryKey} />
              <div>
                <div className="text-sm font-medium">Allow Nullable</div>
                <div className="text-xs text-muted-foreground">
                  Allow the column to hold NULL when no value is provided.
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Switch checked={isUnique} onCheckedChange={setIsUnique} />
              <div>
                <div className="text-sm font-medium">Is Unique</div>
                <div className="text-xs text-muted-foreground">
                  Enforce that values in this column are unique across rows.
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="flex justify-between">
                <span>CHECK Constraint</span>
                <span className="text-xs text-muted-foreground">Optional</span>
              </Label>
              <Input
                value={check}
                onChange={(e) => setCheck(e.target.value)}
                placeholder={`length("${name || "column_name"}") < 500`}
                className="font-mono"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm px-3 py-2">
            {error}
          </div>
        )}

        {previewSql && (
          <div className="rounded-md border border-border bg-muted">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
              Preview
            </div>
            <pre className="p-3 text-xs font-mono whitespace-pre-wrap">{previewSql}</pre>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="outline" onClick={doPreview} disabled={busy}>
            Preview
          </Button>
          <Button onClick={doSave} disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
