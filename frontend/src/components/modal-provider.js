import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
const ModalCtx = React.createContext(null);
export function useModal() {
    const ctx = React.useContext(ModalCtx);
    if (!ctx)
        throw new Error("useModal must be used inside <ModalProvider>");
    return ctx;
}
export function ModalProvider({ children }) {
    const [pending, setPending] = React.useState(null);
    const [value, setValue] = React.useState("");
    const [error, setError] = React.useState(null);
    const api = React.useMemo(() => ({
        confirm: (opts) => new Promise((resolve) => setPending({ kind: "confirm", opts, resolve })),
        prompt: (opts) => new Promise((resolve) => {
            setValue(opts.defaultValue ?? "");
            setError(null);
            setPending({ kind: "prompt", opts, resolve });
        }),
        select: (opts) => new Promise((resolve) => {
            setValue(opts.defaultValue ?? opts.options[0]?.value ?? "");
            setError(null);
            setPending({ kind: "select", opts, resolve });
        }),
    }), []);
    const close = (result) => {
        if (!pending)
            return;
        if (pending.kind === "confirm")
            pending.resolve(result);
        else
            pending.resolve(result);
        setPending(null);
    };
    const onOpenChange = (open) => {
        if (!open)
            close(pending?.kind === "confirm" ? false : null);
    };
    const onConfirm = () => {
        if (!pending)
            return;
        if (pending.kind === "confirm") {
            close(true);
            return;
        }
        if (pending.kind === "select") {
            close(value);
            return;
        }
        const v = value.trim();
        const err = pending.opts.validate?.(v) ?? null;
        if (err) {
            setError(err);
            return;
        }
        close(v);
    };
    return (_jsxs(ModalCtx.Provider, { value: api, children: [children, _jsx(Dialog, { open: !!pending, onOpenChange: onOpenChange, children: _jsx(DialogContent, { className: "max-w-sm", children: pending && (_jsxs(_Fragment, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: pending.opts.title }), pending.opts.description && (_jsx(DialogDescription, { children: pending.opts.description }))] }), pending.kind === "prompt" && (_jsxs("div", { className: "space-y-1.5", children: [_jsx(Input, { autoFocus: true, value: value, onChange: (e) => {
                                            setValue(e.target.value);
                                            if (error)
                                                setError(null);
                                        }, placeholder: pending.opts.placeholder, onKeyDown: (e) => {
                                            if (e.key === "Enter")
                                                onConfirm();
                                        } }), error && _jsx("p", { className: "text-xs text-destructive", children: error })] })), pending.kind === "select" && (_jsxs(Select, { value: value, onValueChange: setValue, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsx(SelectContent, { children: pending.opts.options.map((o) => (_jsx(SelectItem, { value: o.value, children: o.label ?? o.value }, o.value))) })] })), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "outline", onClick: () => close(pending.kind === "confirm" ? false : null), children: pending.opts.cancelLabel ?? "Cancel" }), _jsx(Button, { variant: pending.kind === "confirm" && pending.opts.destructive ? "destructive" : "default", onClick: onConfirm, children: pending.opts.confirmLabel ?? (pending.kind === "confirm" ? "Confirm" : "OK") })] })] })) }) })] }));
}
