import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
export function defaultSshTunnel() {
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
export function SshTunnelFields({ enabled, onEnabledChange, value, onChange, keepExisting }) {
    const patch = (p) => onChange({ ...value, ...p });
    return (_jsxs("div", { className: "border-t border-border pt-4 space-y-3", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx(Switch, { checked: enabled, onCheckedChange: onEnabledChange, id: "ssh-toggle" }), _jsxs("div", { children: [_jsx("label", { htmlFor: "ssh-toggle", className: "text-sm font-medium cursor-pointer", children: "Connect via SSH tunnel" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Useful when the database sits behind a bastion host and isn't reachable directly." })] })] }), enabled && (_jsxs("div", { className: "space-y-3 pl-1", children: [_jsxs("div", { className: "grid grid-cols-[1fr_140px] gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SSH host" }), _jsx(Input, { value: value.host, onChange: (e) => patch({ host: e.target.value }), placeholder: "bastion.example.com" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SSH port" }), _jsx(NumberInput, { value: String(value.port || 22), onChange: (v) => patch({ port: parseInt(v, 10) || 22 }), integer: true })] })] }), _jsxs("div", { className: "grid grid-cols-[1fr_140px] gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SSH user" }), _jsx(Input, { value: value.user, onChange: (e) => patch({ user: e.target.value }), placeholder: "ec2-user" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Auth method" }), _jsxs(Select, { value: value.authType, onValueChange: (v) => patch({ authType: v }), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "password", children: "Password" }), _jsx(SelectItem, { value: "privateKey", children: "Private key" })] })] })] })] }), value.authType === "password" ? (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "SSH password" }), _jsx(Input, { type: "password", value: value.password ?? "", onChange: (e) => patch({ password: e.target.value }), placeholder: keepExisting ? "leave blank to keep current" : "••••••••", autoComplete: "new-password" })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Private key (PEM)" }), _jsx(Textarea, { rows: 6, value: value.privateKey ?? "", onChange: (e) => patch({ privateKey: e.target.value }), placeholder: keepExisting
                                            ? "leave blank to keep current"
                                            : "-----BEGIN OPENSSH PRIVATE KEY-----\n...", className: "font-mono text-xs" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Passphrase (optional)" }), _jsx(Input, { type: "password", value: value.passphrase ?? "", onChange: (e) => patch({ passphrase: e.target.value }), placeholder: "for encrypted keys", autoComplete: "new-password" })] })] }))] }))] }));
}
