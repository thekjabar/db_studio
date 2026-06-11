import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, extractErrorMessage } from "@/lib/api";
import { SshTunnelFields, defaultSshTunnel } from "@/components/ssh-tunnel-fields";
/**
 * Edit an existing connection. Credentials fields are blank on open — only
 * filled-in fields are sent (backend merges into stored creds). This lets the
 * user rotate just a password without re-entering host/port/db.
 */
export function EditConnectionDialog({ connection, onOpenChange }) {
    const qc = useQueryClient();
    const open = !!connection;
    const [name, setName] = useState("");
    const [host, setHost] = useState("");
    const [port, setPort] = useState("");
    const [database, setDatabase] = useState("");
    const [user, setUser] = useState("");
    const [password, setPassword] = useState("");
    const [sslMode, setSslMode] = useState("");
    const [readOnly, setReadOnly] = useState(false);
    // Tri-state for SSH: null = "leave unchanged" (default when dialog opens),
    //                   {…} = "set/update tunnel to this config",
    //                   {cleared: true} = "remove the tunnel".
    const [sshMode, setSshMode] = useState("unchanged");
    const [ssh, setSsh] = useState(defaultSshTunnel);
    useEffect(() => {
        if (!connection)
            return;
        setName(connection.name);
        setReadOnly(!!connection.readOnly);
        // Credentials start blank — user fills only what changes.
        setHost("");
        setPort("");
        setDatabase("");
        setUser("");
        setPassword("");
        setSslMode("");
        setSshMode("unchanged");
        setSsh(defaultSshTunnel());
    }, [connection]);
    const update = useMutation({
        mutationFn: (body) => api.updateConnection(connection.id, body),
        onSuccess: () => {
            toast.success("Connection updated");
            qc.invalidateQueries({ queryKey: ["connections"] });
            onOpenChange(false);
        },
        onError: (e) => toast.error(extractErrorMessage(e)),
    });
    const submit = (e) => {
        e.preventDefault();
        if (!connection)
            return;
        const patch = {};
        if (name !== connection.name)
            patch.name = name;
        if (readOnly !== !!connection.readOnly)
            patch.readOnly = readOnly;
        if (host)
            patch.host = host;
        if (port !== "" && Number.isFinite(port))
            patch.port = Number(port);
        if (database)
            patch.database = database;
        if (user)
            patch.user = user;
        if (password)
            patch.password = password;
        if (sslMode)
            patch.sslMode = sslMode;
        if (sshMode === "set")
            patch.ssh = ssh;
        else if (sshMode === "clear")
            patch.ssh = null;
        if (Object.keys(patch).length === 0) {
            toast.info("Nothing to update");
            return;
        }
        update.mutate(patch);
    };
    return (_jsx(Dialog, { open: open, onOpenChange: (v) => !v && onOpenChange(false), children: _jsxs(DialogContent, { className: "max-w-lg", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Edit connection" }), _jsx(DialogDescription, { children: "Leave credential fields blank to keep the current value. Fill in only what you want to change." })] }), _jsxs("form", { onSubmit: submit, className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Name" }), _jsx(Input, { value: name, onChange: (e) => setName(e.target.value), required: true })] }), _jsxs("div", { className: "border-t border-border pt-4", children: [_jsx("div", { className: "text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3", children: "Credentials" }), _jsxs("div", { className: "grid grid-cols-[1fr_140px] gap-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Host" }), _jsx(Input, { value: host, onChange: (e) => setHost(e.target.value), placeholder: "unchanged" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Port" }), _jsx(NumberInput, { value: port === "" ? "" : String(port), onChange: (v) => setPort(v === "" ? "" : (parseInt(v, 10) || 0)), integer: true })] })] }), _jsxs("div", { className: "space-y-1.5 mt-3", children: [_jsx(Label, { children: "Database" }), _jsx(Input, { value: database, onChange: (e) => setDatabase(e.target.value), placeholder: "unchanged" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3 mt-3", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "User" }), _jsx(Input, { value: user, onChange: (e) => setUser(e.target.value), placeholder: "unchanged" })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Password" }), _jsx(Input, { type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022", autoComplete: "new-password" })] })] }), _jsxs("div", { className: "space-y-1.5 mt-3", children: [_jsx(Label, { children: "SSL mode" }), _jsx(Input, { value: sslMode, onChange: (e) => setSslMode(e.target.value), placeholder: "disable / require / verify-ca / verify-full" })] })] }), _jsxs("div", { className: "flex items-center gap-3 pt-2", children: [_jsx(Switch, { checked: readOnly, onCheckedChange: setReadOnly }), _jsxs("div", { children: [_jsx("div", { className: "text-sm font-medium", children: "Read-only" }), _jsx("div", { className: "text-xs text-muted-foreground", children: "Prevent writes from this connection." })] })] }), _jsx(SshTunnelFields, { enabled: sshMode === "set", onEnabledChange: (on) => setSshMode(on ? "set" : "unchanged"), value: ssh, onChange: setSsh, keepExisting: true }), sshMode !== "clear" && (_jsx("div", { className: "text-xs text-muted-foreground pl-1", children: _jsx("button", { type: "button", className: "underline hover:text-foreground", onClick: () => setSshMode("clear"), children: "Remove existing SSH tunnel" }) })), sshMode === "clear" && (_jsxs("div", { className: "text-xs text-destructive pl-1", children: ["SSH tunnel will be removed on save.", " ", _jsx("button", { type: "button", className: "underline hover:text-foreground", onClick: () => setSshMode("unchanged"), children: "Undo" })] })), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { type: "button", variant: "outline", onClick: () => onOpenChange(false), children: "Cancel" }), _jsxs(Button, { type: "submit", disabled: update.isPending, children: [update.isPending && _jsx(Loader2, { className: "h-4 w-4 animate-spin" }), "Save changes"] })] })] })] }) }));
}
