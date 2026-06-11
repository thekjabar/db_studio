import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Database, Loader2, ShieldCheck, Eye, EyeOff, CheckCircle2, Clock, Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, extractErrorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth-store";
import { OAuthButtons } from "@/components/oauth-buttons";
export default function LoginPage() {
    const nav = useNavigate();
    const { setAuth } = useAuth();
    const [sp, setSp] = useSearchParams();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [totpCode, setTotpCode] = useState("");
    const [needsTotp, setNeedsTotp] = useState(false);
    const [loading, setLoading] = useState(false);
    // When the server says the email isn't verified, the login form shows a
    // "Resend verification email" link next to the error instead of just toasting.
    const [unverifiedEmail, setUnverifiedEmail] = useState(null);
    const [resending, setResending] = useState(false);
    // Inline approval-related banners surfaced either from a fresh signup
    // (router state) or from a login attempt against a pending / rejected
    // account.
    const loc = useLocation();
    const [approvalBanner, setApprovalBanner] = useState(() => {
        const s = (loc.state ?? {});
        return s.awaitingApproval ? { kind: 'awaiting', email: s.email } : null;
    });
    // Workspace slug from ?ws= — when present and SSO is configured for that
    // workspace, show a "Sign in with SSO" button that short-circuits the form.
    const wsSlug = sp.get("ws") ?? null;
    const [ssoAvailable, setSsoAvailable] = useState(false);
    useEffect(() => {
        if (sp.get("error") === "oauth_failed") {
            toast.error("Sign-in with that provider failed");
            sp.delete("error");
            setSp(sp, { replace: true });
        }
        else if (sp.get("error") === "sso") {
            const detail = sp.get("detail");
            toast.error(`SSO sign-in failed${detail ? `: ${detail}` : ""}`);
            sp.delete("error");
            sp.delete("detail");
            setSp(sp, { replace: true });
        }
    }, [sp, setSp]);
    useEffect(() => {
        if (!wsSlug)
            return;
        api
            .ssoAvailable(wsSlug)
            .then((r) => setSsoAvailable(r.available))
            .catch(() => setSsoAvailable(false));
    }, [wsSlug]);
    const submit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            const r = await api.login({ email, password, totpCode: needsTotp ? totpCode : undefined });
            setAuth(r.accessToken, r.user);
            toast.success(`Welcome ${r.user.displayName || r.user.email}`);
            nav("/connections");
        }
        catch (err) {
            const data = err?.response?.data;
            // Server returns either a flat { code, message } or { message: { code, message } }
            // depending on which NestJS exception filter ran. Normalise.
            const code = data?.code ?? data?.message?.code;
            const msg = data?.message?.message ?? data?.message ?? '';
            if (data?.needsTotp) {
                setNeedsTotp(true);
                toast.info("Two-factor code required");
            }
            else if (code === "EMAIL_NOT_VERIFIED") {
                setUnverifiedEmail(email);
            }
            else if (code === "ACCOUNT_PENDING") {
                setApprovalBanner({ kind: 'pending' });
            }
            else if (code === "ACCOUNT_REJECTED") {
                setApprovalBanner({ kind: 'rejected', message: String(msg) });
            }
            else if (code === "ACCOUNT_SUSPENDED") {
                setApprovalBanner({ kind: 'suspended', message: String(msg) });
            }
            else {
                toast.error(extractErrorMessage(err));
            }
        }
        finally {
            setLoading(false);
        }
    };
    const resend = async () => {
        if (!unverifiedEmail)
            return;
        setResending(true);
        try {
            await api.resendVerification(unverifiedEmail);
            toast.success("If the email is registered, a new verification link has been sent.");
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setResending(false);
        }
    };
    // Any approval-related state hides the form entirely — the user can't sign
    // in with this account, so showing a fillable form just invites confusion
    // and retries that will fail with the same error.
    if (approvalBanner) {
        const screen = (() => {
            switch (approvalBanner.kind) {
                case 'awaiting':
                    return {
                        tone: 'amber',
                        Icon: CheckCircle2,
                        pageTitle: 'Thanks for signing up',
                        pageSubtitle: 'One more step',
                        cardTitle: 'Account awaiting admin approval',
                        body: (_jsxs(_Fragment, { children: ["We received your sign-up", approvalBanner.email ? _jsxs(_Fragment, { children: [" for ", _jsx("span", { className: "font-mono", children: approvalBanner.email })] }) : null, ". An admin will review it shortly \u2014 you'll be able to sign in once it's approved."] })),
                    };
                case 'pending':
                    return {
                        tone: 'amber',
                        Icon: Clock,
                        pageTitle: 'Awaiting approval',
                        pageSubtitle: 'Hang tight',
                        cardTitle: "Your account hasn't been approved yet",
                        body: _jsx(_Fragment, { children: "An admin will review your sign-up soon. You'll be able to sign in once it's approved." }),
                    };
                case 'rejected':
                    return {
                        tone: 'destructive',
                        Icon: Ban,
                        pageTitle: 'Account not approved',
                        pageSubtitle: 'Sign-in blocked',
                        cardTitle: 'Your account was rejected',
                        body: _jsx(_Fragment, { children: approvalBanner.message || 'An admin rejected your account.' }),
                    };
                case 'suspended':
                    return {
                        tone: 'destructive',
                        Icon: Ban,
                        pageTitle: 'Account suspended',
                        pageSubtitle: 'Sign-in blocked',
                        cardTitle: 'Your account has been suspended',
                        body: _jsx(_Fragment, { children: approvalBanner.message || 'Your account has been suspended.' }),
                    };
            }
        })();
        const ringClass = screen.tone === 'amber'
            ? 'bg-amber-500/15 border-amber-500/30 text-amber-500'
            : 'bg-destructive/15 border-destructive/30 text-destructive';
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx(Link, { to: "/", "aria-label": "DB Studio home", className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: screen.pageTitle }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: screen.pageSubtitle })] }), _jsxs("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6 space-y-4", children: [_jsxs("div", { className: "flex flex-col items-center text-center gap-2", children: [_jsx("div", { className: `h-10 w-10 rounded-full border flex items-center justify-center ${ringClass}`, children: _jsx(screen.Icon, { className: "h-5 w-5" }) }), _jsx("div", { className: "font-medium text-sm", children: screen.cardTitle }), _jsx("p", { className: "text-xs text-muted-foreground", children: screen.body })] }), _jsxs("div", { className: "flex flex-col gap-2 pt-2", children: [_jsx(Button, { asChild: true, className: "w-full", children: _jsx(Link, { to: "/", children: "Back to home" }) }), _jsx(Button, { variant: "outline", className: "w-full", onClick: () => {
                                            setApprovalBanner(null);
                                            setEmail('');
                                            setPassword('');
                                        }, children: "Use a different account" })] })] })] }) }));
    }
    return (_jsx("div", { className: "min-h-screen flex items-center justify-center gradient-bg p-4", children: _jsxs("div", { className: "w-full max-w-sm", children: [_jsxs("div", { className: "flex flex-col items-center mb-8", children: [_jsx(Link, { to: "/", "aria-label": "DB Studio home", className: "h-12 w-12 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center mb-3 hover:bg-primary/20 transition-colors", children: _jsx(Database, { className: "h-6 w-6 text-primary" }) }), _jsx("h1", { className: "text-xl font-semibold", children: "Sign in to DB Studio" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Welcome back" })] }), _jsxs("div", { className: "rounded-lg border border-border bg-card shadow-xl p-6", children: [unverifiedEmail && (_jsxs("div", { className: "mb-4 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400", children: [_jsx("div", { className: "font-medium mb-1", children: "Verify your email first" }), _jsxs("div", { className: "text-muted-foreground", children: ["We sent a link to ", _jsx("span", { className: "font-mono", children: unverifiedEmail }), ". Click it before signing in."] }), _jsx("button", { type: "button", onClick: resend, disabled: resending, className: "mt-2 underline hover:text-foreground disabled:opacity-50", children: resending ? "Sending…" : "Resend verification email" })] })), ssoAvailable && wsSlug && (_jsxs("div", { className: "mb-4", children: [_jsxs("a", { href: api.ssoStartUrl(wsSlug), className: "w-full inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background hover:bg-accent text-sm py-2.5 font-medium", children: [_jsx(ShieldCheck, { className: "h-4 w-4" }), "Sign in with SSO (", wsSlug, ")"] }), _jsxs("div", { className: "relative my-3", children: [_jsx("div", { className: "absolute inset-0 flex items-center", children: _jsx("span", { className: "w-full border-t border-border" }) }), _jsx("div", { className: "relative flex justify-center text-[10px] uppercase tracking-wider", children: _jsx("span", { className: "bg-card px-2 text-muted-foreground", children: "or sign in with password" }) })] })] })), _jsxs("form", { onSubmit: submit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Email" }), _jsx(Input, { type: "email", autoComplete: "email", required: true, value: email, onChange: (e) => setEmail(e.target.value), placeholder: "you@example.com" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx(Label, { children: "Password" }), _jsx(Link, { to: "/forgot-password", className: "text-xs text-muted-foreground hover:text-foreground", children: "Forgot?" })] }), _jsxs("div", { className: "relative", children: [_jsx(Input, { type: showPassword ? "text" : "password", autoComplete: "current-password", required: true, value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", className: "pr-9" }), _jsx("button", { type: "button", onClick: () => setShowPassword((v) => !v), tabIndex: -1, "aria-label": showPassword ? "Hide password" : "Show password", className: "absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground", children: showPassword ? _jsx(EyeOff, { className: "h-4 w-4" }) : _jsx(Eye, { className: "h-4 w-4" }) })] })] }), needsTotp && (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "2FA Code" }), _jsx(Input, { value: totpCode, onChange: (e) => setTotpCode(e.target.value), placeholder: "6-digit code", inputMode: "numeric", className: "font-mono tracking-widest" })] })), _jsxs(Button, { type: "submit", className: "w-full", disabled: loading, children: [loading && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Sign in"] })] }), _jsx(OAuthButtons, {})] }), _jsxs("p", { className: "text-center text-sm text-muted-foreground mt-4", children: ["No account?", " ", _jsx(Link, { to: "/signup", className: "text-primary hover:underline", children: "Sign up" })] })] }) }));
}
