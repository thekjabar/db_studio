import { useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type AlterTableRequest, type ColumnInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
import { AddColumnDialog } from "@/components/add-column-dialog";
import { RetypeColumnDialog } from "@/components/retype-column-dialog";
import { CommentsPanel } from "@/components/comments-panel";

interface Ctx { schema: string }

export default function SchemaRoute() {
  const { id } = useParams<{ id: string }>();
  const ctx = useOutletContext<Ctx>();
  const schema = ctx?.schema ?? "public";
  const qc = useQueryClient();
  const modal = useModal();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [retypeCol, setRetypeCol] = useState<{ name: string; currentType: string } | null>(null);

  const tablesQ = useQuery({
    queryKey: ["tables", id, schema],
    queryFn: () => api.listTables(id!, schema),
    enabled: !!id,
  });

  const colsQ = useQuery({
    queryKey: ["columns", id, schema, selectedTable],
    queryFn: () => api.getTableColumns(id!, selectedTable!, schema),
    enabled: !!selectedTable && !!id,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["columns", id, schema, selectedTable] });
    qc.invalidateQueries({ queryKey: ["tables", id, schema] });
    qc.invalidateQueries({ queryKey: ["definition", id, schema, selectedTable] });
  };

  const alter = useMutation({
    mutationFn: (req: AlterTableRequest) => api.alterTable(id!, req),
    onSuccess: () => {
      toast.success("Schema updated");
      invalidate();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const dropColumn = async (name: string) => {
    if (!selectedTable) return;
    const ok = await modal.confirm({
      title: `Drop column ${name}?`,
      description: "This permanently removes the column and its data.",
      confirmLabel: "Drop",
      destructive: true,
    });
    if (!ok) return;
    alter.mutate({ schema, name: selectedTable, dropColumns: [name], confirm: true });
  };

  const renameColumn = async (oldName: string) => {
    if (!selectedTable) return;
    const newName = await modal.prompt({
      title: `Rename ${oldName}`,
      description: "Enter the new column name.",
      defaultValue: oldName,
    });
    if (!newName || newName === oldName) return;
    alter.mutate({
      schema,
      name: selectedTable,
      renameColumns: [{ from: oldName, to: newName }],
      confirm: true,
    });
  };

  const applyRetype = (newType: string) => {
    if (!selectedTable || !retypeCol) return;
    if (newType === retypeCol.currentType) {
      setRetypeCol(null);
      return;
    }
    alter.mutate({
      schema,
      name: selectedTable,
      alterColumns: [{ name: retypeCol.name, type: newType }],
      confirm: true,
    });
    setRetypeCol(null);
  };

  return (
    <div className="h-full flex">
      <aside className="w-56 shrink-0 border-r border-border bg-card overflow-y-auto">
        <div className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-muted-foreground border-b border-border">
          Tables — {schema}
        </div>
        {tablesQ.isLoading && <div className="p-3 text-xs text-muted-foreground">Loading...</div>}
        {tablesQ.data?.map((t) => (
          <button
            key={t.name}
            onClick={() => setSelectedTable(t.name)}
            className={`block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-accent ${
              selectedTable === t.name ? "bg-accent text-primary" : ""
            }`}
          >
            {t.name}
          </button>
        ))}
      </aside>

      <div className="flex-1 overflow-auto p-6">
        {!selectedTable && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Select a table to edit its schema.
          </div>
        )}
        {selectedTable && (
          <>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold font-mono">{schema}.{selectedTable}</h2>
                <p className="text-xs text-muted-foreground">Edit columns. Schema changes apply immediately.</p>
              </div>
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Add column
              </Button>
            </div>
            {colsQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading columns...</div>
            ) : (
              <div className="rounded-md border border-border overflow-hidden">
                <table className="w-full text-xs font-mono">
                  <thead className="bg-muted">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Type</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Nullable</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground">Default</th>
                      <th className="text-right px-3 py-2 font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(colsQ.data ?? []).map((c: ColumnInfo) => (
                      <tr key={c.name} className="border-t border-border">
                        <td className="px-3 py-2">{c.name}</td>
                        <td className="px-3 py-2 text-primary">{c.dataType}</td>
                        <td className="px-3 py-2">{c.nullable ? "YES" : "NO"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{c.defaultValue ?? ""}</td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="ghost" onClick={() => renameColumn(c.name)}>Rename</Button>
                          <Button size="sm" variant="ghost" onClick={() => setRetypeCol({ name: c.name, currentType: c.dataType })}>Retype</Button>
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => dropColumn(c.name)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-8 max-w-2xl">
              <CommentsPanel
                connectionId={id!}
                target={`table:${schema}.${selectedTable}`}
                label={`Comments on ${schema}.${selectedTable}`}
              />
            </div>
          </>
        )}
      </div>

      {selectedTable && (
        <AddColumnDialog
          connectionId={id!}
          schema={schema}
          table={selectedTable}
          open={addOpen}
          onOpenChange={setAddOpen}
          onSaved={() => {
            toast.success("Column added");
            invalidate();
          }}
        />
      )}

      <RetypeColumnDialog
        open={!!retypeCol}
        columnName={retypeCol?.name ?? ""}
        currentType={retypeCol?.currentType ?? ""}
        onOpenChange={(v) => !v && setRetypeCol(null)}
        onConfirm={applyRetype}
      />
    </div>
  );
}
