import { AlertTriangle, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ExplainPlanNode, ExplainResult, ExplainWarning, ExplainWarningSeverity } from "@/lib/api";

interface Props {
  result: ExplainResult;
}

function severityIcon(s: ExplainWarningSeverity) {
  switch (s) {
    case "warn":
      return <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />;
    case "error":
      return <AlertTriangle className="h-3.5 w-3.5 text-destructive" />;
    default:
      return <Info className="h-3.5 w-3.5 text-blue-500" />;
  }
}

function severityRowBg(s: ExplainWarningSeverity) {
  switch (s) {
    case "warn":
      return "border-amber-500/30 bg-amber-500/5";
    case "error":
      return "border-destructive/30 bg-destructive/10";
    default:
      return "border-blue-500/30 bg-blue-500/5";
  }
}

export function ExplainPanel({ result }: Props) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-4 border-b border-border px-3 py-2 text-xs">
        <div>
          <span className="text-muted-foreground">Mode:</span>{" "}
          <span className="font-medium">{result.mode === "analyze" ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
        </div>
        {result.totalCost !== undefined && (
          <div>
            <span className="text-muted-foreground">Root cost:</span>{" "}
            <span className="font-mono">{result.totalCost.toFixed(0)}</span>
          </div>
        )}
        {result.planTimeMs !== undefined && (
          <div>
            <span className="text-muted-foreground">Plan:</span>{" "}
            <span className="font-mono">{result.planTimeMs.toFixed(2)}ms</span>
          </div>
        )}
        {result.executionTimeMs !== undefined && (
          <div>
            <span className="text-muted-foreground">Exec:</span>{" "}
            <span className="font-mono">{result.executionTimeMs.toFixed(2)}ms</span>
          </div>
        )}
      </div>

      {result.warnings.length > 0 && (
        <div className="border-b border-border p-2 space-y-1">
          {result.warnings.map((w, i) => (
            <WarningRow key={i} warning={w} />
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto p-2">
        {result.nodes.length === 0 ? (
          <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">
            {typeof result.raw === "string" ? result.raw : JSON.stringify(result.raw, null, 2)}
          </pre>
        ) : (
          <ul className="space-y-1">
            {result.nodes.map((n) => (
              <PlanNodeRow key={n.id} node={n} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function WarningRow({ warning }: { warning: ExplainWarning }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded border px-2 py-1 text-xs",
        severityRowBg(warning.severity),
      )}
    >
      <div className="mt-0.5">{severityIcon(warning.severity)}</div>
      <div className="min-w-0 flex-1">
        <div>{warning.message}</div>
        {warning.nodePath && (
          <div className="text-muted-foreground font-mono truncate">{warning.nodePath}</div>
        )}
      </div>
    </div>
  );
}

function PlanNodeRow({ node }: { node: ExplainPlanNode }) {
  const hasWarning = node.warnings.length > 0;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded border border-border/50 px-2 py-1 text-xs font-mono",
        hasWarning && "bg-amber-500/5 border-amber-500/30",
      )}
      style={{ marginLeft: `${node.depth * 16}px` }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold">{node.label}</span>
          {node.totalCost !== undefined && (
            <Badge variant="secondary" className="text-[10px]">
              cost {node.totalCost.toFixed(0)}
            </Badge>
          )}
          {node.actualRows !== undefined && (
            <Badge variant="secondary" className="text-[10px]">
              actual {node.actualRows}
            </Badge>
          )}
          {node.planRows !== undefined && node.actualRows === undefined && (
            <Badge variant="secondary" className="text-[10px]">
              plan {node.planRows}
            </Badge>
          )}
          {node.actualTotalMs !== undefined && (
            <Badge variant="secondary" className="text-[10px]">
              {node.actualTotalMs.toFixed(1)}ms
            </Badge>
          )}
        </div>
        {node.warnings.map((w, i) => (
          <div key={i} className="flex items-center gap-1 mt-0.5 text-muted-foreground">
            {severityIcon(w.severity)}
            <span>{w.message}</span>
          </div>
        ))}
      </div>
    </li>
  );
}
