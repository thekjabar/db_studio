import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ColumnTypeSelect } from "@/components/column-type-select";
export function RetypeColumnDialog({ open, columnName, currentType, onOpenChange, onConfirm }) {
    const [value, setValue] = useState(currentType);
    useEffect(() => {
        if (open)
            setValue(currentType);
    }, [open, currentType]);
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { className: "max-w-md", children: [_jsxs(DialogHeader, { children: [_jsxs(DialogTitle, { children: ["Change type of ", _jsx("code", { className: "font-mono text-primary", children: columnName })] }), _jsx(DialogDescription, { children: "Pick the new Postgres type. Incompatible conversions will fail when applied." })] }), _jsxs("div", { className: "space-y-1.5", children: [_jsx(Label, { children: "Type" }), _jsx(ColumnTypeSelect, { value: value, onChange: setValue, currentValue: currentType }), _jsxs("p", { className: "text-[11px] text-muted-foreground", children: ["Current: ", _jsx("span", { className: "font-mono", children: currentType })] })] }), _jsxs(DialogFooter, { className: "gap-2", children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { onClick: () => onConfirm(value), disabled: !value || value === currentType, children: "Apply" })] })] }) }));
}
