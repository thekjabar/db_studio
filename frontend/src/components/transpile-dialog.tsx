import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ArrowRightLeft, Check, Info, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, extractErrorMessage, type Dialect, type TranspileResult } from "@/lib/api";

const DIALECTS: { value: Dialect; label: string }[] = [
  { value: "POSTGRES", label: "PostgreSQL" },
  { value: "MYSQL", label: "MySQL" },
  { value: "SQLITE", label: "SQLite" },
  { value: "MSSQL", label: "SQL Server" },
];

interface Props {
  open: boolean;
  connectionId: string;
  sourceDialect: Dialect;
  sql: string;
  onOpenChange: (open: boolean) => void;
  onApply: (sql: string) => void;
}

/**
 * Convert the current SQL to another dialect. Parses with a real AST in the
 * source dialect, regenerates in the target, and surfaces correctness warnings
 * for constructs whose semantics may not survive translation. "Apply" replaces
 * the editor content; the user always reviews the output and warnings first.
 */
export function TranspileDialog({ open, connectionId, sourceDialect, sql, onOpenChange, onApply }: Props) {
  const [to, setTo] = useState<Dialect>(sourceDialect === "POSTGRES" ? "MYSQL" : "POSTGRES");
  const [result, setResult] = useState<TranspileResult | null>(null);

  const convert = useMutation({
    mutationFn: () => api.transpile(connectionId, { sql, to }),
    onSuccess: (r) => setResult(r),
    onError: (e) => {
      setResult(null);
      toast.error(extractErrorMessage(e));
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setResult(null);
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4" /> Convert SQL dialect
          </DialogTitle>
          <DialogDescription>
            Parse the query in its source dialect and regenerate it for another engine. Review the
            output and any warnings before applying — semantics can differ.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-3">
          <div className="space-y-1.5">
            <Label>From</Label>
            <div className="h-9 px-3 flex items-center rounded-md border border-border bg-muted text-sm text-muted-foreground">
              {DIALECTS.find((d) => d.value === sourceDialect)?.label ?? sourceDialect}
            </div>
          </div>
          <ArrowRightLeft className="h-4 w-4 mb-2.5 text-muted-foreground" />
          <div className="space-y-1.5 flex-1">
            <Label>To</Label>
            <Select value={to} onValueChange={(v) => setTo(v as Dialect)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIALECTS.filter((d) => d.value !== sourceDialect).map((d) => (
                  <SelectItem key={d.value} value={d.value}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => convert.mutate()} disabled={convert.isPending}>
            {convert.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Convert"}
          </Button>
        </div>

        {result && (
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Converted SQL</Label>
              <pre className="mt-1 text-xs font-mono bg-muted rounded-md p-3 whitespace-pre-wrap max-h-60 overflow-auto">
                {result.sql}
              </pre>
            </div>

            {result.warnings.length > 0 && (
              <div className="space-y-1.5">
                {result.warnings.map((w, i) => (
                  <div
                    key={i}
                    className={
                      "flex items-start gap-2 text-xs rounded-md px-2.5 py-1.5 " +
                      (w.severity === "warn"
                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        : "bg-muted text-muted-foreground")
                    }
                  >
                    {w.severity === "warn" ? (
                      <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    ) : (
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    )}
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}
            {result.warnings.length === 0 && (
              <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                <Check className="h-3.5 w-3.5" /> No portability warnings detected.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!result}
            onClick={() => {
              if (result) {
                onApply(result.sql);
                onOpenChange(false);
                setResult(null);
                toast.success("SQL replaced with converted query");
              }
            }}
          >
            Apply to editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
