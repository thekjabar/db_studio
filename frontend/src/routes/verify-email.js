import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Database, Loader2, XCircle } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
export default function VerifyEmailPage() {
    const [sp] = useSearchParams();
    const token = sp.get("token") ?? "";
    const nav = useNavigate();
    const [state, setState] = useState("loading");
    const [error, setError] = useState("");
    // StrictMode double-invokes effects in dev — guard against the server
    // consuming the token twice and showing an "already used" error.
    const didRun = useRef(false);
    useEffect(() => {
        if (didRun.current)
            return;
        didRun.current = true;
        if (!token) {
            setState("error");
            setError("No verification token in the URL");
            return;
        }
        api
            .verifyEmail(token)
            .then(() => setState("ok"))
            .catch((err) => {
            setState("error");
            setError(extractErrorMessage(err));
        });
    }, [token]);
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx("div", { className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: "Verify email" })] }), _jsxs("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6 text-center", children: [state === "loading" && (_jsxs(_Fragment, { children: [_jsx(Loader2, { className: "h-8 w-8 text-muted-foreground animate-spin mx-auto mb-3" }), _jsx("div", { className: "text-sm text-muted-foreground", children: "Verifying\u2026" })] })), state === "ok" && (_jsxs(_Fragment, { children: [_jsx(CheckCircle2, { className: "h-10 w-10 text-emerald-500 mx-auto mb-3" }), _jsx("div", { className: "text-sm font-medium mb-3", children: "Email verified." }), _jsx(Button, { className: "w-full", onClick: () => nav("/login", { replace: true }), children: "Sign in" })] })), state === "error" && (_jsxs(_Fragment, { children: [_jsx(XCircle, { className: "h-10 w-10 text-destructive mx-auto mb-3" }), _jsx("div", { className: "text-sm font-medium mb-1", children: "Couldn't verify" }), _jsx("div", { className: "text-xs text-muted-foreground mb-4", children: error }), _jsx(Button, { variant: "outline", className: "w-full", asChild: true, children: _jsx(Link, { to: "/login", children: "Back to login" }) })] }))] })] }) }));
}
