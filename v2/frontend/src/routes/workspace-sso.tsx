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
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const wsQ = useQuery({
    queryKey: ["workspace", id],
    queryFn: () => api.getWorkspace(id!),
    enabled: !!id,
  });
  const ssoQ = useQuery({
    queryKey: ["sso", id],
    queryFn: () => api.getWorkspaceSso(id!),
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
      await api.upsertWorkspaceSso(id!, {
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
    } catch (err) {
      toast.error(extractErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    try {
      await api.disableWorkspaceSso(id!);
      toast.success("SSO disabled");
      setEnabled(false);
      ssoQ.refetch();
    } catch (err) {
      toast.error(extractErrorMessage(err));
    }
  };

  if (wsQ.isLoading || ssoQ.isLoading) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
      <div>
        <button
          onClick={() => navigate("/connections")}
          className="text-xs text-muted-foreground hover:text-foreground mb-2"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">SSO for {ws?.name ?? "workspace"}</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Configure OpenID Connect for Okta, Azure AD, Google Workspace, Auth0, Keycloak, or any compliant IdP.
        </p>
      </div>

      <div className="rounded border border-border bg-card p-5 space-y-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Issuer URL</label>
          <Input
            value={issuerUrl}
            onChange={(e) => setIssuerUrl(e.target.value)}
            placeholder="https://company.okta.com/oauth2/default"
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Either the issuer (discovery doc appended) or the full <code>.well-known/openid-configuration</code> URL.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Client ID</label>
          <Input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Client Secret {sso?.hasSecret && <span className="text-muted-foreground">(leave blank to keep existing)</span>}
          </label>
          <Input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={sso?.hasSecret ? "••••••••" : ""}
            className="font-mono text-xs"
          />
        </div>

        <div>
          <label className="text-xs font-medium text-muted-foreground">Allowed email domains (optional)</label>
          <Input
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
            placeholder="company.com, partner.com"
            className="text-xs"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Comma-separated. If set, only emails in these domains can sign in.
          </p>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium">Auto-provision new users</div>
            <p className="text-[11px] text-muted-foreground">
              If off, users must already have an account in Studio before SSO sign-in will work.
            </p>
          </div>
          <Switch checked={autoProvision} onCheckedChange={setAutoProvision} />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium">Enabled</div>
            <p className="text-[11px] text-muted-foreground">
              When on, users can sign in via <code className="text-xs">{loginUrl}</code>.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>

        <div className="pt-2 border-t border-border flex items-center gap-2">
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save
          </Button>
          {sso?.enabled && (
            <Button variant="ghost" onClick={disable}>
              Disable SSO
            </Button>
          )}
        </div>
      </div>

      <div className="rounded border border-border bg-card p-5 space-y-2 text-xs">
        <div className="font-medium">Redirect URI to register with your IdP</div>
        <code className="block font-mono bg-muted px-2 py-1.5 rounded text-[11px] break-all">
          {window.location.origin.replace(/:\d+$/, ":3000")}/api/auth/sso/{ws?.slug ?? ""}/callback
        </code>
        <p className="text-[11px] text-muted-foreground">
          Configure this as an allowed redirect / reply URL in your IdP's app definition.
        </p>
      </div>
    </div>
  );
}
