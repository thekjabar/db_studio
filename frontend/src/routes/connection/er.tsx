import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { Key, KeyRound, LayoutGrid } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

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

function TableNode({ data }: { data: { label: string; columns: TableColumn[] } }) {
  return (
    <div className="rounded-md border border-border bg-card text-xs shadow-lg min-w-[200px] font-mono relative">
      <Handle type="target" position={Position.Left} style={HIDDEN_HANDLE} />
      <Handle type="source" position={Position.Right} style={HIDDEN_HANDLE} />
      <div className="px-3 py-1.5 bg-primary/15 border-b border-border font-semibold text-primary">
        {data.label}
      </div>
      <ul>
        {data.columns.slice(0, 20).map((c) => (
          <li key={c.name} className="px-3 py-1 flex items-center gap-2 border-b border-border last:border-0">
            {c.pk ? <Key className="h-3 w-3 text-amber-400" /> : c.fk ? <KeyRound className="h-3 w-3 text-sky-400" /> : <span className="w-3" />}
            <span className="flex-1">{c.name}</span>
            <span className="text-muted-foreground text-[10px]">{c.type}</span>
          </li>
        ))}
        {data.columns.length > 20 && (
          <li className="px-3 py-1 text-[10px] text-muted-foreground italic">
            +{data.columns.length - 20} more columns
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

  const [filter, setFilter] = useState("");
  const [onlyRelated, setOnlyRelated] = useState(false);

  const q = useQuery({
    queryKey: ["er", id, schema],
    queryFn: () => api.getEr(id!, schema),
    enabled: !!id,
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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
          columns: n.columns.map((c) => ({ ...c, fk: fkCols.has(c.name) })),
        },
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
  }, [q.data, filter, onlyRelated]);

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
        <Button size="sm" variant="outline" className="ml-auto" onClick={relayout}>
          <LayoutGrid className="h-3.5 w-3.5" /> Re-layout
        </Button>
      </div>
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
    </div>
  );
}
