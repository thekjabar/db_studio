import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { CheckCircle2, Database, Loader2, Eye, EyeOff } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export default function ResetPasswordPage() {
    const [sp] = useSearchParams();
    const token = sp.get("token") ?? "";
    const nav = useNavigate();
    const [pw, setPw] = useState("");
    const [pw2, setPw2] = useState("");
    const [showPw, setShowPw] = useState(false);
    const [showPw2, setShowPw2] = useState(false);
    const [loading, setLoading] = useState(false);
    const [done, setDone] = useState(false);
    const submit = async (e) => {
        e.preventDefault();
        if (pw.length < 8) {
            toast.error("Password must be at least 8 characters");
            return;
        }
        if (pw !== pw2) {
            toast.error("Passwords don't match");
            return;
        }
        setLoading(true);
        try {
            await api.completePasswordReset(token, pw);
            setDone(true);
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx("div", { className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: "Choose a new password" })] }), _jsx("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6", children: !token ? (_jsxs("div", { className: "text-sm text-destructive", children: ["No reset token in the URL. Request a fresh link from the", " ", _jsx(Link, { to: "/forgot-password", className: "underline", children: "forgot password page" }), "."] })) : done ? (_jsxs("div", { className: "space-y-3 text-center", children: [_jsx(CheckCircle2, { className: "h-10 w-10 text-emerald-500 mx-auto" }), _jsx("div", { className: "text-sm font-medium", children: "Password updated." }), _jsx(Button, { className: "w-full", onClick: () => nav("/login", { replace: true }), children: "Sign in" })] })) : (_jsxs("form", { onSubmit: submit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "New password" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: showPw ? "text" : "password", required: true, minLength: 8, autoComplete: "new-password", value: pw, onChange: (e) => setPw(e.target.value), placeholder: "At least 8 characters", className: "pr-9" }), _jsx("button", { type: "button", onClick: () => setShowPw((v) => !v), tabIndex: -1, "aria-label": showPw ? "Hide password" : "Show password", className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground", children: showPw ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Confirm password" }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: showPw2 ? "text" : "password", required: true, autoComplete: "new-password", value: pw2, onChange: (e) => setPw2(e.target.value), className: "pr-9" }), _jsx("button", { type: "button", onClick: () => setShowPw2((v) => !v), tabIndex: -1, "aria-label": showPw2 ? "Hide password" : "Show password", className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground", children: showPw2 ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), _jsxs(Button, { type: "submit", className: "w-full", disabled: loading, children: [loading && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Set new password"] })] })) })] }) }));
}
