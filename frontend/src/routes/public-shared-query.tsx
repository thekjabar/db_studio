import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, Database, Download, FileJson, FileSpreadsheet, FileText, Loader2, Play, Table2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { DataGrid } from "@/components/data-grid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  exportCsv as dlCsv,
  exportJson as dlJson,
  exportExcel as dlExcel,
  toMarkdownTable,
  toInsertStatements,
  copyToClipboard,
} from "@/lib/result-export";

/**
 * Public, no-login viewer for a shared read-only query. Loads the frozen SQL
 * metadata, then runs it on demand against the owner's connection (read-only,
 * row-capped, server-side). The visitor can re-run and export but never edit.
 */
export default function PublicSharedQueryRoute() {
  const { token } = useParams<{ token: string }>();

  const metaQ = useQuery({
    queryKey: ["shared-query-meta", token],
    queryFn: () => api.getSharedQueryMeta(token!),
    enabled: !!token,
    retry: false,
  });

  const run = useMutation({
    mutationFn: () => api.runSharedQuery(token!),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const result = run.data;
  const cols = result ? result.fields.map((f) => f.name) : [];

  const copyMd = async () => {
    if (!result) return;
    (await copyToClipboard(toMarkdownTable(cols, result.rows)))
      ? toast.success("Markdown copied")
      : toast.error("Copy failed");
  };
  const copyInserts = async () => {
    if (!result) return;
    (await copyToClipboard(toInsertStatements(cols, result.rows)))
      ? toast.success("INSERTs copied")
      : toast.error("Copy failed");
  };

  if (metaQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (metaQ.error) {
    return (
      <div className="min-h-screen flex items-center justify-center gradient-bg p-4">
        <div className="max-w-md text-center">
          <Database className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-1">Link unavailable</h1>
          <p className="text-sm text-muted-foreground">{extractErrorMessage(metaQ.error)}</p>
        </div>
      </div>
    );
  }

  const meta = metaQ.data!;
  return (
    <div className="min-h-screen gradient-bg flex flex-col">
      <header className="border-b border-border bg-card/60 backdrop-blur px-4 py-3 flex items-center gap-3">
        <Database className="h-5 w-5 text-primary" />
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate">
            {meta.title || "Shared query"}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {meta.connectionName} · {meta.dialect} · read-only
            {meta.expiresAt && <> · expires {new Date(meta.expiresAt).toLocaleDateString()}</>}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {result && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Download className="h-3.5 w-3.5" /> Export
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => dlCsv(cols, result.rows)}>
                  <Download className="h-3.5 w-3.5" /> Download CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => dlJson(cols, result.rows)}>
                  <FileJson className="h-3.5 w-3.5" /> Download JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => dlExcel(cols, result.rows)}>
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Download Excel
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={copyMd}>
                  <FileText className="h-3.5 w-3.5" /> Copy as Markdown
                </DropdownMenuItem>
                <DropdownMenuItem onClick={copyInserts}>
                  <Table2 className="h-3.5 w-3.5" /> Copy as INSERTs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {result ? "Re-run" : "Run query"}
          </Button>
        </div>
      </header>

      <div className="px-4 py-2 border-b border-border bg-card/30">
        <pre className="text-[11px] font-mono text-muted-foreground overflow-x-auto whitespace-pre-wrap max-h-24">
          {meta.sqlText}
        </pre>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!result && !run.isPending && (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Click “Run query” to load the data.
          </div>
        )}
        {run.isPending && (
          <div className="h-full flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Running…
          </div>
        )}
        {result && (
          <>
            <div className="px-4 py-1.5 text-[11px] text-muted-foreground border-b border-border">
              {result.rowCount} rows · {result.durationMs}ms
              {result.truncated && (
                <span className="text-amber-600 dark:text-amber-400">
                  {" "}· capped at {result.rowCount} rows
                </span>
              )}
            </div>
            <DataGrid
              columns={result.fields.map((f) => ({ name: f.name, type: f.dataType }))}
              rows={result.rows}
            />
          </>
        )}
      </div>

      <footer className="border-t border-border bg-card/40 px-4 py-2 text-center text-[11px] text-muted-foreground">
        Powered by DB Studio · read-only shared query
      </footer>
    </div>
  );
}
