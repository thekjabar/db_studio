import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
import { PG_COLUMN_TYPES } from "@/lib/column-types";
/**
 * Grouped Postgres column-type picker. Shows section headers (Text / Numeric /
 * Boolean & UUID / Date & Time / JSON & Binary / Network) with aliases in
 * parentheses, matching the style of the Add Column dialog.
 */
export function ColumnTypeSelect({ value, onChange, currentValue, placeholder = "Choose a column type...", className }) {
    // If the current/default value isn't one of the known types (e.g. a custom
    // domain or enum), render it first so re-typing preserves it.
    const knownSet = new Set(PG_COLUMN_TYPES.flatMap((g) => g.items.map((i) => i.value)));
    const extra = currentValue && !knownSet.has(currentValue)
        ? { value: currentValue, label: `${currentValue} (current)` }
        : null;
    return (_jsxs(Select, { value: value, onValueChange: onChange, children: [_jsx(SelectTrigger, { className: className, children: _jsx(SelectValue, { placeholder: placeholder }) }), _jsxs(SelectContent, { className: "max-h-80", children: [extra && (_jsxs(_Fragment, { children: [_jsx("div", { className: "px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground", children: "Current" }), _jsx(SelectItem, { value: extra.value, children: extra.label })] })), PG_COLUMN_TYPES.map((g) => (_jsxs("div", { children: [_jsx("div", { className: "px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground", children: g.group }), g.items.map((i) => (_jsx(SelectItem, { value: i.value, children: i.label ?? i.value }, i.value)))] }, g.group)))] })] }));
}
