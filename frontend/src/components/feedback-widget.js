import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
/**
 * Floating "Send feedback" button anchored bottom-right. Opens a Dialog
 * that POSTs to /api/feedback with the current URL as `sourcePath` so
 * operators can triage UI bugs without needing to impersonate.
 */
export function FeedbackWidget() {
    const location = useLocation();
    const [open, setOpen] = useState(false);
    const [category, setCategory] = useState("QUESTION");
    const [message, setMessage] = useState("");
    const submit = useMutation({
        mutationFn: () => api.submitFeedback({
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
    return (_jsxs(Dialog, { open: open, onOpenChange: setOpen, children: [_jsx(DialogTrigger, { asChild: true, children: _jsxs(Button, { size: "sm", variant: "outline", className: "fixed bottom-5 right-5 z-40 shadow-lg bg-card hover:bg-accent", title: "Send feedback", children: [_jsx(MessageSquarePlus, { className: "h-3.5 w-3.5" }), " Feedback"] }) }), _jsxs(DialogContent, { className: "max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Send feedback" }), _jsx(DialogDescription, { children: "Tell us what's working, what's broken, or what you'd like to see next." })] }), _jsxs("form", { onSubmit: (e) => {
                            e.preventDefault();
                            if (message.trim().length < 3)
                                return;
                            submit.mutate();
                        }, className: "space-y-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Topic" }), _jsxs(Select, { value: category, onValueChange: (v) => setCategory(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "BUG", children: "Bug" }), _jsx(SelectItem, { value: "FEATURE", children: "Feature idea" }), _jsx(SelectItem, { value: "QUESTION", children: "Question" }), _jsx(SelectItem, { value: "OTHER", children: "Other" })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Message" }), _jsx(Textarea, { rows: 5, value: message, onChange: (e) => setMessage(e.target.value), placeholder: "Your feedback\u2026", autoFocus: true })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { type: "button", variant: "outline", onClick: () => setOpen(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: submit.isPending || message.trim().length < 3, children: [submit.isPending && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Send"] })] })] })] })] }));
}
