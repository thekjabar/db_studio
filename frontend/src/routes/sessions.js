import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { ArrowLeft, Database, LogOut, Monitor, Smartphone, Trash2 } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/modal-provider";
function summarizeUA(ua) {
    if (!ua)
        return { label: "Unknown device", icon: _jsx(Monitor, { className: "h-4 w-4" }) };
    const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
    const browser = /Firefox/i.test(ua)
        ? "Firefox"
        : /Edg/i.test(ua)
            ? "Edge"
            : /Chrome/i.test(ua)
                ? "Chrome"
                : /Safari/i.test(ua)
                    ? "Safari"
                    : "Browser";
    const os = /Windows/i.test(ua)
        ? "Windows"
        : /Mac OS X/i.test(ua)
            ? "macOS"
            : /Linux/i.test(ua)
                ? "Linux"
                : /Android/i.test(ua)
                    ? "Android"
                    : /iPhone|iPad/i.test(ua)
                        ? "iOS"
                        : "OS";
    return {
        label: `${browser} on ${os}`,
        icon: mobile ? _jsx(Smartphone, { className: "h-4 w-4" }) : _jsx(Monitor, { className: "h-4 w-4" }),
    };
}
export default function SessionsRoute() {
    const nav = useNavigate();
    const qc = useQueryClient();
    const modal = useModal();
    const q = useQuery({
        queryKey: ["sessions"],
        queryFn: () => api.listSessions(),
    });
    const revoke = useMutation({
        mutationFn: (id) => api.revokeSession(id),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["sessions"] });
            toast.success("Session revoked");
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const revokeAll = useMutation({
        mutationFn: () => api.revokeOtherSessions(),
        onSuccess: (r) => {
            qc.invalidateQueries({ queryKey: ["sessions"] });
            toast.success(`Revoked ${r.revoked} other session${r.revoked === 1 ? "" : "s"}`);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    return (_jsxs("div", { className: "min-h-screen bg-background", children: [_jsxs("header", { className: "h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 sticky top-0 z-10", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: () => nav("/connections"), className: "text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1", children: [_jsx(ArrowLeft, { className: "h-4 w-4" }), " Back"] }), _jsx("div", { className: "h-4 w-px bg-border" }), _jsxs("div", { className: "flex items-center gap-2 font-semibold", children: [_jsx(Database, { className: "h-5 w-5 text-primary" }), "Active sessions"] })] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: async () => {
                            const ok = await modal.confirm({
                                title: "Sign out everywhere else?",
                                description: "All other browsers/devices will be signed out. Your current session stays.",
                                confirmLabel: "Sign out others",
                            });
                            if (ok)
                                revokeAll.mutate();
                        }, disabled: revokeAll.isPending, className: "text-destructive hover:text-destructive", children: [_jsx(LogOut, { className: "h-3.5 w-3.5" }), " Sign out others"] })] }), _jsxs("div", { className: "max-w-2xl mx-auto p-6 space-y-3", children: [_jsx("p", { className: "text-sm text-muted-foreground", children: "Each session is a browser you've signed into. Revoke a session to force the next request from that browser to 401." }), q.isLoading && _jsx("div", { className: "text-muted-foreground", children: "Loading\u2026" }), q.data?.length === 0 && (_jsx("div", { className: "rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground", children: "No active sessions (other than this request)." })), _jsx("div", { className: "space-y-2", children: q.data?.map((s) => {
                            const ua = summarizeUA(s.userAgent);
                            return (_jsxs("div", { className: "rounded-md border border-border bg-card p-3 flex items-center gap-3", children: [_jsx("div", { className: "text-muted-foreground", children: ua.icon }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "text-sm font-medium flex items-center gap-2", children: [ua.label, s.current && (_jsx("span", { className: "text-[10px] font-medium rounded bg-primary/10 text-primary px-1.5 py-0.5", children: "This session" }))] }), _jsxs("div", { className: "text-[11px] text-muted-foreground", children: [s.ip && _jsxs(_Fragment, { children: ["IP ", s.ip, " \u00B7 "] }), "Signed in ", format(new Date(s.createdAt), "MMM d HH:mm"), " \u00B7 expires", " ", format(new Date(s.expiresAt), "MMM d HH:mm")] })] }), _jsx("button", { onClick: async () => {
                                            const ok = await modal.confirm({
                                                title: "Revoke this session?",
                                                description: s.current
                                                    ? "This is your current session — you'll be logged out."
                                                    : "That browser will be signed out on its next request.",
                                                confirmLabel: "Revoke",
                                                destructive: true,
                                            });
                                            if (ok)
                                                revoke.mutate(s.id);
                                        }, className: "text-muted-foreground hover:text-destructive p-2", title: "Revoke", children: _jsx(Trash2, { className: "h-3.5 w-3.5" }) })] }, s.id));
                        }) })] })] }));
}
