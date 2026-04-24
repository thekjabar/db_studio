import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  BarChart3,
  Copy,
  Edit2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import {
  api,
  extractErrorMessage,
  type ChartConfig,
  type Dashboard,
  type DashboardTile,
  type QueryResult,
  type SavedQuery,
} from "@/lib/api";
import { QueryChart } from "@/components/query-chart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useModal } from "@/components/modal-provider";

const REFRESH_PRESETS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "30 s", value: 30 },
  { label: "1 min", value: 60 },
  { label: "5 min", value: 300 },
  { label: "15 min", value: 900 },
];

export default function DashboardDetailRoute() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const modal = useModal();
  const [addTileOpen, setAddTileOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const dashQ = useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => api.getDashboard(id!),
    enabled: !!id,
  });

  const del = useMutation({
    mutationFn: () => api.deleteDashboard(id!),
    onSuccess: () => {
      toast.success("Deleted");
      nav("/dashboards");
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const setRefresh = useMutation({
    mutationFn: (refreshSec: number | null) =>
      api.updateDashboard(id!, { refreshSec }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", id] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const removeTile = useMutation({
    mutationFn: (tileId: string) => api.removeDashboardTile(id!, tileId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dashboard", id] }),
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const d = dashQ.data;

  if (dashQ.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!d) {
    return <div className="p-8 text-destructive">Dashboard not found.</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => nav("/dashboards")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div className="h-4 w-px bg-border shrink-0" />
          <BarChart3 className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="font-semibold truncate">{d.name}</div>
            {d.description && (
              <div className="text-[11px] text-muted-foreground truncate">{d.description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setRenameOpen(true)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Edit name/description"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Select
            value={String(d.refreshSec ?? "null")}
            onValueChange={(v) => setRefresh.mutate(v === "null" ? null : Number(v))}
          >
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REFRESH_PRESETS.map((p) => (
                <SelectItem key={String(p.value)} value={String(p.value ?? "null")}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
            <Share2 className="h-3.5 w-3.5" /> Share
          </Button>
          <Button size="sm" onClick={() => setAddTileOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add tile
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const ok = await modal.confirm({
                title: `Delete "${d.name}"?`,
                description: "Tiles and share link are also removed.",
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

      <div className="p-6">
        {d.tiles.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-10 text-center max-w-xl mx-auto">
            <BarChart3 className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <div className="font-semibold">No tiles yet</div>
            <p className="text-sm text-muted-foreground mt-1">
              Pin a saved query as a tile. Use the <strong>Save</strong> button in the SQL editor
              first to create saved queries against this connection.
            </p>
            <Button className="mt-4" onClick={() => setAddTileOpen(true)}>
              <Plus className="h-4 w-4" /> Add tile
            </Button>
          </div>
        )}

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}
        >
          {d.tiles.map((t) => (
            <TileCard
              key={t.id}
              dashboardId={d.id}
              tile={t}
              refreshSec={d.refreshSec ?? null}
              onRemove={() => removeTile.mutate(t.id)}
            />
          ))}
        </div>
      </div>

      {addTileOpen && (
        <AddTileDialog
          open={addTileOpen}
          onClose={() => setAddTileOpen(false)}
          dashboard={d}
        />
      )}
      {renameOpen && (
        <RenameDialog open={renameOpen} onClose={() => setRenameOpen(false)} dashboard={d} />
      )}
      {shareOpen && (
        <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} dashboard={d} />
      )}
    </div>
  );
}

function TileCard({
  dashboardId,
  tile,
  refreshSec,
  onRemove,
}: {
  dashboardId: string;
  tile: DashboardTile;
  refreshSec: number | null;
  onRemove: () => void;
}) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const runRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const chart: ChartConfig | null = (tile.chartOverride ?? tile.savedQuery.chartConfig) as ChartConfig | null;

  runRef.current = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.runDashboardTile(dashboardId, tile.id);
      setResult(r);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // Initial run + polling.
  useEffect(() => {
    void runRef.current();
    if (!refreshSec) return;
    const iv = setInterval(() => void runRef.current(), refreshSec * 1000);
    return () => clearInterval(iv);
  }, [refreshSec, tile.id]);

  return (
    <div
      className="rounded-md border border-border bg-card overflow-hidden flex flex-col"
      style={{ gridColumn: `span ${tile.w} / span ${tile.w}`, minHeight: tile.h * 60 + 60 }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="text-sm font-medium truncate">
          {tile.title ?? tile.savedQuery.name}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground p-1"
            onClick={() => void runRef.current()}
            title="Refresh now"
            disabled={loading}
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:text-destructive p-1"
            onClick={onRemove}
            title="Remove tile"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-2">
        {error && <div className="p-3 text-xs text-destructive">{error}</div>}
        {!error && !result && loading && (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!error && result && chart && <QueryChart config={chart} rows={result.rows} height={tile.h * 60} />}
        {!error && result && !chart && <TileTable result={result} maxHeight={tile.h * 60 + 40} />}
      </div>
    </div>
  );
}

function TileTable({ result, maxHeight }: { result: QueryResult; maxHeight: number }) {
  const cols = result.fields.map((f) => f.name);
  return (
    <div className="overflow-auto text-xs" style={{ maxHeight }}>
      <table className="w-full">
        <thead className="sticky top-0 bg-card">
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
            <tr key={i} className="border-b border-border last:border-b-0">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 font-mono">
                  {formatCell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function AddTileDialog({
  open,
  onClose,
  dashboard,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: Dashboard;
}) {
  const qc = useQueryClient();
  const [savedQueryId, setSavedQueryId] = useState("");
  const [title, setTitle] = useState("");
  const [width, setWidth] = useState(6);
  const [height, setHeight] = useState(4);

  const savedQ = useQuery({
    queryKey: ["saved-queries", dashboard.connectionId],
    queryFn: () => api.listSavedQueries(dashboard.connectionId),
  });

  const add = useMutation({
    mutationFn: () =>
      api.addDashboardTile(dashboard.id, {
        savedQueryId,
        title: title.trim() || undefined,
        w: width,
        h: height,
      }),
    onSuccess: () => {
      toast.success("Tile added");
      qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
      onClose();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const available = (savedQ.data ?? []) as SavedQuery[];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add tile</DialogTitle>
          <DialogDescription>
            Pick a saved query. To create one, open the SQL editor on this connection and click
            Save.
          </DialogDescription>
        </DialogHeader>
        {available.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4">
            No saved queries on this connection yet.{" "}
            <Link
              to={`/c/${dashboard.connectionId}/sql`}
              className="text-primary hover:underline"
              onClick={onClose}
            >
              Open SQL editor
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label>Saved query</Label>
              <Select value={savedQueryId} onValueChange={setSavedQueryId}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a saved query" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((q) => (
                    <SelectItem key={q.id} value={q.id}>
                      {q.name}
                      {q.chartConfig ? ` (${q.chartConfig.type})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Title override (optional)</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Defaults to the saved query's name"
                maxLength={120}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Width (1–12)</Label>
                <Input
                  type="number"
                  min={1}
                  max={12}
                  value={width}
                  onChange={(e) => setWidth(Math.max(1, Math.min(12, Number(e.target.value))))}
                />
              </div>
              <div>
                <Label>Height (1–20)</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={height}
                  onChange={(e) => setHeight(Math.max(1, Math.min(20, Number(e.target.value))))}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!savedQueryId) {
                toast.error("Pick a saved query");
                return;
              }
              add.mutate();
            }}
            disabled={add.isPending || !savedQueryId}
          >
            {add.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onClose,
  dashboard,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: Dashboard;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(dashboard.name);
  const [description, setDescription] = useState(dashboard.description ?? "");

  const save = useMutation({
    mutationFn: () =>
      api.updateDashboard(dashboard.id, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      toast.success("Saved");
      onClose();
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit dashboard</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div>
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialog({
  open,
  onClose,
  dashboard,
}: {
  open: boolean;
  onClose: () => void;
  dashboard: Dashboard;
}) {
  const qc = useQueryClient();
  const [token, setToken] = useState(dashboard.shareToken);

  const publicUrl = useMemo(
    () => (token ? `${window.location.origin}/d/${token}` : null),
    [token],
  );

  const rotate = useMutation({
    mutationFn: (share: boolean) => api.shareDashboard(dashboard.id, share),
    onSuccess: (r) => {
      setToken(r.shareToken);
      qc.invalidateQueries({ queryKey: ["dashboard", dashboard.id] });
      qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const copy = async () => {
    if (!publicUrl) return;
    await navigator.clipboard.writeText(publicUrl);
    toast.success("Link copied");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share dashboard</DialogTitle>
          <DialogDescription>
            Anyone with the link can view this dashboard without signing in. Tiles run with viewer
            role; no destructive SQL is allowed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {publicUrl ? (
            <>
              <div className="flex items-center gap-2">
                <Input value={publicUrl} readOnly className="font-mono text-xs" />
                <Button size="sm" variant="outline" onClick={copy}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => rotate.mutate(true)}
                  disabled={rotate.isPending}
                >
                  <Edit2 className="h-3.5 w-3.5" /> Rotate link
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => rotate.mutate(false)}
                  disabled={rotate.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  Revoke
                </Button>
              </div>
            </>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-3">
                No share link yet. Enable it to get a public URL.
              </p>
              <Button onClick={() => rotate.mutate(true)} disabled={rotate.isPending}>
                {rotate.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Enable sharing
              </Button>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
