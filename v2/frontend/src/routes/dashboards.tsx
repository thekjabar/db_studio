import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ArrowLeft, BarChart3, Database, Loader2, Plus, Trash2 } from "lucide-react";
import { api, extractErrorMessage, type Connection } from "@/lib/api";
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

export default function DashboardsListRoute() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const modal = useModal();
  const [dialogOpen, setDialogOpen] = useState(false);

  const dashQ = useQuery({ queryKey: ["dashboards"], queryFn: () => api.listDashboards() });
  const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDashboard(id),
    onSuccess: () => {
      toast.success("Dashboard deleted");
      qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => nav("/connections")}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2 font-semibold">
            <BarChart3 className="h-5 w-5 text-primary" />
            Dashboards
          </div>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" /> New dashboard
        </Button>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {dashQ.isLoading && <div className="text-muted-foreground">Loading...</div>}
        {dashQ.data?.length === 0 && (
          <div className="rounded-md border border-border bg-card p-10 text-center">
            <BarChart3 className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <div className="font-semibold">No dashboards yet</div>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              Create a dashboard to pin saved queries as charts. Auto-refresh on a timer,
              share via read-only link.
            </p>
            <Button className="mt-4" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> Create dashboard
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {dashQ.data?.map((d) => {
            const conn = connsQ.data?.find((c) => c.id === d.connectionId);
            return (
              <div
                key={d.id}
                className="rounded-md border border-border bg-card p-4 hover:border-primary/40 transition-colors group"
              >
                <Link to={`/dashboards/${d.id}`} className="block">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="font-semibold truncate flex-1">{d.name}</div>
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {d._count.tiles} tile{d._count.tiles === 1 ? "" : "s"}
                    </span>
                  </div>
                  {d.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {d.description}
                    </p>
                  )}
                  <div className="text-[11px] text-muted-foreground space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <Database className="h-3 w-3" />
                      {conn?.name ?? "(unknown connection)"}
                    </div>
                    <div>Updated {format(new Date(d.updatedAt), "MMM d, HH:mm")}</div>
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await modal.confirm({
                      title: `Delete dashboard "${d.name}"?`,
                      description: "Tiles and share link are also removed.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) del.mutate(d.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {dialogOpen && (
        <CreateDashboardDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          connections={connsQ.data ?? []}
        />
      )}
    </div>
  );
}

function CreateDashboardDialog({
  open,
  onClose,
  connections,
}: {
  open: boolean;
  onClose: () => void;
  connections: Connection[];
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [connectionId, setConnectionId] = useState<string>(connections[0]?.id ?? "");

  const sorted = useMemo(
    () => [...connections].sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );

  const create = useMutation({
    mutationFn: () =>
      api.createDashboard({
        name: name.trim(),
        description: description.trim() || undefined,
        connectionId,
      }),
    onSuccess: (d) => {
      toast.success("Dashboard created");
      qc.invalidateQueries({ queryKey: ["dashboards"] });
      onClose();
      nav(`/dashboards/${d.id}`);
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name required");
      return;
    }
    if (!connectionId) {
      toast.error("Pick a connection");
      return;
    }
    create.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New dashboard</DialogTitle>
          <DialogDescription>
            Pick a connection and give the dashboard a name. You'll add tiles (saved queries) next.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Signup funnel"
              maxLength={120}
              autoFocus
            />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this dashboard shows at a glance"
              maxLength={500}
            />
          </div>
          <div>
            <Label>Connection</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger>
                <SelectValue placeholder="Pick one" />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
