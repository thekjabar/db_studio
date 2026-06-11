import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
/**
 * Top-level error boundary. Prevents a render error anywhere in the tree from
 * leaving the user with a blank screen. Shows the error message, a stack trace
 * (collapsed), and actions to retry / reload.
 *
 * Only catches React render errors — async errors surface via react-query / axios
 * and are handled elsewhere.
 */
export class ErrorBoundary extends React.Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        // eslint-disable-next-line no-console
        console.error("ErrorBoundary caught:", error, info.componentStack);
    }
    reset = () => this.setState({ error: null });
    reload = () => window.location.reload();
    render() {
        const { error } = this.state;
        if (!error)
            return this.props.children;
        return (_jsx("div", { className: "min-h-screen flex items-center justify-center bg-background p-6", children: _jsxs("div", { className: "max-w-lg w-full rounded-lg border border-border bg-card shadow-xl p-6 space-y-4", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "h-9 w-9 rounded-full bg-destructive/15 border border-destructive/30 flex items-center justify-center shrink-0", children: _jsx(AlertTriangle, { className: "h-4 w-4 text-destructive" }) }), _jsxs("div", { className: "min-w-0", children: [_jsx("h2", { className: "font-semibold", children: "Something went wrong" }), _jsxs("p", { className: "text-xs text-muted-foreground", children: [this.props.label ?? "An unexpected error broke this view.", " You can try again, or reload the app."] })] })] }), _jsx("div", { className: "rounded-md border border-border bg-muted/40 px-3 py-2 text-xs font-mono break-words", children: error.message || "Unknown error" }), error.stack && (_jsxs("details", { className: "text-[11px] text-muted-foreground", children: [_jsx("summary", { className: "cursor-pointer select-none hover:text-foreground", children: "Show technical details" }), _jsx("pre", { className: "mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-mono text-[10px]", children: error.stack })] })), _jsxs("div", { className: "flex items-center justify-end gap-2", children: [_jsx(Button, { variant: "outline", size: "sm", onClick: this.reset, children: "Try again" }), _jsxs(Button, { size: "sm", onClick: this.reload, children: [_jsx(RefreshCw, { className: "h-3.5 w-3.5" }), " Reload"] })] })] }) }));
    }
}
