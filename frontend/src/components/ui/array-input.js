import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
function parseItem(raw, kind) {
    if (kind === "number") {
        if (raw === "")
            return null;
        const n = Number(raw);
        if (!Number.isFinite(n))
            throw new Error("not a number");
        return n;
    }
    if (kind === "bool") {
        if (raw === "true")
            return true;
        if (raw === "false")
            return false;
        throw new Error("must be true or false");
    }
    return raw;
}
function formatItem(v) {
    if (v === null || v === undefined)
        return "";
    return String(v);
}
/**
 * Chip-based editor for array values. Type a value and press Enter or comma to
 * add it; click × on a chip to remove. Paste-commas auto-split.
 */
export function ArrayInput({ value, onChange, itemKind = "text", placeholder, disabled, className }) {
    const [buf, setBuf] = React.useState("");
    const [error, setError] = React.useState(null);
    const commitBuf = () => {
        const raw = buf.trim();
        if (!raw)
            return;
        try {
            const parsed = parseItem(raw, itemKind);
            onChange([...value, parsed]);
            setBuf("");
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
    };
    const removeAt = (idx) => {
        onChange(value.filter((_, i) => i !== idx));
    };
    return (_jsxs("div", { className: cn("space-y-1", className), children: [_jsxs("div", { className: cn("flex flex-wrap gap-1 items-center rounded-md border border-input bg-background px-2 py-1 min-h-9", disabled && "opacity-50 pointer-events-none"), children: [value.map((v, i) => (_jsxs("span", { className: "inline-flex items-center gap-1 rounded-sm bg-primary/15 border border-primary/25 px-1.5 py-0.5 text-[11px] font-mono text-primary", children: [formatItem(v), _jsx("button", { type: "button", onClick: () => removeAt(i), className: "text-primary/70 hover:text-primary", "aria-label": "Remove item", children: _jsx(X, { className: "h-2.5 w-2.5" }) })] }, i))), _jsx("input", { value: buf, onChange: (e) => {
                            const v = e.target.value;
                            if (v.includes(",")) {
                                const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
                                // Commit each comma-separated segment.
                                const toAdd = [];
                                for (const p of parts) {
                                    try {
                                        toAdd.push(parseItem(p, itemKind));
                                    }
                                    catch (err) {
                                        setError(err.message);
                                        setBuf(p);
                                        return;
                                    }
                                }
                                onChange([...value, ...toAdd]);
                                setBuf("");
                                setError(null);
                                return;
                            }
                            setBuf(v);
                            if (error)
                                setError(null);
                        }, onKeyDown: (e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                commitBuf();
                            }
                            if (e.key === "Backspace" && !buf && value.length) {
                                onChange(value.slice(0, -1));
                            }
                        }, onBlur: commitBuf, placeholder: value.length === 0 ? placeholder ?? "Type and press Enter" : "", className: "flex-1 min-w-[80px] bg-transparent text-sm outline-none", disabled: disabled })] }), error && _jsx("p", { className: "text-[11px] text-destructive", children: error })] }));
}
