import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Send } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, extractErrorMessage } from "@/lib/api";
const hints = {
    email: "Comma-separated email addresses",
    slack: "https://hooks.slack.com/services/…",
    webhook: "https://your-endpoint.example.com/hook",
};
export function SendResultDialog({ open, onClose, connectionId, sql }) {
    const [target, setTarget] = useState("email");
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
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setSending(false);
        }
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (o) => !o && onClose(), children: _jsxs(DialogContent, { className: "sm:max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Send result" }), _jsx(DialogDescription, { children: "Runs the current query and sends its result to the chosen destination. The query runs with your connection role." })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Target" }), _jsxs(Select, { value: target, onValueChange: (v) => setTarget(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "email", children: "Email (CSV attachment)" }), _jsx(SelectItem, { value: "slack", children: "Slack incoming webhook" }), _jsx(SelectItem, { value: "webhook", children: "HTTP webhook (JSON)" })] })] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Destination" }), _jsx(Input, { value: to, onChange: (e) => setTo(e.target.value), placeholder: hints[target] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Title (optional)" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), placeholder: "e.g. Weekly signups", maxLength: 200 })] })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "ghost", onClick: onClose, disabled: sending, children: "Cancel" }), _jsxs(Button, { onClick: send, disabled: sending, children: [sending ? _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }) : _jsx(Send, { className: "h-3.5 w-3.5" }), "Send"] })] })] }) }));
}
