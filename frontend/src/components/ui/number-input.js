import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Minus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
/**
 * Number input without the browser-native spinners. Custom +/- buttons and
 * inline validation (allows "-", "-12.3", "12", "", etc).
 */
export function NumberInput({ value, onChange, step = 1, integer, className, disabled, ...rest }) {
    const commit = (next) => {
        onChange(integer ? String(Math.trunc(next)) : String(next));
    };
    const cur = () => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    return (_jsxs("div", { className: cn("relative flex items-stretch", className), children: [_jsx(Input, { ...rest, disabled: disabled, value: value, inputMode: integer ? "numeric" : "decimal", onChange: (e) => {
                    const v = e.target.value;
                    if (v === "" || v === "-" || v === ".") {
                        onChange(v);
                        return;
                    }
                    const re = integer ? /^-?\d*$/ : /^-?\d*(?:\.\d*)?$/;
                    if (re.test(v))
                        onChange(v);
                }, className: "pr-14 font-mono" }), _jsxs("div", { className: "absolute right-0 top-0 bottom-0 flex border-l border-input", children: [_jsx("button", { type: "button", disabled: disabled, onClick: () => commit(cur() - step), className: "px-2 text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-50", children: _jsx(Minus, { className: "h-3 w-3" }) }), _jsx("button", { type: "button", disabled: disabled, onClick: () => commit(cur() + step), className: "px-2 text-muted-foreground hover:text-foreground hover:bg-accent/60 border-l border-input disabled:opacity-50", children: _jsx(Plus, { className: "h-3 w-3" }) })] })] }));
}
