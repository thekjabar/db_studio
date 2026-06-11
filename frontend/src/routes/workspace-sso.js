import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import { api, extractErrorMessage } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
export default function WorkspaceSsoRoute() {
    const { id } = useParams();
    const navigate = useNavigate();
    const wsQ = useQuery({
        queryKey: ["workspace", id],
        queryFn: () => api.getWorkspace(id),
        enabled: !!id,
    });
    const ssoQ = useQuery({
        queryKey: ["sso", id],
        queryFn: () => api.getWorkspaceSso(id),
        enabled: !!id,
    });
    const [issuerUrl, setIssuerUrl] = useState("");
    const [clientId, setClientId] = useState("");
    const [clientSecret, setClientSecret] = useState("");
    const [allowedDomains, setAllowedDomains] = useState("");
    const [autoProvision, setAutoProvision] = useState(true);
    const [enabled, setEnabled] = useState(false);
    const [saving, setSaving] = useState(false);
    // Seed form when the existing config loads — preserves user edits across refetches.
    const sso = ssoQ.data;
    useEffect(() => {
        if (sso) {
            setIssuerUrl(sso.issuerUrl);
            setClientId(sso.clientId);
            setAllowedDomains(sso.allowedDomains ?? "");
            setAutoProvision(sso.autoProvision);
            setEnabled(sso.enabled);
        }
    }, [sso]);
    const ws = wsQ.data;
    const loginUrl = ws ? `${window.location.origin}/login?ws=${encodeURIComponent(ws.slug)}` : "";
    const save = async () => {
        if (!issuerUrl.trim() || !clientId.trim()) {
            toast.error("Issuer URL and Client ID are required");
            return;
        }
        setSaving(true);
        try {
            await api.upsertWorkspaceSso(id, {
                issuerUrl: issuerUrl.trim(),
                clientId: clientId.trim(),
                clientSecret: clientSecret || undefined,
                enabled,
                allowedDomains: allowedDomains.trim() || null,
                autoProvision,
            });
            toast.success("SSO configuration saved");
            setClientSecret("");
            ssoQ.refetch();
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
        finally {
            setSaving(false);
        }
    };
    const disable = async () => {
        try {
            await api.disableWorkspaceSso(id);
            toast.success("SSO disabled");
            setEnabled(false);
            ssoQ.refetch();
        }
        catch (err) {
            toast.error(extractErrorMessage(err));
        }
    };
    if (wsQ.isLoading || ssoQ.isLoading) {
        return (_jsxs("div", { className: "p-8 flex items-center gap-2 text-muted-foreground", children: [_jsx(Loader2, { className: "h-4 w-4 animate-spin" }), " Loading..."] }));
    }
    return (_jsxs("div", { className: "max-w-2xl mx-auto px-6 py-8 space-y-6", children: [_jsxs("div", { children: [_jsx("button", { onClick: () => navigate("/connections"), className: "text-xs text-muted-foreground hover:text-foreground mb-2", children: "\u2190 Back" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx(ShieldCheck, { className: "h-5 w-5 text-primary" }), _jsxs("h1", { className: "text-lg font-semibold", children: ["SSO for ", ws?.name ?? "workspace"] })] }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Configure OpenID Connect for Okta, Azure AD, Google Workspace, Auth0, Keycloak, or any compliant IdP." })] }), _jsxs("div", { className: "rounded border border-border bg-card p-5 space-y-4", children: [_jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Issuer URL" }), _jsx(Input, { value: issuerUrl, onChange: (e) => setIssuerUrl(e.target.value), placeholder: "https://company.okta.com/oauth2/default", className: "font-mono text-xs" }), _jsxs("p", { className: "text-[11px] text-muted-foreground mt-1", children: ["Either the issuer (discovery doc appended) or the full ", _jsx("code", { children: ".well-known/openid-configuration" }), " URL."] })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Client ID" }), _jsx(Input, { value: clientId, onChange: (e) => setClientId(e.target.value), className: "font-mono text-xs" })] }), _jsxs("div", { children: [_jsxs("label", { className: "text-xs font-medium text-muted-foreground", children: ["Client Secret ", sso?.hasSecret && _jsx("span", { className: "text-muted-foreground", children: "(leave blank to keep existing)" })] }), _jsx(Input, { type: "password", value: clientSecret, onChange: (e) => setClientSecret(e.target.value), placeholder: sso?.hasSecret ? "••••••••" : "", className: "font-mono text-xs" })] }), _jsxs("div", { children: [_jsx("label", { className: "text-xs font-medium text-muted-foreground", children: "Allowed email domains (optional)" }), _jsx(Input, { value: allowedDomains, onChange: (e) => setAllowedDomains(e.target.value), placeholder: "company.com, partner.com", className: "text-xs" }), _jsx("p", { className: "text-[11px] text-muted-foreground mt-1", children: "Comma-separated. If set, only emails in these domains can sign in." })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium", children: "Auto-provision new users" }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "If off, users must already have an account in Studio before SSO sign-in will work." })] }), _jsx(Switch, { checked: autoProvision, onCheckedChange: setAutoProvision })] }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-medium", children: "Enabled" }), _jsxs("p", { className: "text-[11px] text-muted-foreground", children: ["When on, users can sign in via ", _jsx("code", { className: "text-xs", children: loginUrl }), "."] })] }), _jsx(Switch, { checked: enabled, onCheckedChange: setEnabled })] }), _jsxs("div", { className: "pt-2 border-t border-border flex items-center gap-2", children: [_jsxs(Button, { onClick: save, disabled: saving, children: [saving && _jsx(Loader2, { className: "h-3.5 w-3.5 animate-spin" }), " Save"] }), sso?.enabled && (_jsx(Button, { variant: "ghost", onClick: disable, children: "Disable SSO" }))] })] }), _jsxs("div", { className: "rounded border border-border bg-card p-5 space-y-2 text-xs", children: [_jsx("div", { className: "font-medium", children: "Redirect URI to register with your IdP" }), _jsxs("code", { className: "block font-mono bg-muted px-2 py-1.5 rounded text-[11px] break-all", children: [window.location.origin.replace(/:\d+$/, ":3000"), "/api/auth/sso/", ws?.slug ?? "", "/callback"] }), _jsx("p", { className: "text-[11px] text-muted-foreground", children: "Configure this as an allowed redirect / reply URL in your IdP's app definition." })] })] }));
}
