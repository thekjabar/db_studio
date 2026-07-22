import type { SshTunnelInput } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  value: SshTunnelInput;
  onChange: (v: SshTunnelInput) => void;
  /** When true, treat empty password/privateKey as "keep existing" (edit mode). */
  keepExisting?: boolean;
}

export function defaultSshTunnel(): SshTunnelInput {
  return {
    host: "",
    port: 22,
    user: "",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
  };
}

export function SshTunnelFields({ enabled, onEnabledChange, value, onChange, keepExisting }: Props) {
  const patch = (p: Partial<SshTunnelInput>) => onChange({ ...value, ...p });

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-center gap-3">
        <Switch checked={enabled} onCheckedChange={onEnabledChange} id="ssh-toggle" />
        <div>
          <label htmlFor="ssh-toggle" className="text-sm font-medium cursor-pointer">
            Connect via SSH tunnel
          </label>
          <div className="text-xs text-muted-foreground">
            Useful when the database sits behind a bastion host and isn't reachable directly.
          </div>
        </div>
      </div>

      {enabled && (
        <div className="space-y-3 pl-1">
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="space-y-1.5">
              <Label>SSH host</Label>
              <Input
                value={value.host}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="bastion.example.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>SSH port</Label>
              <NumberInput
                value={String(value.port || 22)}
                onChange={(v) => patch({ port: parseInt(v, 10) || 22 })}
                integer
              />
            </div>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div className="space-y-1.5">
              <Label>SSH user</Label>
              <Input
                value={value.user}
                onChange={(e) => patch({ user: e.target.value })}
                placeholder="ec2-user"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Auth method</Label>
              <Select
                value={value.authType}
                onValueChange={(v) => patch({ authType: v as SshTunnelInput["authType"] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">Password</SelectItem>
                  <SelectItem value="privateKey">Private key</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {value.authType === "password" ? (
            <div className="space-y-1.5">
              <Label>SSH password</Label>
              <Input
                type="password"
                value={value.password ?? ""}
                onChange={(e) => patch({ password: e.target.value })}
                placeholder={keepExisting ? "leave blank to keep current" : "••••••••"}
                autoComplete="new-password"
              />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Private key (PEM)</Label>
                <Textarea
                  rows={6}
                  value={value.privateKey ?? ""}
                  onChange={(e) => patch({ privateKey: e.target.value })}
                  placeholder={
                    keepExisting
                      ? "leave blank to keep current"
                      : "-----BEGIN OPENSSH PRIVATE KEY-----\n..."
                  }
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Passphrase (optional)</Label>
                <Input
                  type="password"
                  value={value.passphrase ?? ""}
                  onChange={(e) => patch({ passphrase: e.target.value })}
                  placeholder="for encrypted keys"
                  autoComplete="new-password"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
