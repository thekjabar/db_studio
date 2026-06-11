import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { OAuthButtons } from "@/components/oauth-buttons";
export default function SignupPage() {
    const nav = useNavigate();
    const { setAuth } = useAuth();
    const [email, setEmail] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [password, setPassword] = useState("");
    const [confirm, setConfirm] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [showConfirm, setShowConfirm] = useState(false);
    const [loading, setLoading] = useState(false);
    const submit = async (e) => {
        e.preventDefault();
        if (password !== confirm) {
            toast.error("Passwords do not match");
            return;
        }
        setLoading(true);
        try {
            const r = await api.signup({ email, password, displayName: displayName || undefined });
            if ("awaitingApproval" in r && r.awaitingApproval) {
                nav("/login", { replace: true, state: { awaitingApproval: true, email } });
                return;
            }
            if ("needsVerification" in r && r.needsVerification) {
                toast.success(`We sent a verification link to ${email}. Click it to finish.`);
                nav("/login", { replace: true, state: { justSignedUp: true } });
                return;
            }
            if ("accessToken" in r) {
                setAuth(r.accessToken, r.user);
                toast.success("Account created");
                nav("/connections");
            }
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx(Link, { to: "/", "aria-label": "DB Studio home", className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: "Create account" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Get started with DB Studio" })] }), _jsxs("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6", children: [_jsxs("form", { onSubmit: submit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Display name" }), _jsx(Input, { value: displayName, onChange: (e) => setDisplayName(e.target.value), placeholder: "Jane Doe" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email" }), _jsx(Input, { type: "email", required: true, value: email, onChange: (e) => setEmail(e.target.value) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Password" }), _jsx(PasswordInput, { value: password, onChange: setPassword, show: showPassword, onToggle: () => setShowPassword((v) => !v) })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Confirm password" }), _jsx(PasswordInput, { value: confirm, onChange: setConfirm, show: showConfirm, onToggle: () => setShowConfirm((v) => !v) })] }), _jsxs(Button, { type: "submit", className: "w-full", disabled: loading, children: [loading && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Create account"] })] }), _jsx(OAuthButtons, {})] }), _jsxs("p", { className: "text-center text-sm text-muted-foreground mt-4", children: ["Already have an account?", " ", _jsx(Link, { to: "/login", className: "text-primary hover:underline", children: "Sign in" })] })] }) }));
}
function PasswordInput({ value, onChange, show, onToggle, }) {
    return (_jsxs("div", { className: "relative", children: [_jsx(Input, { type: show ? "text" : "password", required: true, value: value, onChange: (e) => onChange(e.target.value), className: "pr-9" }), _jsx("button", { type: "button", onClick: onToggle, tabIndex: -1, "aria-label": show ? "Hide password" : "Show password", className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground", children: show ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] }));
}
