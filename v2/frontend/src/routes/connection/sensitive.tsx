import { useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ScanSearch, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useModal } from "@/components/modal-provider";

type Finding = Awaited<ReturnType<typeof api.scanSensitive>>["findings"][number];

/**
 * Sensitive-data scanner: heuristically flags likely-PII columns (emails,
 * phones, passwords, card numbers…) so the owner can mask them for specific
 * team members. Pairs with the existing column-masks feature — "Mask" creates
 * a mask right from a finding.
 */
export default function SensitiveScanRoute() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const modal = useModal();
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [tablesScanned, setTablesScanned] = useState(0);

  const masksQ = useQuery({
    queryKey: ["column-masks", id],
    queryFn: () => api.listColumnMasks(id!),
    enabled: !!id,
  });
  const membersQ = useQuery({
    queryKey: ["conn-members", id],
    queryFn: () => api.listConnectionMembers(id!),
    enabled: !!id,
  });

  const scan = useMutation({
    mutationFn: () => api.scanSensitive(id!),
    onSuccess: (r) => {
      setFindings(r.findings);
      setTablesScanned(r.tablesScanned);
      toast.success(`Scanned ${r.tablesScanned} tables — ${r.findings.length} potential finding(s)`);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const isMasked = (f: Finding) =>
    (masksQ.data ?? []).some(
      (m) => m.schemaName === f.schema && m.tableName === f.table && m.columnName === f.column,
    );

  const maskFinding = async (f: Finding) => {
    const members = membersQ.data ?? [];
    if (members.length === 0) {
      toast.error("Add a connection member first — masks apply per member.");
      return;
    }
    const email = await modal.select({
      title: `Mask ${f.table}.${f.column} for…`,
      description: "The selected member will see this column masked.",
      options: members.map((m) => ({ value: m.email, label: m.email })),
    });
    if (!email) return;
    try {
      await api.createColumnMask(id!, {
        email,
        schemaName: f.schema,
        tableName: f.table,
        columnName: f.column,
      });
      toast.success("Column mask created");
      qc.invalidateQueries({ queryKey: ["column-masks", id] });
    } catch (e) {
      toast.error(extractErrorMessage(e));
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 sticky top-0 bg-background z-10">
        <ScanSearch className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Sensitive data scanner</div>
        <div className="ml-auto">
          <Button size="sm" onClick={() => scan.mutate()} disabled={scan.isPending}>
            {scan.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {findings ? "Re-scan" : "Scan now"}
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-4 space-y-4">
        <p className="text-xs text-muted-foreground">
          Scans column names and types for likely PII — emails, phones, passwords, national IDs,
          payment cards. Findings are heuristic: review each before masking. Masks apply per team
          member via the existing column-mask feature. Introspection only — no row data is read.
        </p>

        {!findings && !scan.isPending && (
          <div className="rounded-md border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Click <strong>Scan now</strong> to analyze this connection's schema.
          </div>
        )}

        {findings && findings.length === 0 && (
          <div className="rounded-md border border-border p-8 text-center">
            <ShieldCheck className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
            <div className="text-sm font-medium">No likely-sensitive columns found</div>
            <div className="text-xs text-muted-foreground mt-1">{tablesScanned} tables scanned.</div>
          </div>
        )}

        {findings && findings.length > 0 && (
          <div className="rounded-md border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">Column</th>
                  <th className="px-3 py-2 font-medium">Looks like</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Confidence</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-mono text-xs">
                      {f.table}.<span className="text-foreground font-semibold">{f.column}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={f.kind === "password" || f.kind === "secret/token" ? "destructive" : "secondary"}>
                        <ShieldAlert className="h-3 w-3 mr-1" /> {f.kind}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{f.dataType}</td>
                    <td className="px-3 py-2 text-xs">{f.confidence}</td>
                    <td className="px-3 py-2 text-right">
                      {isMasked(f) ? (
                        <Badge variant="outline" className="text-emerald-500 border-emerald-500/30">Masked</Badge>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => maskFinding(f)}>
                          Mask…
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
