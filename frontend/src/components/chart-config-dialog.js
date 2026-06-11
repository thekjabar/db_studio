import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
export function ChartConfigDialog({ open, onOpenChange, columns, initial, onSave }) {
    const [type, setType] = useState("bar");
    const [x, setX] = useState(columns[0] ?? "");
    const [y, setY] = useState(columns.slice(1, 2));
    const [stacked, setStacked] = useState(false);
    useEffect(() => {
        if (!open)
            return;
        if (initial) {
            setType(initial.type);
            setX(initial.x);
            setY(initial.y);
            setStacked(!!initial.stacked);
        }
        else {
            setType("bar");
            setX(columns[0] ?? "");
            setY(columns.slice(1, 2));
            setStacked(false);
        }
    }, [open, initial, columns]);
    const toggleY = (col) => {
        setY((prev) => (prev.includes(col) ? prev.filter((p) => p !== col) : [...prev, col]));
    };
    const apply = () => {
        if (!x || !y.length)
            return;
        onSave({ type, x, y, stacked: stacked || undefined });
        onOpenChange(false);
    };
    const clear = () => {
        onSave(null);
        onOpenChange(false);
    };
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "max-w-md", children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Configure chart" }), _jsx(DialogDescription, { children: "Pick a chart type, the X axis (category/time), and one or more Y columns (numeric)." })] }), _jsxs("div", { className: "space-y-4", children: [_jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Chart type" }), _jsxs(Select, { value: type, onValueChange: (v) => setType(v), children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, {}) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "bar", children: "Bar" }), _jsx(SelectItem, { value: "line", children: "Line" }), _jsx(SelectItem, { value: "area", children: "Area" }), _jsx(SelectItem, { value: "pie", children: "Pie" })] })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "X axis (category)" }), _jsxs(Select, { value: x, onValueChange: setX, children: [_jsx(SelectTrigger, { children: _jsx(SelectValue, { placeholder: "Pick a column" }) }), _jsx(SelectContent, { children: columns.map((c) => _jsx(SelectItem, { value: c, children: c }, c)) })] })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsxs(Label, { children: ["Y axis (numeric \u2014 ", type === "pie" ? "one" : "one or more", ")"] }), _jsx("div", { className: "flex flex-wrap gap-1 rounded-md border border-border p-2 max-h-32 overflow-auto", children: columns.map((c) => (_jsx("button", { type: "button", onClick: () => {
                                            if (type === "pie")
                                                setY([c]);
                                            else
                                                toggleY(c);
                                        }, className: [
                                            "px-2 py-0.5 rounded-sm text-[11px] font-mono border transition-colors",
                                            y.includes(c)
                                                ? "bg-primary/15 text-primary border-primary/30"
                                                : "border-border hover:bg-accent",
                                        ].join(" "), children: c }, c))) })] }), (type === "bar" || type === "area") && y.length > 1 && (_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(Switch, { checked: stacked, onCheckedChange: setStacked }), _jsx(Label, { children: "Stack series" })] }))] }), _jsxs(DialogFooter, { className: "gap-2", children: [initial && (_jsx(Button, { variant: "ghost", onClick: clear, className: "mr-auto text-destructive", children: "Remove chart" })), _jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { onClick: apply, disabled: !x || !y.length, children: "Save chart" })] })] }) }));
}
