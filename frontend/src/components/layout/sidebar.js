import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Code2, Database, FileClock, Network, Search, Table2, Eye, BookOpen, Hammer, ShieldCheck, Archive, Timer, FileCode2, Webhook, History, Activity, Filter, BookMarked, Sparkles, Blocks, BookOpenText, GitCompare, ScanSearch, TrendingDown, } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from "@/components/ui/select";
export function Sidebar({ connectionId, collapsed, onToggleCollapse, currentSchema, onSchemaChange, width, onResizeStart }) {
    const [filter, setFilter] = useState("");
    const params = useParams();
    const currentTable = params.table;
    const schemasQ = useQuery({
        queryKey: ["schemas", connectionId],
        queryFn: () => api.listSchemas(connectionId),
    });
    const tablesQ = useQuery({
        queryKey: ["tables", connectionId, currentSchema],
        queryFn: () => api.listTables(connectionId, currentSchema),
        enabled: !!currentSchema,
    });
    const filtered = useMemo(() => {
        const list = tablesQ.data ?? [];
        if (!filter)
            return list;
        return list.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
    }, [tablesQ.data, filter]);
    if (collapsed) {
        return (_jsxs("aside", { className: "w-12 shrink-0 border-r border-border bg-card flex flex-col items-center py-3 gap-2", children: [_jsx(Button, { size: "icon", variant: "ghost", onClick: onToggleCollapse, title: "Expand", children: _jsx(ChevronsRight, { className: "h-4 w-4" }) }), _jsx(NavLink, { to: `/c/${connectionId}/sql`, title: "SQL Editor", className: ({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary"), children: _jsx(Code2, { className: "h-4 w-4" }) }), _jsx(NavLink, { to: `/c/${connectionId}/er`, title: "ER Diagram", className: ({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary"), children: _jsx(Network, { className: "h-4 w-4" }) }), _jsx(NavLink, { to: `/c/${connectionId}/schema`, title: "Schema", className: ({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary"), children: _jsx(Hammer, { className: "h-4 w-4" }) }), _jsx(NavLink, { to: `/c/${connectionId}/audit`, title: "Audit", className: ({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary"), children: _jsx(FileClock, { className: "h-4 w-4" }) })] }));
    }
    return (_jsxs("aside", { className: cn("shrink-0 border-r border-border bg-card flex flex-col h-full relative", width == null && "w-60"), style: width != null ? { width } : undefined, children: [_jsxs("div", { className: "flex items-center justify-between px-3 py-2 border-b border-border", children: [_jsxs(Link, { to: "/connections", className: "flex items-center gap-2 font-semibold text-sm", children: [_jsx(Database, { className: "h-4 w-4 text-primary" }), _jsx("span", { children: "DB Studio" })] }), _jsx(Button, { size: "icon", variant: "ghost", className: "h-6 w-6", onClick: onToggleCollapse, children: _jsx(ChevronsLeft, { className: "h-3.5 w-3.5" }) })] }), _jsxs("div", { className: "p-3 space-y-2 border-b border-border", children: [_jsxs("div", { children: [_jsx("label", { className: "text-[10px] font-medium text-muted-foreground uppercase tracking-wide", children: "Schema" }), _jsxs(Select, { value: currentSchema, onValueChange: onSchemaChange, children: [_jsx(SelectTrigger, { className: "h-8 mt-1 text-xs font-mono", children: _jsx(SelectValue, { placeholder: schemasQ.isLoading ? "Loading..." : "Select schema" }) }), _jsx(SelectContent, { children: (schemasQ.data ?? []).map((s) => (_jsx(SelectItem, { value: s, className: "font-mono text-xs", children: s }, s))) })] })] }), _jsxs("div", { className: "relative", children: [_jsx(Search, { className: "absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" }), _jsx("input", { value: filter, onChange: (e) => setFilter(e.target.value), placeholder: "Search tables...", className: "w-full h-8 pl-7 pr-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-ring" })] })] }), _jsxs("div", { className: "flex-1 overflow-y-auto py-1", children: [tablesQ.isLoading && _jsx("div", { className: "px-3 py-2 text-xs text-muted-foreground", children: "Loading tables..." }), tablesQ.error && (_jsx("div", { className: "px-3 py-2 text-xs text-destructive", children: "Failed to load tables" })), !tablesQ.isLoading && filtered.length === 0 && (_jsx("div", { className: "px-3 py-6 text-[11px] text-muted-foreground text-center", children: filter
                            ? _jsxs(_Fragment, { children: ["No tables match ", _jsx("span", { className: "font-mono text-foreground", children: filter }), "."] })
                            : tablesQ.data && tablesQ.data.length === 0
                                ? _jsxs(_Fragment, { children: ["Schema ", _jsx("span", { className: "font-mono text-foreground", children: currentSchema }), " has no tables."] })
                                : "No tables" })), _jsx("ul", { className: "px-1", children: filtered.map((t) => {
                            const Icon = t.type === "view" ? Eye : Table2;
                            const active = currentTable === t.name;
                            return (_jsx("li", { children: _jsxs(NavLink, { to: `/c/${connectionId}/t/${encodeURIComponent(currentSchema)}/${encodeURIComponent(t.name)}`, className: cn("flex items-center gap-2 px-2 py-1 rounded text-xs font-mono hover:bg-accent transition-colors", active && "bg-accent text-primary"), children: [_jsx(Icon, { className: "h-3.5 w-3.5 shrink-0 text-muted-foreground" }), _jsx("span", { className: "truncate flex-1", children: t.name }), t.rowEstimate !== undefined && (_jsx("span", { className: "text-[10px] text-muted-foreground", children: t.rowEstimate }))] }) }, t.name));
                        }) })] }), _jsxs("nav", { className: "border-t border-border p-1 space-y-0.5 overflow-y-auto", children: [_jsx(NavItem, { to: `/c/${connectionId}/sql`, icon: _jsx(Code2, { className: "h-3.5 w-3.5" }), label: "SQL Editor" }), _jsx(NavItem, { to: `/c/${connectionId}/builder`, icon: _jsx(Blocks, { className: "h-3.5 w-3.5" }), label: "Query builder" }), _jsx(NavItem, { to: `/c/${connectionId}/dictionary`, icon: _jsx(BookOpenText, { className: "h-3.5 w-3.5" }), label: "Data dictionary" }), _jsx(NavItem, { to: `/c/${connectionId}/er`, icon: _jsx(Network, { className: "h-3.5 w-3.5" }), label: "ER Diagram" }), _jsx(NavItem, { to: `/c/${connectionId}/schema`, icon: _jsx(Hammer, { className: "h-3.5 w-3.5" }), label: "Schema" }), _jsx(NavItem, { to: `/c/${connectionId}/ai`, icon: _jsx(Sparkles, { className: "h-3.5 w-3.5" }), label: "AI chat" }), _jsxs(NavSection, { label: "History", storageKey: "sidebar.history", paths: ["/saved", "/query-history", "/audit"], connectionId: connectionId, children: [_jsx(NavItem, { to: `/c/${connectionId}/saved`, icon: _jsx(BookOpen, { className: "h-3.5 w-3.5" }), label: "Saved queries" }), _jsx(NavItem, { to: `/c/${connectionId}/query-history`, icon: _jsx(History, { className: "h-3.5 w-3.5" }), label: "Query history" }), _jsx(NavItem, { to: `/c/${connectionId}/audit`, icon: _jsx(FileClock, { className: "h-3.5 w-3.5" }), label: "Audit log" })] }), _jsxs(NavSection, { label: "Performance", storageKey: "sidebar.perf", paths: ["/slow-queries", "/plan-regressions", "/db-health", "/reviews"], connectionId: connectionId, children: [_jsx(NavItem, { to: `/c/${connectionId}/slow-queries`, icon: _jsx(Timer, { className: "h-3.5 w-3.5" }), label: "Slow queries" }), _jsx(NavItem, { to: `/c/${connectionId}/plan-regressions`, icon: _jsx(TrendingDown, { className: "h-3.5 w-3.5" }), label: "Plan regressions" }), _jsx(NavItem, { to: `/c/${connectionId}/db-health`, icon: _jsx(Activity, { className: "h-3.5 w-3.5" }), label: "DB health" }), _jsx(NavItem, { to: `/c/${connectionId}/reviews`, icon: _jsx(ShieldCheck, { className: "h-3.5 w-3.5" }), label: "Query reviews" }), _jsx(NavItem, { to: `/c/${connectionId}/diff`, icon: _jsx(GitCompare, { className: "h-3.5 w-3.5" }), label: "Compare results" })] }), _jsxs(NavSection, { label: "Governance", storageKey: "sidebar.gov", paths: ["/row-filters", "/docs", "/permissions"], connectionId: connectionId, children: [_jsx(NavItem, { to: `/c/${connectionId}/docs`, icon: _jsx(BookMarked, { className: "h-3.5 w-3.5" }), label: "Docs" }), _jsx(NavItem, { to: `/c/${connectionId}/row-filters`, icon: _jsx(Filter, { className: "h-3.5 w-3.5" }), label: "Row filters" }), _jsx(NavItem, { to: `/c/${connectionId}/permissions`, icon: _jsx(ShieldCheck, { className: "h-3.5 w-3.5" }), label: "Permissions" }), _jsx(NavItem, { to: `/c/${connectionId}/sensitive`, icon: _jsx(ScanSearch, { className: "h-3.5 w-3.5" }), label: "Sensitive data" })] }), _jsxs(NavSection, { label: "Admin", storageKey: "sidebar.admin", paths: ["/migrate", "/migration-export", "/backup", "/webhooks"], connectionId: connectionId, children: [_jsx(NavItem, { to: `/c/${connectionId}/migrate`, icon: _jsx(FileCode2, { className: "h-3.5 w-3.5" }), label: "Migration builder" }), _jsx(NavItem, { to: `/c/${connectionId}/migration-export`, icon: _jsx(FileCode2, { className: "h-3.5 w-3.5" }), label: "Migration export" }), _jsx(NavItem, { to: `/c/${connectionId}/backup`, icon: _jsx(Archive, { className: "h-3.5 w-3.5" }), label: "Backup" }), _jsx(NavItem, { to: `/c/${connectionId}/webhooks`, icon: _jsx(Webhook, { className: "h-3.5 w-3.5" }), label: "Webhooks" })] })] }), onResizeStart && (_jsx("div", { onPointerDown: onResizeStart, className: "absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-primary/50 active:bg-primary z-10", title: "Drag to resize sidebar" }))] }));
}
/**
 * Collapsible nav section. Auto-expands when the user is on one of its
 * child routes so they can see where they are even after reloading.
 * Preference stored in localStorage keyed by section so opens survive
 * reloads and aren't per-connection.
 */
function NavSection({ label, storageKey, paths, connectionId, children, }) {
    const loc = useLocation();
    // Auto-open when navigating into any child path. Guarded so a user who
    // manually collapses the section isn't fought by the auto-expand.
    const containsActive = paths.some((p) => loc.pathname.includes(`/c/${connectionId}${p}`));
    const [open, setOpen] = useState(() => {
        try {
            const stored = localStorage.getItem(storageKey);
            if (stored != null)
                return stored === "1";
        }
        catch {
            /* ignore */
        }
        return containsActive;
    });
    // If the user navigates into the section from elsewhere, open it once.
    // We don't close on navigation out — that's annoying when bouncing between
    // tabs.
    useMemo(() => {
        if (containsActive && !open)
            setOpen(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [containsActive]);
    const toggle = () => {
        const next = !open;
        setOpen(next);
        try {
            localStorage.setItem(storageKey, next ? "1" : "0");
        }
        catch {
            /* ignore */
        }
    };
    return (_jsxs("div", { children: [_jsxs("button", { type: "button", onClick: toggle, className: "w-full flex items-center gap-1 px-2 py-1 text-[10px] uppercase font-medium tracking-wider text-muted-foreground hover:text-foreground", children: [open ? (_jsx(ChevronDown, { className: "h-3 w-3" })) : (_jsx(ChevronRight, { className: "h-3 w-3" })), _jsx("span", { children: label })] }), open && _jsx("div", { className: "space-y-0.5", children: children })] }));
}
function NavItem({ to, icon, label }) {
    return (_jsxs(NavLink, { to: to, className: ({ isActive }) => cn("flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors", isActive && "bg-accent text-primary"), children: [icon, _jsx("span", { children: label })] }));
}
