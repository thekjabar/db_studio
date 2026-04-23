import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import dagre from "@dagrejs/dagre";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import { Key, KeyRound, LayoutGrid, MoreVertical, Pencil, Plus, Trash2, Link2, Undo2 } from "lucide-react";
import { api, extractErrorMessage, type AlterTableRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useModal } from "@/components/modal-provider";
import { cn } from "@/lib/utils";
import { AddColumnDialog } from "@/components/add-column-dialog";
import { RetypeColumnDialog } from "@/components/retype-column-dialog";

interface Ctx { schema: string }

type TableColumn = { name: string; type: string; pk?: boolean; fk?: boolean };

const NODE_WIDTH = 240;
// Base header (36) + per-column row (~26). dagre needs a node height, not the
// rendered one, but a reasonable estimate keeps edges from overlapping cards.
const rowHeight = (n: number) => 36 + Math.min(n, 20) * 24;

// Keep edges anchored to real <Handle> nodes but hide them visually — they
// otherwise show as red squares in light mode.
const HIDDEN_HANDLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  background: "transparent",
  border: "none",
  opacity: 0,
};

/** Action payload emitted when a user clicks an edit affordance on a table node. */
export type NodeAction =
  | { kind: "table-rename"; schema: string; table: string }
  | { kind: "table-drop"; schema: string; table: string }
  | { kind: "table-add-column"; schema: string; table: string }
  | { kind: "column-rename"; schema: string; table: string; column: string }
  | { kind: "column-retype"; schema: string; table: string; column: string; currentType: string }
  | { kind: "column-drop"; schema: string; table: string; column: string }
  | { kind: "fk-pick-source"; schema: string; table: string; column: string }
  | { kind: "fk-pick-target"; schema: string; table: string; column: string };

interface TableNodeData {
  label: string;
  schema: string;
  table: string;
  columns: TableColumn[];
  editMode: boolean;
  fkPending?: { table: string; column: string } | null;
  onAction?: (a: NodeAction) => void;
}

