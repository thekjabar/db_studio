import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Copy, FileCode2, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Step =
  | { kind: "add-column"; schema: string; table: string; name: string; type: string; nullable: boolean; default?: string }
  | { kind: "drop-column"; schema: string; table: string; name: string }
  | { kind: "rename-column"; schema: string; table: string; name: string; newName: string }
  | { kind: "create-table"; schema: string; name: string; columns: { name: string; type: string; pk?: boolean; nullable?: boolean }[] }
  | { kind: "drop-table"; schema: string; name: string };

function renderStepSql(step: Step, dialect: string): string {
  const ident = (s: string) => {
    if (dialect === "MYSQL") return `\`${s}\``;
    if (dialect === "MSSQL") return `[${s}]`;
    return `"${s}"`;
  };
  const qt = (s: string, t: string) => (dialect === "SQLITE" ? ident(t) : `${ident(s)}.${ident(t)}`);
  switch (step.kind) {
    case "add-column": {
      const parts = [`${ident(step.name)} ${step.type}`];
      if (!step.nullable) parts.push("NOT NULL");
      if (step.default) parts.push(`DEFAULT ${step.default}`);
      return `ALTER TABLE ${qt(step.schema, step.table)} ADD COLUMN ${parts.join(" ")};`;
    }
    case "drop-column":
      return `ALTER TABLE ${qt(step.schema, step.table)} DROP COLUMN ${ident(step.name)};`;
    case "rename-column":
      return `ALTER TABLE ${qt(step.schema, step.table)} RENAME COLUMN ${ident(step.name)} TO ${ident(step.newName)};`;
    case "create-table": {
      const cols = step.columns.map((c) => {
        const parts = [`  ${ident(c.name)} ${c.type}`];
        if (!c.nullable) parts.push("NOT NULL");
        if (c.pk) parts.push("PRIMARY KEY");
        return parts.join(" ");
      });
      return `CREATE TABLE ${qt(step.schema, step.name)} (\n${cols.join(",\n")}\n);`;
    }
    case "drop-table":
      return `DROP TABLE ${qt(step.schema, step.name)};`;
  }
}

