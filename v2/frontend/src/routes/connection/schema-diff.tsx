import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, GitCompare, Loader2, Play } from "lucide-react";
import { api, extractErrorMessage, type SchemaDiff } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Structural diff between two connections: does staging still match production?
 *
 * The sibling "Compare results" page diffs the ROWS two queries return. This
 * one diffs the shape — tables, columns, and index definitions — which is the
 * question asked before a release, not after.
 */
export default function SchemaDiffRoute() {
  const { id } = useParams<{ id: string }>();
  const [target, setTarget] = useState("");
  const [schema, setSchema] = useState("public");
  const [diff, setDiff] = useState<SchemaDiff | null>(null);

  const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });
  const schemasQ = useQuery({
    queryKey: ["schemas", id],
    queryFn: () => api.listSchemas(id!),
    enabled: !!id,
  });

  const run = useMutation({
    mutationFn: () => api.schemaDiff(id!, target, schema),
    onSuccess: (d) => {
      setDiff(d);
      if (d.identical) toast.success(`No differences in "${d.schema}"`);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const here = connsQ.data?.find((c) => c.id === id);
  const there = connsQ.data?.find((c) => c.id === target);
  const others = (connsQ.data ?? []).filter((c) => c.id !== id);

  return (
    <div className="p-4 space-y-4 overflow-auto">
      <div className="flex items-center gap-2">
        <GitCompare className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Compare schema</h2>
        <span className="text-xs text-muted-foreground">
          Tables, columns and indexes — read-only, nothing is changed on either side.
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <div className="space-y-1">
          <Label className="text-xs">This connection (A)</Label>
          <div className="h-9 flex items-center rounded-md border border-border bg-muted/40 px-3 text-sm">
            {here?.name ?? "…"}
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Compare with (B)</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Pick a connection…" />
            </SelectTrigger>
            <SelectContent>
              {others.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Schema</Label>
          <Select value={schema} onValueChange={setSchema}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(schemasQ.data ?? ["public"]).map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => run.mutate()} disabled={!target || run.isPending} size="sm">
          {run.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Compare
        </Button>
      </div>

      {diff && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">
              A: {here?.name} · {diff.counts.a} tables
            </Badge>
            <Badge variant="outline">
              B: {there?.name} · {diff.counts.b} tables
            </Badge>
            <span>schema “{diff.schema}”</span>
          </div>

          {diff.identical ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4 text-sm">
              <Check className="h-4 w-4 text-primary" />
              The two schemas are identical — same tables, same columns, same indexes.
            </div>
          ) : (
            <>
              <OnlyIn title={`Only in A (${here?.name ?? "A"})`} tables={diff.tablesOnlyInA} />
              <OnlyIn title={`Only in B (${there?.name ?? "B"})`} tables={diff.tablesOnlyInB} />

              {diff.tablesChanged.map((t) => (
                <div key={t.table} className="rounded-lg border border-border bg-card">
                  <div className="border-b border-border px-3 py-2 font-mono text-sm">{t.table}</div>
                  <div className="divide-y divide-border text-xs">
                    {t.columnsOnlyInA.map((c) => (
                      <Row key={`a-${c.name}`} tone="a" label={`column ${c.name}`}>
                        only in A — {c.a?.type}
                        {c.a && !c.a.nullable ? " NOT NULL" : ""}
                      </Row>
                    ))}
                    {t.columnsOnlyInB.map((c) => (
                      <Row key={`b-${c.name}`} tone="b" label={`column ${c.name}`}>
                        only in B — {c.b?.type}
                        {c.b && !c.b.nullable ? " NOT NULL" : ""}
                      </Row>
                    ))}
                    {t.columnsChanged.map((c) => (
                      <Row key={`c-${c.name}`} tone="change" label={`column ${c.name}`}>
                        <span className="font-mono">{describe(c.a)}</span>
                        <span className="mx-2 text-muted-foreground">→</span>
                        <span className="font-mono">{describe(c.b)}</span>
                      </Row>
                    ))}
                    {t.indexesOnlyInA.map((i) => (
                      <Row key={`ia-${i.name}`} tone="a" label={`index ${i.name}`}>
                        only in A
                      </Row>
                    ))}
                    {t.indexesOnlyInB.map((i) => (
                      <Row key={`ib-${i.name}`} tone="b" label={`index ${i.name}`}>
                        only in B
                      </Row>
                    ))}
                    {t.indexesChanged.map((i) => (
                      <Row key={`ic-${i.name}`} tone="change" label={`index ${i.name}`}>
                        <span className="block font-mono text-[11px]">A: {i.a}</span>
                        <span className="block font-mono text-[11px]">B: {i.b}</span>
                      </Row>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function describe(c?: { type: string; nullable: boolean; default: string | null } | null) {
  if (!c) return "—";
  return `${c.type}${c.nullable ? "" : " NOT NULL"}${c.default ? ` DEFAULT ${c.default}` : ""}`;
}

function OnlyIn({ title, tables }: { title: string; tables: string[] }) {
  if (tables.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-sm font-medium">
        {title} · {tables.length}
      </div>
      <div className="flex flex-wrap gap-1.5 p-3">
        {tables.map((t) => (
          <span key={t} className="rounded bg-muted px-2 py-0.5 font-mono text-xs">
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "a" | "b" | "change";
  children: React.ReactNode;
}) {
  const dot =
    tone === "a"
      ? "bg-amber-500"
      : tone === "b"
        ? "bg-sky-500"
        : "bg-primary";
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="w-56 shrink-0 font-mono text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
