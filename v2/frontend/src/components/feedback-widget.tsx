import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Category = "BUG" | "FEATURE" | "QUESTION" | "OTHER";

/**
 * Floating "Send feedback" button anchored bottom-right. Opens a Dialog
 * that POSTs to /api/feedback with the current URL as `sourcePath` so
 * operators can triage UI bugs without needing to impersonate.
 */
export function FeedbackWidget() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category>("QUESTION");
  const [message, setMessage] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      api.submitFeedback({
        message: message.trim(),
        category,
        sourcePath: location.pathname + location.search,
      }),
    onSuccess: () => {
      toast.success("Thanks — we got your feedback.");
      setOpen(false);
      setMessage("");
      setCategory("QUESTION");
    },
    onError: () => {
      toast.error("Could not send feedback. Please try again.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="fixed bottom-5 right-5 z-40 shadow-lg bg-card hover:bg-accent"
          title="Send feedback"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Feedback
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Tell us what's working, what's broken, or what you'd like to see next.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (message.trim().length < 3) return;
            submit.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Topic</Label>
            <Select value={category} onValueChange={(v: Category) => setCategory(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="BUG">Bug</SelectItem>
                <SelectItem value="FEATURE">Feature idea</SelectItem>
                <SelectItem value="QUESTION">Question</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Message</Label>
            <Textarea
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Your feedback…"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submit.isPending || message.trim().length < 3}>
              {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