function TableNode({ data }: { data: TableNodeData }) {
  const { label, schema, table, columns, editMode, fkPending, onAction } = data;
  return (
    <div className="rounded-md border border-border bg-card text-xs shadow-lg min-w-[200px] font-mono relative">
      <Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
      <div className="px-3 py-1.5 bg-primary/15 border-b border-border font-semibold text-primary flex items-center gap-1">
        <span className="flex-1 truncate">{label}</span>
        {editMode && onAction && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              title="Add column"
              onClick={(e) => { e.stopPropagation(); onAction({ kind: "table-add-column", schema, table }); }}
              className="p-0.5 rounded hover:bg-primary/20"
            >
              <Plus className="h-3 w-3" />
            </button>
            <button
              type="button"
              title="Rename table"
              onClick={(e) => { e.stopPropagation(); onAction({ kind: "table-rename", schema, table }); }}
              className="p-0.5 rounded hover:bg-primary/20"
            >
              <Pencil className="h-3 w-3" />
            </button>
            <button
              type="button"
              title="Drop table"
              onClick={(e) => { e.stopPropagation(); onAction({ kind: "table-drop", schema, table }); }}
              className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
      <ul>
        {columns.slice(0, 20).map((c) => {
          const isPending = fkPending?.table === table && fkPending.column === c.name;
          return (
            <li
              key={c.name}
              className={cn(
                "px-3 py-1 flex items-center gap-2 border-b border-border last:border-0 group",
                isPending && "bg-sky-500/15",
                editMode && "hover:bg-accent/40",
              )}
            >
              {c.pk ? (
                <Key className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0" />
              ) : c.fk ? (
                <KeyRound className="h-3 w-3 text-sky-600 dark:text-sky-400 shrink-0" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className="flex-1 truncate">{c.name}</span>
              <span className="text-muted-foreground text-[10px] shrink-0">{c.type}</span>
              {editMode && onAction && (
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    title={fkPending ? (isPending ? "Cancel FK" : "Set as FK target") : "Start FK from this column"}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction(
                        fkPending
                          ? { kind: "fk-pick-target", schema, table, column: c.name }
                          : { kind: "fk-pick-source", schema, table, column: c.name },
                      );
                    }}
                    className="p-0.5 rounded hover:bg-sky-500/20 text-sky-600 dark:text-sky-400"
                  >
                    <Link2 className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Rename column"
                    onClick={(e) => { e.stopPropagation(); onAction({ kind: "column-rename", schema, table, column: c.name }); }}
                    className="p-0.5 rounded hover:bg-accent"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Change type"
                    onClick={(e) => { e.stopPropagation(); onAction({ kind: "column-retype", schema, table, column: c.name, currentType: c.type }); }}
                    className="p-0.5 rounded hover:bg-accent"
                  >
                    <MoreVertical className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    title="Drop column"
                    onClick={(e) => { e.stopPropagation(); onAction({ kind: "column-drop", schema, table, column: c.name }); }}
                    className="p-0.5 rounded hover:bg-destructive/20 text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {columns.length > 20 && (
          <li className="px-3 py-1 text-[10px] text-muted-foreground italic">
            +{columns.length - 20} more columns
          </li>
        )}
      </ul>
    </div>
  );
}

const nodeTypes = { table: TableNode };

function layoutWithDagre(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph({ compound: false });
  g.setGraph({ rankdir: "LR", ranksep: 80, nodesep: 40, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) {
    const cols = (n.data as { columns: TableColumn[] }).columns;
    g.setNode(n.id, { width: NODE_WIDTH, height: rowHeight(cols.length) });
  }
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const p = g.node(n.id);
    return {
      ...n,
      // dagre gives the center; ReactFlow wants top-left.
      position: { x: p.x - p.width / 2, y: p.y - p.height / 2 },
    };
  });
}

export default function ErRoute() {
  const { id } = useParams<{ id: string }>();
  const ctx = useOutletContext<Ctx>();
  const schema = ctx?.schema ?? "public";
  const qc = useQueryClient();
  const modal = useModal();

  const [filter, setFilter] = useState("");
  const [onlyRelated, setOnlyRelated] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // Undo stack for safe-to-reverse schema edits. Intentionally scoped:
  //   • addColumn  → inverse is dropColumn (no data yet, so recoverable)
  //   • addForeignKey → inverse is dropConstraint
  // We deliberately don't record drops/retypes/renames — their undos would
  // need to restore column data we no longer have.
  type UndoOp =
    | { kind: "addColumn"; schema: string; table: string; column: string }
    | { kind: "addForeignKey"; schema: string; table: string; constraintName: string };
  const [undoStack, setUndoStack] = useState<UndoOp[]>([]);
  const pushUndo = (op: UndoOp) => setUndoStack((s) => [...s, op]);
  const popUndo = (): UndoOp | undefined => {
    let popped: UndoOp | undefined;
    setUndoStack((s) => {
      if (s.length === 0) return s;
      popped = s[s.length - 1];
      return s.slice(0, -1);
    });
    return popped;
  };
  // Applies the inverse of the top operation and pops it from the stack.
  const undoLast = () => {
    const op = undoStack[undoStack.length - 1];
    if (!op) return;
    if (op.kind === "addColumn") {
      alter.mutate(
        { schema: op.schema, name: op.table, dropColumns: [op.column], confirm: true },
        { onSuccess: () => { popUndo(); toast.success(`Undid: add column ${op.column}`); } },
      );
    } else if (op.kind === "addForeignKey") {
      alter.mutate(
        { schema: op.schema, name: op.table, dropConstraints: [op.constraintName], confirm: true },
        { onSuccess: () => { popUndo(); toast.success("Undid: add foreign key"); } },
      );
    }
  };
  const [fkPending, setFkPending] = useState<{ table: string; column: string } | null>(null);
  const [addColumnFor, setAddColumnFor] = useState<{ schema: string; table: string } | null>(null);
  const [retypeState, setRetypeState] = useState<{ table: string; column: string; currentType: string } | null>(null);

  const q = useQuery({
    queryKey: ["er", id, schema],
    queryFn: () => api.getEr(id!, schema),
    enabled: !!id,
  });

  const alter = useMutation({
    mutationFn: (req: AlterTableRequest) => api.alterTable(id!, req),
    onSuccess: () => {
      toast.success("Schema updated");
      qc.invalidateQueries({ queryKey: ["er", id, schema] });
      qc.invalidateQueries({ queryKey: ["tables", id, schema] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const drop = useMutation({
    mutationFn: (vars: { schema: string; table: string }) =>
      api.dropTable(id!, vars.schema, vars.table, true),
    onSuccess: () => {
      toast.success("Table dropped");
      qc.invalidateQueries({ queryKey: ["er", id, schema] });
      qc.invalidateQueries({ queryKey: ["tables", id, schema] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Keep a stable handler identity so the memoized `laidOut` doesn't see a new
  // function every render (which would infinite-loop the setNodes effect below).
  const handleActionRef = useRef<(a: NodeAction) => void>(() => {});
  const dispatch = useCallback((a: NodeAction) => handleActionRef.current(a), []);

  const handleAction = useCallback(async (a: NodeAction) => {
    switch (a.kind) {
      case "table-add-column":
        setAddColumnFor({ schema: a.schema, table: a.table });
        return;
      case "table-rename": {
        const next = await modal.prompt({
          title: `Rename ${a.schema}.${a.table}`,
          description: "Enter the new table name.",
          defaultValue: a.table,
        });
        if (!next || next === a.table) return;
        alter.mutate({ schema: a.schema, name: a.table, renameTo: next, confirm: true });
        return;
      }
      case "table-drop": {
        const ok = await modal.confirm({
          title: `Drop ${a.schema}.${a.table}?`,
          description: "This removes the table and all of its data. Not recoverable without a backup.",
          confirmLabel: "Drop table",
          destructive: true,
        });
        if (!ok) return;
        drop.mutate({ schema: a.schema, table: a.table });
        return;
      }
      case "column-rename": {
        const next = await modal.prompt({
          title: `Rename column ${a.column}`,
          description: `In ${a.schema}.${a.table}.`,
          defaultValue: a.column,
        });
        if (!next || next === a.column) return;
        alter.mutate({
          schema: a.schema,
          name: a.table,
          renameColumns: [{ from: a.column, to: next }],
          confirm: true,
        });
        return;
      }
      case "column-retype":
        setRetypeState({ table: a.table, column: a.column, currentType: a.currentType });
        return;
      case "column-drop": {
        const ok = await modal.confirm({
          title: `Drop column ${a.column}?`,
          description: `In ${a.schema}.${a.table}. Data in this column is permanently removed.`,
          confirmLabel: "Drop column",
          destructive: true,
        });
        if (!ok) return;
        alter.mutate({
          schema: a.schema,
          name: a.table,
          dropColumns: [a.column],
          confirm: true,
        });
        return;
      }
      case "fk-pick-source":
        setFkPending({ table: a.table, column: a.column });
        toast.info(`FK source set: ${a.table}.${a.column}. Click the target column now.`);
        return;
      case "fk-pick-target": {
        if (!fkPending) return;
        if (fkPending.table === a.table && fkPending.column === a.column) {
          setFkPending(null);
          toast.info("FK cancelled");
          return;
        }
        const refSchema = a.schema;
        const preview = `FOREIGN KEY (${fkPending.column}) REFERENCES ${refSchema}.${a.table} (${a.column})`;
        const ok = await modal.confirm({
          title: "Add foreign key?",
          description: `On ${fkPending.table}: ${preview}`,
          confirmLabel: "Add FK",
        });
        if (ok) {
          // Derive the FK constraint name the driver will generate. Matches
          // the pg naming convention used by our Postgres driver
          // (<table>_<first-col>_fkey). Good enough for undo.
          const constraintName = `${fkPending.table}_${fkPending.column}_fkey`;
          alter.mutate(
            {
              schema,
              name: fkPending.table,
              addForeignKeys: [{
                columns: [fkPending.column],
                refSchema,
                refTable: a.table,
                refColumns: [a.column],
              }],
              confirm: true,
            },
            {
              onSuccess: () => pushUndo({
                kind: "addForeignKey",
                schema,
                table: fkPending!.table,
                constraintName,
              }),
            },
          );
        }
        setFkPending(null);
        return;
      }
    }
  }, [alter, drop, fkPending, modal, schema]);

  // Refresh the ref without triggering a render.
  handleActionRef.current = handleAction;

  // Ctrl+Z / Cmd+Z triggers undo while in edit mode. We scope to edit mode so
  // the shortcut doesn't interfere with text editing inputs elsewhere.
  useEffect(() => {
    if (!editMode) return;
    const h = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Skip when typing into an input/textarea/contenteditable.
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, undoStack.length]);

  // Normalize values that may arrive as a Postgres array literal string
  // (e.g. "{id,user_id}") instead of a JS array.
  const toArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === "string") {
      const inner = v.replace(/^\{|\}$/g, "").trim();
      if (!inner) return [];
      return inner.split(",").map((s) => s.replace(/^"|"$/g, ""));
    }
    return [];
  };

  const laidOut = useMemo(() => {
    if (!q.data) return { nodes: [] as Node[], edges: [] as Edge[] };

    // Tables that participate in an FK, on either end.
    const related = new Set<string>();
    for (const e of q.data.edges) {
      related.add(e.source);
      related.add(e.target);
    }
    const fkByTable = new Map<string, Set<string>>();
    for (const e of q.data.edges) {
      const set = fkByTable.get(e.source) ?? new Set<string>();
      for (const c of toArray(e.columns)) set.add(c);
      fkByTable.set(e.source, set);
    }

    const filterLower = filter.trim().toLowerCase();
    const keptNodes = q.data.nodes.filter((n) => {
      if (onlyRelated && !related.has(n.id)) return false;
      if (filterLower && !(`${n.schema}.${n.name}`.toLowerCase().includes(filterLower))) return false;
      return true;
    });
    const keptIds = new Set(keptNodes.map((n) => n.id));

    const rfNodes: Node[] = keptNodes.map((n) => {
      const fkCols = fkByTable.get(n.id) ?? new Set<string>();
      return {
        id: n.id,
        type: "table",
        data: {
          label: `${n.schema}.${n.name}`,
          schema: n.schema,
          table: n.name,
          columns: n.columns.map((c) => ({ ...c, fk: fkCols.has(c.name) })),
          editMode,
          fkPending,
          onAction: dispatch,
        } satisfies TableNodeData,
        position: { x: 0, y: 0 }, // dagre overrides
      };
    });

    const rfEdges: Edge[] = q.data.edges
      .filter((e) => keptIds.has(e.source) && keptIds.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: toArray(e.columns).join(", "),
        type: "smoothstep",
        animated: false,
        style: { stroke: "hsl(var(--primary))", strokeWidth: 1.2, opacity: 0.45 },
        pathOptions: { borderRadius: 12 },
        labelStyle: { fill: "hsl(var(--muted-foreground))", fontSize: 10 },
        labelBgStyle: { fill: "hsl(var(--card))" },
      }));

    return { nodes: layoutWithDagre(rfNodes, rfEdges), edges: rfEdges };
  }, [q.data, filter, onlyRelated, editMode, fkPending, dispatch]);

  useEffect(() => {
    setNodes(laidOut.nodes);
    setEdges(laidOut.edges);
  }, [laidOut, setNodes, setEdges]);

  const relayout = () => {
    setNodes((ns) => layoutWithDagre(ns, edges));
  };

  const totalNodes = q.data?.nodes.length ?? 0;
  const totalEdges = q.data?.edges.length ?? 0;

  if (q.isLoading) {
    return <div className="h-full flex items-center justify-center text-sm text-muted-foreground">Loading schema graph...</div>;
  }
  if (q.error) {
    return <div className="h-full flex items-center justify-center text-sm text-destructive">{extractErrorMessage(q.error)}</div>;
  }

  return (
    <div className="h-full relative">
      <div className="absolute top-3 left-3 right-3 z-10 flex items-center gap-2 flex-wrap">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${totalNodes} tables...`}
          className="h-8 text-xs font-mono max-w-xs bg-card/80 backdrop-blur"
        />
        <label className="flex items-center gap-2 text-xs rounded-md border border-border bg-card/80 backdrop-blur px-2.5 h-8 cursor-pointer">
          <Checkbox checked={onlyRelated} onCheckedChange={setOnlyRelated} />
          <span>Only tables with foreign keys</span>
        </label>
        <div className="text-[10px] text-muted-foreground font-mono">
          {nodes.length}/{totalNodes} tables · {edges.length}/{totalEdges} edges
        </div>
        {editMode && undoStack.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={undoLast}
            title="Undo last safe schema change (Ctrl+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo ({undoStack.length})
          </Button>
        )}
        <Button
          size="sm"
          variant={editMode ? "default" : "outline"}
          className={editMode && undoStack.length > 0 ? "" : "ml-auto"}
          onClick={() => {
            // Clear the undo stack on toggle — applies in both directions so
            // stale entries from a previous edit session don't reappear.
            setEditMode((v) => !v);
            setFkPending(null);
            setUndoStack([]);
          }}
        >
          <Pencil className="h-3.5 w-3.5" /> {editMode ? "Exit edit" : "Edit schema"}
        </Button>
        <Button size="sm" variant="outline" onClick={relayout}>
          <LayoutGrid className="h-3.5 w-3.5" /> Re-layout
        </Button>
      </div>
      {fkPending && (
        <div className="absolute top-14 left-3 z-10 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs">
          FK source: <span className="font-mono text-sky-700 dark:text-sky-400">{fkPending.table}.{fkPending.column}</span>
          <button
            type="button"
            onClick={() => setFkPending(null)}
            className="ml-3 text-muted-foreground hover:text-foreground underline"
          >
            cancel
          </button>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.1}
      >
        <Background color="hsl(var(--border))" gap={20} />
        <Controls />
        <MiniMap pannable zoomable className="!bg-card !border-border" nodeColor="hsl(var(--primary))" />
      </ReactFlow>

      {addColumnFor && (
        <AddColumnDialog
          connectionId={id!}
          schema={addColumnFor.schema}
          table={addColumnFor.table}
          open
          onOpenChange={(v) => !v && setAddColumnFor(null)}
          onSaved={(columnName) => {
            toast.success("Column added");
            qc.invalidateQueries({ queryKey: ["er", id, schema] });
            if (addColumnFor) {
              pushUndo({
                kind: "addColumn",
                schema: addColumnFor.schema,
                table: addColumnFor.table,
                column: columnName,
              });
            }
          }}
        />
      )}

      <RetypeColumnDialog
        open={!!retypeState}
        columnName={retypeState?.column ?? ""}
        currentType={retypeState?.currentType ?? ""}
        onOpenChange={(v) => !v && setRetypeState(null)}
        onConfirm={(newType) => {
          if (!retypeState) return;
          alter.mutate({
            schema,
            name: retypeState.table,
            alterColumns: [{ name: retypeState.column, type: newType }],
            confirm: true,
          });
          setRetypeState(null);
        }}
      />
    </div>
  );
}
