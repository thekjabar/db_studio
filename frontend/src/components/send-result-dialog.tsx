import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  connectionId: string;
  sql: string;
}

type Target = "email" | "slack" | "webhook";

const hints: Record<Target, string> = {
  email: "Comma-separated email addresses",
  slack: "https://hooks.slack.com/services/…",
  webhook: "https://your-endpoint.example.com/hook",
};

export function SendResultDialog({ open, onClose, connectionId, sql }: Props) {
  const [target, setTarget] = useState<Target>("email");
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!to.trim()) {
      toast.error("Destination required");
      return;
    }
    if (!sql.trim()) {
      toast.error("No query to send");
      return;
    }
    setSending(true);
    try {
      const res = await api.exportResult(connectionId, {
        sql,
        target,
        to: to.trim(),
        name: name.trim() || undefined,
      });
      toast.success(`Sent ${res.rowCount} row(s)`);
      onClose();
      // Keep target + destination — likely the user will send again.
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send result</DialogTitle>
          <DialogDescription>
            Runs the current query and sends its result to the chosen destination. The query runs with your connection role.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Target</label>
            <Select value={target} onValueChange={(v) => setTarget(v as Target)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email (CSV attachment)</SelectItem>
                <SelectItem value="slack">Slack incoming webhook</SelectItem>
                <SelectItem value="webhook">HTTP webhook (JSON)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Destination</label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder={hints[target]} />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Title (optional)</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly signups"
              maxLength={200}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={send} disabled={sending}>
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
