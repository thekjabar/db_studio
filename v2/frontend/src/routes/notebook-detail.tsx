import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import Editor from "@monaco-editor/react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Code2,
  Eye,
  FileText,
  Loader2,
  Play,
  PlayCircle,
  Plus,
  Trash2,
} from "lucide-react";
import {
  api,
  extractErrorMessage,
  type NotebookCell,
  type QueryResult,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useModal } from "@/components/modal-provider";
import { useTheme } from "@/lib/theme-store";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; result: QueryResult; at: number }
  | { status: "error"; message: string; at: number };

function randomCellId(): string {
  return (
    "c_" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

export default function NotebookDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const modal = useModal();

  const nbQ = useQuery({
    queryKey: ["notebook", id],
    queryFn: () => api.getNotebook(id!),
    enabled: !!id,
  });

  // Local editable copy of cells + metadata. We mirror server state on load
  // and auto-save with a short debounce so rapid edits don't storm the API.
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const seededFor = useRef<string | null>(null);

  // Seed local state once when the notebook first loads. Avoids clobbering
  // user edits if the server sends a refetched payload.
  useEffect(() => {
    if (!nbQ.data) return;
    if (seededFor.current === nbQ.data.id) return;
    seededFor.current = nbQ.data.id;
    setName(nbQ.data.name);
    setDescription(nbQ.data.description ?? "");
    setCells(nbQ.data.cells);
  }, [nbQ.data]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (patch: { name?: string; description?: string | null; cells?: NotebookCell[] }) => {
      if (!id) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setSaving(true);
        try {
          await api.updateNotebook(id, patch);
          qc.invalidateQueries({ queryKey: ["notebooks"] });
        } catch (err) {
          toast.error(extractErrorMessage(err));
        } finally {
          setSaving(false);
        }
      }, 600);
    },
    [id, qc],
  );

  const updateCells = (next: NotebookCell[]) => {
    setCells(next);
    persist({ cells: next });
  };

  const del = useMutation({
    mutationFn: () => api.deleteNotebook(id!),
    onSuccess: () => {
      toast.success("Deleted");
      nav("/notebooks");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const runCell = async (cell: NotebookCell) => {
    if (cell.kind !== "sql" || !cell.source.trim() || !nbQ.data) return;
    setRuns((r) => ({ ...r, [cell.id]: { status: "running" } }));
    try {
      const res = await api.runQuery(nbQ.data.connectionId, {
        sql: cell.source,
        maxRows: 1000,
      });
      setRuns((r) => ({ ...r, [cell.id]: { status: "ok", result: res, at: Date.now() } }));
    } catch (err) {
      setRuns((r) => ({
        ...r,
        [cell.id]: { status: "error", message: extractErrorMessage(err), at: Date.now() },
      }));
    }
  };

  const runAll = async () => {
    for (const c of cells) {
      if (c.kind === "sql") {
        // Sequential — a later cell might depend on a prior DDL committing.
        await runCell(c);
      }
    }
  };

  const move = (index: number, delta: number) => {
    const ni = index + delta;
    if (ni < 0 || ni >= cells.length) return;
    const next = [...cells];
    [next[index], next[ni]] = [next[ni], next[index]];
    updateCells(next);
  };

  const removeCell = (cellId: string) => {
    updateCells(cells.filter((c) => c.id !== cellId));
    setRuns((r) => {
      const { [cellId]: _, ...rest } = r;
      return rest;
    });
  };

  const insertCell = (after: number, kind: "md" | "sql") => {
    const next = [...cells];
    next.splice(after + 1, 0, {
      id: randomCellId(),
      kind,
      source: kind === "md" ? "## Heading\n\nExplain what this section does." : "SELECT 1;",
    });
    updateCells(next);
  };

  const updateCell = (cellId: string, patch: Partial<NotebookCell>) => {
    const next = cells.map((c) => (c.id === cellId ? { ...c, ...patch } : c));
    updateCells(next);
  };

  if (nbQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (!nbQ.data) return <div className="p-8 text-destructive">Notebook not found.</div>;

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => nav("/notebooks")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-4 w-px bg-border shrink-0" />
          <BookOpen className="h-5 w-5 text-primary shrink-0" />
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              persist({ name: e.target.value });
            }}
            className="bg-transparent border-none outline-none font-semibold text-sm flex-1 min-w-0"
            placeholder="Untitled notebook"
            maxLength={120}
          />
          <span className="text-[11px] text-muted-foreground shrink-0">
            {saving ? "Saving…" : "Saved"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={runAll}>
            <PlayCircle className="h-3.5 w-3.5" /> Run all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const ok = await modal.confirm({
                title: `Delete "${nbQ.data.name}"?`,
                description: "Cells are removed with it.",
                confirmLabel: "Delete",
                destructive: true,
              });
              if (ok) del.mutate();
            }}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
        <Input
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            persist({ description: e.target.value || null });
          }}
          placeholder="Short description (optional)"
          className="text-sm"
          maxLength={500}
        />

        {cells.map((c, i) => (
          <CellBlock
            key={c.id}
            cell={c}
            index={i}
            last={i === cells.length - 1}
            run={runs[c.id]}
            onRun={() => runCell(c)}
            onMoveUp={() => move(i, -1)}
            onMoveDown={() => move(i, 1)}
            onRemove={() => removeCell(c.id)}
            onInsertBelow={(kind) => insertCell(i, kind)}
            onUpdate={(patch) => updateCell(c.id, patch)}
          />
        ))}

        {cells.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8">
            <Button variant="outline" onClick={() => insertCell(-1, "md")}>
              <FileText className="h-3.5 w-3.5" /> Add markdown cell
            </Button>
            <Button onClick={() => insertCell(-1, "sql")}>
              <Code2 className="h-3.5 w-3.5" /> Add SQL cell
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function CellBlock({
  cell,
  index,
  last,
  run,
  onRun,
  onMoveUp,
  onMoveDown,
  onRemove,
  onInsertBelow,
  onUpdate,
}: {
  cell: NotebookCell;
  index: number;
  last: boolean;
  run?: RunState;
  onRun: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onInsertBelow: (kind: "md" | "sql") => void;
  onUpdate: (patch: Partial<NotebookCell>) => void;
}) {
  const isDark = useTheme((s) => s.theme === "dark");
  const [mdPreview, setMdPreview] = useState(cell.kind === "md");

  // Always preview MD cells by default; editing toggles to raw.
  useEffect(() => {
    setMdPreview(cell.kind === "md");
  }, [cell.id, cell.kind]);

  const rendered = useMemo(
    () => (cell.kind === "md" ? renderMarkdown(cell.source) : ""),
    [cell.kind, cell.source],
  );

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-[11px] text-muted-foreground">
        <span className="font-mono">[{index + 1}]</span>
        <span className="uppercase tracking-wider">{cell.kind}</span>
        {cell.kind === "md" && (
          <button
            onClick={() => setMdPreview((v) => !v)}
            className="ml-1 text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <Eye className="h-3 w-3" />
            {mdPreview ? "Edit" : "Preview"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {cell.kind === "sql" && (
            <button
              onClick={onRun}
              disabled={run?.status === "running"}
              className="p-1 rounded hover:bg-primary/10 text-primary"
              title="Run cell"
            >
              {run?.status === "running" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button onClick={onMoveUp} disabled={index === 0} className="p-1 rounded hover:bg-accent disabled:opacity-30">
            <ArrowUp className="h-3 w-3" />
          </button>
          <button onClick={onMoveDown} disabled={last} className="p-1 rounded hover:bg-accent disabled:opacity-30">
            <ArrowDown className="h-3 w-3" />
          </button>
          <button
            onClick={onRemove}
            className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {cell.kind === "md" ? (
        mdPreview ? (
          <div
            className="prose prose-sm max-w-none dark:prose-invert p-4"
            dangerouslySetInnerHTML={{ __html: rendered }}
          />
        ) : (
          <Textarea
            value={cell.source}
            onChange={(e) => onUpdate({ source: e.target.value })}
            className="border-0 rounded-none font-mono text-sm focus-visible:ring-0"
            rows={Math.max(4, cell.source.split("\n").length + 1)}
            placeholder="Write markdown — # headings, **bold**, `code`, etc."
          />
        )
      ) : (
        <div className="h-40 border-b border-border">
          <Editor
            height="100%"
            defaultLanguage="sql"
            theme={isDark ? "vs-dark" : "vs"}
            value={cell.source}
            onChange={(v) => onUpdate({ source: v ?? "" })}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              fontFamily: "JetBrains Mono, monospace",
              tabSize: 2,
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      )}

      {cell.kind === "sql" && run && (
        <div className="border-t border-border">
          {run.status === "error" && (
            <div className="p-3 text-xs text-destructive font-mono whitespace-pre-wrap">
              {run.message}
            </div>
          )}
          {run.status === "ok" && <CellResult result={run.result} />}
          {run.status === "running" && (
            <div className="p-3 text-xs text-muted-foreground inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Running…
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-center gap-1 py-1 border-t border-border bg-background">
        <button
          onClick={() => onInsertBelow("md")}
          className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent"
        >
          <Plus className="h-3 w-3" /> <FileText className="h-3 w-3" /> Markdown
        </button>
        <button
          onClick={() => onInsertBelow("sql")}
          className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-accent"
        >
          <Plus className="h-3 w-3" /> <Code2 className="h-3 w-3" /> SQL
        </button>
      </div>
    </div>
  );
}

function CellResult({ result }: { result: QueryResult }) {
  const cols = result.fields.map((f) => f.name);
  const rowCount = result.rowCount ?? result.rows.length;
  return (
    <div>
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border">
        {rowCount} row{rowCount === 1 ? "" : "s"} · {result.durationMs}ms
      </div>
      <div className="overflow-auto max-h-80">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card z-10">
            <tr>
              {cols.map((c) => (
                <th
                  key={c}
                  className="text-left px-2 py-1 font-medium text-muted-foreground border-b border-border"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, 200).map((r, i) => (
              <tr key={i} className={cn("border-b border-border last:border-b-0")}>
                {cols.map((c) => (
                  <td key={c} className="px-2 py-1 font-mono">
                    {formatCell(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length > 200 && (
          <div className="px-3 py-1 text-[10px] text-muted-foreground">
            Showing first 200 rows.
          </div>
        )}
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
