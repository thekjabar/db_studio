import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { ArrowLeft, BookOpen, Database, Loader2, Plus, Trash2 } from "lucide-react";
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

export default function NotebooksListRoute() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const modal = useModal();
  const [dialogOpen, setDialogOpen] = useState(false);

  const nbQ = useQuery({ queryKey: ["notebooks"], queryFn: () => api.listNotebooks() });
  const connsQ = useQuery({ queryKey: ["connections"], queryFn: () => api.listConnections() });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteNotebook(id),
    onSuccess: () => {
      toast.success("Notebook deleted");
      qc.invalidateQueries({ queryKey: ["notebooks"] });
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
            <BookOpen className="h-5 w-5 text-primary" />
            Notebooks
          </div>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" /> New notebook
        </Button>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {nbQ.isLoading && <div className="text-muted-foreground">Loading...</div>}
        {nbQ.data?.length === 0 && (
          <div className="rounded-md border border-border bg-card p-10 text-center">
            <BookOpen className="h-10 w-10 text-muted-foreground mx-auto mb-2" />
            <div className="font-semibold">No notebooks yet</div>
            <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
              A notebook mixes markdown docs with SQL cells — perfect for runbooks,
              postmortem queries, or step-by-step investigations.
            </p>
            <Button className="mt-4" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> Create notebook
            </Button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {nbQ.data?.map((n) => {
            const conn = connsQ.data?.find((c) => c.id === n.connectionId);
            return (
              <div
                key={n.id}
                className="relative rounded-md border border-border bg-card p-4 hover:border-primary/40 transition-colors group"
              >
                <Link to={`/notebooks/${n.id}`} className="block">
                  <div className="font-semibold truncate">{n.name}</div>
                  {n.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {n.description}
                    </p>
                  )}
                  <div className="text-[11px] text-muted-foreground space-y-0.5 mt-2">
                    <div className="flex items-center gap-1.5">
                      <Database className="h-3 w-3" />
                      {conn?.name ?? "(unknown connection)"}
                    </div>
                    <div>Updated {format(new Date(n.updatedAt), "MMM d, HH:mm")}</div>
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await modal.confirm({
                      title: `Delete "${n.name}"?`,
                      description: "This removes the notebook and all its cells.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (ok) del.mutate(n.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 absolute top-2 right-2 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {dialogOpen && (
        <CreateNotebookDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          connections={connsQ.data ?? []}
        />
      )}
    </div>
  );
}

function CreateNotebookDialog({
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
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");

  const create = useMutation({
    mutationFn: () =>
      api.createNotebook({
        name: name.trim(),
        description: description.trim() || undefined,
        connectionId,
      }),
    onSuccess: (n) => {
      toast.success("Notebook created");
      qc.invalidateQueries({ queryKey: ["notebooks"] });
      onClose();
      nav(`/notebooks/${n.id}`);
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
          <DialogTitle>New notebook</DialogTitle>
          <DialogDescription>
            A notebook owns an ordered list of markdown + SQL cells. Pick the connection its SQL
            cells will run against — that can't be changed later.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
          </div>
          <div>
            <Label>Description (optional)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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
                {connections.map((c) => (
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