export default function MigrationBuilderRoute() {
  const { id } = useParams<{ id: string }>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [applying, setApplying] = useState(false);

  const connQ = useQuery({
    queryKey: ["connection", id],
    queryFn: () => api.getConnection(id!),
    enabled: !!id,
  });
  const dialect = connQ.data?.dialect ?? "POSTGRES";

  const allSql = steps.map((s) => renderStepSql(s, dialect)).join("\n\n");

  const addStep = (step: Step) => setSteps((s) => [...s, step]);
  const removeStep = (i: number) => setSteps((s) => s.filter((_, idx) => idx !== i));
  const moveStep = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };

  const applyAll = async () => {
    if (steps.length === 0) return;
    setApplying(true);
    try {
      for (const step of steps) {
        if (step.kind === "add-column") {
          await api.alterTable(id!, {
            schema: step.schema,
            name: step.table,
            addColumns: [{ name: step.name, type: step.type, nullable: step.nullable, default: step.default ?? null }],
          });
        } else if (step.kind === "drop-column") {
          await api.alterTable(id!, {
            schema: step.schema,
            name: step.table,
            dropColumns: [step.name],
          });
        } else if (step.kind === "rename-column") {
          await api.alterTable(id!, {
            schema: step.schema,
            name: step.table,
            renameColumns: [{ from: step.name, to: step.newName }],
          });
        } else if (step.kind === "create-table") {
          await api.createTable(id!, {
            schema: step.schema,
            name: step.name,
            columns: step.columns.map((c) => ({
              name: c.name,
              type: c.type,
              nullable: c.nullable,
              primaryKey: c.pk,
            })),
          });
        } else if (step.kind === "drop-table") {
          await api.dropTable(id!, step.schema, step.name, true);
        }
      }
      toast.success(`Applied ${steps.length} step${steps.length === 1 ? "" : "s"}`);
      setSteps([]);
    } catch (err) {
      toast.error(`Failed at step ${steps.length}: ${extractErrorMessage(err)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <FileCode2 className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Migration builder</div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(allSql);
              toast.success("SQL copied");
            }}
            disabled={steps.length === 0}
          >
            <Copy className="h-3.5 w-3.5" /> Copy SQL
          </Button>
          <Button onClick={applyAll} disabled={applying || steps.length === 0}>
            {applying && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Apply all
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <AddStepForm connectionId={id!} onAdd={addStep} dialect={dialect} />

        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            Staged steps ({steps.length})
          </div>
          {steps.length === 0 ? (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              Add steps above. They'll run in order when you Apply.
            </div>
          ) : (
            <div className="space-y-2">
              {steps.map((s, i) => (
                <div key={i} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
                    <span className="font-mono">#{i + 1}</span>
                    <span className="uppercase tracking-wider">{s.kind}</span>
                    <div className="ml-auto flex items-center gap-1">
                      <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="p-1 rounded hover:bg-accent disabled:opacity-30">
                        ↑
                      </button>
                      <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="p-1 rounded hover:bg-accent disabled:opacity-30">
                        ↓
                      </button>
                      <button
                        onClick={() => removeStep(i)}
                        className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <pre className="text-[11px] font-mono bg-muted p-2 rounded overflow-x-auto">
                    {renderStepSql(s, dialect)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>

        {steps.length > 0 && (
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Combined SQL
            </div>
            <pre className="rounded-md border border-border bg-card p-3 text-[11px] font-mono overflow-x-auto">
              {allSql}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function AddStepForm({
  connectionId,
  onAdd,
  dialect,
}: {
  connectionId: string;
  onAdd: (s: Step) => void;
  dialect: string;
}) {
  const [kind, setKind] = useState<Step["kind"]>("add-column");
  const [schema, setSchema] = useState("");
  const [table, setTable] = useState("");
  const [colName, setColName] = useState("");
  const [colType, setColType] = useState("text");
  const [nullable, setNullable] = useState(false);
  const [renameTo, setRenameTo] = useState("");

  // Live schema/table/column lists from the current connection.
  const schemasQ = useQuery({
    queryKey: ["schemas", connectionId],
    queryFn: () => api.listSchemas(connectionId),
  });
  const tablesQ = useQuery({
    queryKey: ["tables", connectionId, schema],
    queryFn: () => api.listTables(connectionId, schema),
    enabled: !!schema,
  });
  // Only fetch columns when the step actually references existing ones —
  // skip on `add-column` (user is naming a new column) and `drop-table`.
  const needsExistingColumn = kind === "drop-column" || kind === "rename-column";
  const columnsQ = useQuery({
    queryKey: ["columns", connectionId, schema, table],
    queryFn: () => api.getTableColumns(connectionId, table, schema),
    enabled: !!schema && !!table && needsExistingColumn,
  });

  // Default schema once available.
  useEffect(() => {
    if (!schemasQ.data || schema) return;
    if (schemasQ.data.includes("public")) setSchema("public");
    else if (schemasQ.data[0]) setSchema(schemasQ.data[0]);
  }, [schemasQ.data, schema]);
  // Cascade reset.
  useEffect(() => { setTable(""); }, [schema]);
  useEffect(() => { setColName(""); }, [table, kind]);

  const reset = () => {
    setTable("");
    setColName("");
    setRenameTo("");
  };

  const submit = () => {
    if (!schema || !table) {
      toast.error("Schema + table required");
      return;
    }
    if (kind === "add-column" && (!colName || !colType)) {
      toast.error("Column name + type required");
      return;
    }
    if (kind === "drop-column" && !colName) {
      toast.error("Column name required");
      return;
    }
    if (kind === "rename-column" && (!colName || !renameTo)) {
      toast.error("Old + new column names required");
      return;
    }
    if (kind === "add-column") onAdd({ kind, schema, table, name: colName, type: colType, nullable });
    else if (kind === "drop-column") onAdd({ kind, schema, table, name: colName });
    else if (kind === "rename-column") onAdd({ kind, schema, table, name: colName, newName: renameTo });
    else if (kind === "drop-table") onAdd({ kind, schema, name: table });
    reset();
  };

  return (
    <div className="rounded-md border border-border bg-card p-3 space-y-3">
      <div className="text-xs text-muted-foreground">
        Adding to a <span className="font-mono">{dialect}</span> connection
      </div>
      <div className="grid grid-cols-[160px_1fr_1fr_auto] gap-2 items-end">
        <div>
          <Label className="text-[11px]">Step type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as Step["kind"])}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add-column">Add column</SelectItem>
              <SelectItem value="drop-column">Drop column</SelectItem>
              <SelectItem value="rename-column">Rename column</SelectItem>
              <SelectItem value="drop-table">Drop table</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px]">Schema</Label>
          <Select value={schema} onValueChange={setSchema}>
            <SelectTrigger>
              <SelectValue placeholder={schemasQ.isLoading ? "Loading…" : "Pick a schema"} />
            </SelectTrigger>
            <SelectContent>
              {(schemasQ.data ?? []).map((s) => (
                <SelectItem key={s} value={s} className="font-mono">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px]">{kind === "drop-table" ? "Table to drop" : "Table"}</Label>
          <Select value={table} onValueChange={setTable} disabled={!schema}>
            <SelectTrigger>
              <SelectValue placeholder={
                !schema ? "Pick schema first" :
                tablesQ.isLoading ? "Loading…" :
                tablesQ.data?.length === 0 ? "No tables" :
                "Pick a table"
              } />
            </SelectTrigger>
            <SelectContent>
              {(tablesQ.data ?? []).map((t) => (
                <SelectItem key={t.name} value={t.name} className="font-mono">{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={submit}>
          <Plus className="h-3.5 w-3.5" /> Stage
        </Button>
      </div>
      {(kind === "add-column" || kind === "drop-column" || kind === "rename-column") && (
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label className="text-[11px]">Column</Label>
            {needsExistingColumn ? (
              <Select value={colName} onValueChange={setColName} disabled={!table}>
                <SelectTrigger>
                  <SelectValue placeholder={
                    !table ? "Pick table first" :
                    columnsQ.isLoading ? "Loading…" :
                    columnsQ.data?.length === 0 ? "No columns" :
                    "Pick a column"
                  } />
                </SelectTrigger>
                <SelectContent>
                  {(columnsQ.data ?? []).map((c) => (
                    <SelectItem key={c.name} value={c.name} className="font-mono">{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              // `add-column` names a NEW column, so it stays a text input.
              <Input value={colName} onChange={(e) => setColName(e.target.value)} placeholder="new_column" />
            )}
          </div>
          {kind === "add-column" && (
            <>
              <div>
                <Label className="text-[11px]">Type (raw SQL)</Label>
                <Input value={colType} onChange={(e) => setColType(e.target.value)} placeholder="text / varchar(64) / int" />
              </div>
              <div className="flex items-end gap-2">
                <label className="text-xs flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={nullable}
                    onChange={(e) => setNullable(e.target.checked)}
                  />
                  nullable
                </label>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
            </>
          )}
          {kind === "rename-column" && (
            <div>
              <Label className="text-[11px]">New name</Label>
              <Input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="new_name" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
