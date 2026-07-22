import { useState, useMemo, useRef, type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";
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
import { api, extractErrorMessage, type ColumnInfo, type CsvMapping, type CsvUploadResult, type CsvDryRunReport, type CsvCommitReport } from "@/lib/api";

type Stage = "pick" | "map" | "result";

const SKIP = "__skip__";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connectionId: string;
  schema: string;
  table: string;
  tableColumns: ColumnInfo[];
  onCommitted?: () => void;
}

export function CsvImportDialog(props: Props) {
  const { open, onOpenChange, connectionId, schema, table, tableColumns, onCommitted } = props;
  const [stage, setStage] = useState<Stage>("pick");
  const [upload, setUpload] = useState<CsvUploadResult | null>(null);
  const [mappings, setMappings] = useState<Record<string, number | null>>({});
  const [dryRun, setDryRun] = useState<CsvDryRunReport | null>(null);
  const [commitResult, setCommitResult] = useState<CsvCommitReport | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setStage("pick");
    setUpload(null);
    setMappings({});
    setDryRun(null);
    setCommitResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const close = () => {
    // Fire-and-forget session cleanup — if it fails the server will sweep it.
    if (upload && stage !== "result") {
      api.csvDiscard(connectionId, upload.sessionId).catch(() => {});
    }
    reset();
    onOpenChange(false);
  };

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadCsv(connectionId, file),
    onSuccess: (r) => {
      setUpload(r);
      // Auto-map: match headers to target columns by exact name, then lowercase.
      const byLower = new Map(tableColumns.map((c) => [c.name.toLowerCase(), c.name]));
      const next: Record<string, number | null> = {};
      for (const c of tableColumns) next[c.name] = null;
      for (let i = 0; i < r.headers.length; i++) {
        const h = r.headers[i];
        const match = byLower.get(h.toLowerCase());
        if (match) next[match] = i;
      }
      setMappings(next);
      setStage("map");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const dryRunMutation = useMutation({
    mutationFn: () =>
      api.csvDryRun(connectionId, upload!.sessionId, {
        schema,
        table,
        mappings: toApiMappings(mappings),
      }),
    onSuccess: (r) => setDryRun(r),
    onError: (e) => {
      setDryRun(null);
      toast.error(extractErrorMessage(e));
    },
  });

  const commitMutation = useMutation({
    mutationFn: (stopOnError: boolean) =>
      api.csvCommit(connectionId, upload!.sessionId, {
        schema,
        table,
        mappings: toApiMappings(mappings),
        stopOnError,
      }),
    onSuccess: (r) => {
      setCommitResult(r);
      setStage("result");
      if (r.inserted > 0) onCommitted?.();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadMutation.mutate(f);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
          <DialogDescription>
            Load rows from a CSV file into {schema}.{table}.
          </DialogDescription>
        </DialogHeader>

        {stage === "pick" && (
          <div className="py-8 flex flex-col items-center justify-center gap-3 border-2 border-dashed border-border rounded-md">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">
              Choose a CSV file to import
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={onFileChange}
              className="hidden"
              id="csv-import-file"
            />
            <label htmlFor="csv-import-file">
              <Button asChild={false} onClick={() => fileRef.current?.click()} disabled={uploadMutation.isPending}>
                {uploadMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Uploading…</>
                ) : (
                  "Pick file"
                )}
              </Button>
            </label>
            <div className="text-xs text-muted-foreground">
              Max 50MB. Must include a header row.
            </div>
          </div>
        )}

        {stage === "map" && upload && (
          <MappingStep
            upload={upload}
            tableColumns={tableColumns}
            mappings={mappings}
            onMappingChange={setMappings}
            dryRun={dryRun}
            dryRunPending={dryRunMutation.isPending}
            onDryRun={() => dryRunMutation.mutate()}
          />
        )}

        {stage === "result" && commitResult && (
          <ResultStep result={commitResult} upload={upload} />
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={close}>
            {stage === "result" ? "Close" : "Cancel"}
          </Button>
          {stage === "map" && (
            <>
              {!dryRun && (
                <Button variant="outline" onClick={() => dryRunMutation.mutate()} disabled={dryRunMutation.isPending}>
                  {dryRunMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Dry run
                </Button>
              )}
              {dryRun && (
                <Button
                  onClick={() => commitMutation.mutate(false)}
                  disabled={commitMutation.isPending || dryRun.okRows === 0}
                >
                  {commitMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Import {dryRun.okRows} rows
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toApiMappings(map: Record<string, number | null>): CsvMapping[] {
  return Object.entries(map).map(([targetColumn, csvColumn]) => ({ targetColumn, csvColumn }));
}

function MappingStep({
  upload,
  tableColumns,
  mappings,
  onMappingChange,
  dryRun,
  dryRunPending,
  onDryRun,
}: {
  upload: CsvUploadResult;
  tableColumns: ColumnInfo[];
  mappings: Record<string, number | null>;
  onMappingChange: (m: Record<string, number | null>) => void;
  dryRun: CsvDryRunReport | null;
  dryRunPending: boolean;
  onDryRun: () => void;
}) {
  // Re-run dry-run when user changes a mapping? Leave manual for now — the
  // dry-run is cheap but tapping each dropdown triggers a full re-parse pass.
  const setCol = (target: string, csvIndex: number | null) => {
    onMappingChange({ ...mappings, [target]: csvIndex });
  };

  const requiredCols = useMemo(
    () => tableColumns.filter((c) => !c.nullable && c.defaultValue == null && !c.isIdentity),
    [tableColumns],
  );
  const missingRequired = requiredCols.filter((c) => mappings[c.name] == null);

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground">
        <strong>{upload.filename}</strong> — {upload.totalRows} rows,{" "}
        {upload.headers.length} columns. Map each target column below.
      </div>

      <div className="rounded-md border border-border max-h-80 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase text-muted-foreground sticky top-0">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Target column</th>
              <th className="text-left px-3 py-2 font-medium w-48">CSV column</th>
              <th className="text-left px-3 py-2 font-medium w-48">Preview</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tableColumns.map((col) => {
              const csvIndex = mappings[col.name] ?? null;
              const required = !col.nullable && col.defaultValue == null && !col.isIdentity;
              return (
                <tr key={col.name}>
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {col.name}
                      {required && <span className="text-destructive"> *</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{col.dataType}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      value={csvIndex === null ? SKIP : String(csvIndex)}
                      onValueChange={(v) => setCol(col.name, v === SKIP ? null : parseInt(v, 10))}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SKIP}>— skip —</SelectItem>
                        {upload.headers.map((h, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {h || `(col ${i + 1})`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground font-mono truncate max-w-xs">
                    {csvIndex !== null
                      ? upload.sample
                          .slice(0, 3)
                          .map((r) => r[upload.headers[csvIndex]] ?? "")
                          .filter(Boolean)
                          .join(" · ")
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missingRequired.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            Required columns not yet mapped:{" "}
            <span className="font-mono">{missingRequired.map((c) => c.name).join(", ")}</span>
          </div>
        </div>
      )}

      {dryRun && (
        <div
          className={
            dryRun.errorRows.length === 0
              ? "rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs"
              : "rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs"
          }
        >
          <div className="flex items-center gap-2 font-medium">
            {dryRun.errorRows.length === 0 ? (
              <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Dry run passed</>
            ) : (
              <><AlertTriangle className="h-4 w-4 text-amber-600" /> Dry run found errors</>
            )}
          </div>
          <div className="mt-1 text-muted-foreground">
            {dryRun.okRows} / {dryRun.totalRows} rows would be inserted.
            {dryRun.errorRows.length > 0 && ` ${dryRun.errorRows.length} error rows (showing first 5):`}
          </div>
          {dryRun.errorRows.length > 0 && (
            <ul className="mt-2 space-y-1 font-mono">
              {dryRun.errorRows.slice(0, 5).map((e) => (
                <li key={e.rowIndex}>
                  row {e.rowIndex + 1}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {dryRun && !dryRunPending && (
        <div className="text-xs text-muted-foreground">
          Mapping changed?{" "}
          <button type="button" className="underline hover:text-foreground" onClick={onDryRun}>
            Re-run dry run
          </button>
        </div>
      )}
    </div>
  );
}

function ResultStep({
  result,
  upload,
}: {
  result: CsvCommitReport;
  upload: CsvUploadResult | null;
}) {
  const total = (upload?.totalRows ?? 0);
  return (
    <div className="py-4 space-y-3">
      <div className="flex items-center gap-2 text-lg font-semibold">
        {result.failed.length === 0 ? (
          <><CheckCircle2 className="h-6 w-6 text-emerald-600" /> Import complete</>
        ) : (
          <><AlertTriangle className="h-6 w-6 text-amber-600" /> Import finished with errors</>
        )}
      </div>
      <div className="text-sm">
        Inserted <strong>{result.inserted}</strong> of <strong>{total}</strong> rows in{" "}
        {result.durationMs}ms.
      </div>
      {result.failed.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <div className="font-medium mb-1">{result.failed.length} rows failed (first 5):</div>
          <ul className="space-y-1 font-mono">
            {result.failed.slice(0, 5).map((e) => (
              <li key={e.rowIndex}>
                row {e.rowIndex + 1}: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
