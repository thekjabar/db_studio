import * as React from "react";
import Editor from "@monaco-editor/react";
import { ChevronRight, Home } from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme-store";

interface Props {
  open: boolean;
  fieldName: string;
  /** The current value. Can be any JSON-compatible value, or a raw string for invalid/legacy data. */
  value: unknown;
  onClose: () => void;
  /** Called with the parsed value on save. Rejects if JSON invalid. */
  onSave: (next: unknown) => Promise<void> | void;
}

type Mode = "edit" | "view";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function valueAt(root: unknown, path: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[key as number];
    else if (isObject(cur)) cur = cur[key as string];
    else return undefined;
  }
  return cur;
}

/** Normalize the incoming value: if it's a string that parses as JSON, use the parsed form. */
function normalize(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  if (!/^[\[{"]/.test(trimmed) && !/^(true|false|-?\d)/.test(trimmed)) return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    return v;
  }
}

function toPretty(v: unknown): string {
  const n = normalize(v);
  try {
    return JSON.stringify(n ?? null, null, 2);
  } catch {
    return String(n ?? "");
  }
}

export function JsonFieldEditor({ open, fieldName, value, onClose, onSave }: Props) {
  const isDark = useTheme((s) => s.theme === "dark");
  const [mode, setMode] = React.useState<Mode>("view");
  const [text, setText] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [path, setPath] = React.useState<(string | number)[]>([]);

  // Initialise the editor text and reset path when the sheet opens.
  React.useEffect(() => {
    if (!open) return;
    setText(toPretty(value));
    setPath([]);
    setMode("edit");
    setError(null);
  }, [open, value]);

  // View-mode needs the live parsed tree. We parse from text in edit mode so
  // the view tab reflects unsaved edits too.
  const parsed = React.useMemo<{ ok: true; value: unknown } | { ok: false; error: string }>(() => {
    try {
      if (text.trim() === "") return { ok: true, value: null };
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, [text]);

  const save = async () => {
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(parsed.value);
      onClose();
    } catch (e) {
      setError((e as Error).message || "Failed to save");
    } finally {
      setBusy(false);
    }
  };

  const format = () => {
    if (!parsed.ok) return;
    setText(JSON.stringify(parsed.value, null, 2));
  };

  // --- View tab helpers ---
  const current = parsed.ok ? valueAt(parsed.value, path) : undefined;

  const breadcrumbs = (
    <div className="flex items-center gap-1 text-xs border-b border-border px-3 py-2 bg-muted/30">
      <button
        type="button"
        onClick={() => setPath([])}
        className={cn(
          "p-1 rounded hover:bg-accent",
          path.length === 0 ? "text-foreground" : "text-muted-foreground",
        )}
        title="Root"
      >
        <Home className="h-3.5 w-3.5" />
      </button>
      {path.map((seg, i) => (
        <React.Fragment key={i}>
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <button
            type="button"
            onClick={() => setPath(path.slice(0, i + 1))}
            className={cn(
              "font-mono px-1.5 py-0.5 rounded hover:bg-accent",
              i === path.length - 1 ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {String(seg)}
          </button>
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <SheetContent width="w-[780px]">
        <SheetHeader className="flex items-center justify-between flex-row pr-14">
          <SheetTitle>
            {mode === "edit" ? "Editing" : "Viewing"} JSON Field:{" "}
            <code className="font-mono text-primary">{fieldName}</code>
          </SheetTitle>
          <div className="flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setMode("edit")}
              className={cn(
                "px-3 py-1 text-xs font-medium",
                mode === "edit" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
              )}
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setMode("view")}
              className={cn(
                "px-3 py-1 text-xs font-medium border-l border-border",
                mode === "view" ? "bg-primary text-primary-foreground" : "bg-card hover:bg-accent",
              )}
            >
              View
            </button>
          </div>
        </SheetHeader>

        {mode === "edit" ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              <Editor
                height="100%"
                defaultLanguage="json"
                theme={isDark ? "vs-dark" : "vs"}
                value={text}
                onChange={(v) => setText(v ?? "")}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  fontFamily: "JetBrains Mono, monospace",
                  tabSize: 2,
                  automaticLayout: true,
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                }}
              />
            </div>
            <div className="border-t border-border px-3 py-2 flex items-center justify-between text-xs">
              <div className="text-muted-foreground">
                {parsed.ok ? (
                  <span className="text-emerald-400">Valid JSON</span>
                ) : (
                  <span className="text-destructive">Invalid: {parsed.error}</span>
                )}
              </div>
              <Button size="sm" variant="outline" onClick={format} disabled={!parsed.ok}>
                Format
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            {breadcrumbs}
            <SheetBody className="py-0 px-0">
              {!parsed.ok ? (
                <div className="p-6 text-sm text-destructive">Invalid JSON: {parsed.error}</div>
              ) : (
                <ViewPane value={current} onDrillIn={(seg) => setPath([...path, seg])} />
              )}
            </SheetBody>
          </div>
        )}

        {error && (
          <div className="mx-6 mb-2 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs px-3 py-2">
            {error}
          </div>
        )}

        <SheetFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || !parsed.ok}>
            Save changes
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ViewPane({
  value,
  onDrillIn,
}: {
  value: unknown;
  onDrillIn: (seg: string | number) => void;
}) {
  // Leaf: render as single line
  if (value === null || value === undefined) {
    return <div className="p-6 text-sm text-muted-foreground italic">null</div>;
  }
  if (typeof value !== "object") {
    return (
      <div className="p-6">
        <ScalarValue v={value} />
      </div>
    );
  }

  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v] as const)
    : Object.entries(value);

  // Split into navigable (object/array children) and primitive leaves.
  const objectEntries = entries.filter(([, v]) => v !== null && typeof v === "object");
  const leafEntries = entries.filter(([, v]) => v === null || typeof v !== "object");

  return (
    <div className="grid grid-cols-[minmax(180px,260px)_1fr] h-full">
      {/* Left: object/array children */}
      <div className="border-r border-border overflow-y-auto py-1">
        {objectEntries.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted-foreground italic">No nested objects</div>
        ) : (
          objectEntries.map(([k]) => (
            <button
              key={String(k)}
              type="button"
              onClick={() => onDrillIn(k)}
              className="w-full flex items-center justify-between gap-2 px-4 py-2 text-xs text-sky-400 hover:bg-accent/60 transition-colors"
            >
              <span className="font-mono truncate">{String(k)}</span>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          ))
        )}
      </div>
      {/* Right: leaf values at this level */}
      <div className="overflow-y-auto py-2 px-4">
        {leafEntries.length === 0 ? (
          <div className="text-xs text-muted-foreground pt-2">No data available</div>
        ) : (
          <div className="space-y-1.5">
            {leafEntries.map(([k, v]) => (
              <div key={String(k)} className="flex items-start gap-2 text-xs font-mono">
                <span className="text-muted-foreground">{String(k)}:</span>
                <ScalarValue v={v} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ScalarValue({ v }: { v: unknown }) {
  if (v === null) return <span className="text-muted-foreground italic">null</span>;
  if (typeof v === "boolean") return <span className="text-emerald-400">{String(v)}</span>;
  if (typeof v === "number") return <span className="text-sky-400">{String(v)}</span>;
  if (typeof v === "string") return <span className="text-amber-400">"{v}"</span>;
  return <span className="text-muted-foreground">{JSON.stringify(v)}</span>;
}
