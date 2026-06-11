import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export default function ForgotPasswordPage() {
    const [email, setEmail] = useState("");
    const [sent, setSent] = useState(false);
    const [loading, setLoading] = useState(false);
    const submit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            await api.requestPasswordReset(email);
            // Always show success — backend returns 200 regardless of account
            // existence to prevent account enumeration.
            setSent(true);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx(Link, { to: "/", "aria-label": "DB Studio home", className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: "Reset password" })] }), _jsx("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6", children: sent ? (_jsxs("div", { className: "space-y-3 text-sm", children: [_jsxs("p", { children: ["If an account exists for ", _jsx("strong", { children: email }), ", you'll get an email with a reset link shortly. It expires in 1 hour."] }), _jsx("p", { className: "text-xs text-muted-foreground", children: "Didn't get it? Check spam, or try again in a minute." }), _jsx(Button, { variant: "outline", asChild: true, className: "w-full", children: _jsx(Link, { to: "/login", children: "Back to login" }) })] })) : (_jsxs("form", { onSubmit: submit, className: "space-y-4", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Enter your email address. We'll send you a link to set a new password." }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email" }), _jsx(Input, { type: "email", required: true, autoComplete: "email", value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com" })] }), _jsxs(Button, { type: "submit", className: "w-full", disabled: loading, children: [loading && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Send reset link"] })] })) }), _jsx("p", { className: "text-center text-sm text-muted-foreground mt-4", children: _jsx(Link, { to: "/login", className: "text-primary hover:underline", children: "Back to sign in" }) })] }) }));
}
