import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, } from "@/components/ui/command";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Archive, BookOpen, Calendar, Code2, Database, FileClock, FileCode2, Hammer, Key, Network, ShieldCheck, Table2, Timer, Webhook, Workflow, } from "lucide-react";
export function CommandPalette({ open, onOpenChange, connectionId, schema }) {
    const nav = useNavigate();
    const tablesQ = useQuery({
        queryKey: ["palette-tables", connectionId, schema],
        queryFn: () => api.listTables(connectionId, schema),
        enabled: open && !!connectionId && !!schema,
    });
    const connsQ = useQuery({
        queryKey: ["palette-connections"],
        queryFn: () => api.listConnections(),
        enabled: open,
    });
    const savedQ = useQuery({
        queryKey: ["palette-saved", connectionId],
        queryFn: () => api.listSavedQueries(connectionId),
        enabled: open && !!connectionId,
    });
    useEffect(() => {
        const h = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                onOpenChange(!open);
            }
        };
        window.addEventListener("keydown", h);
        return () => window.removeEventListener("keydown", h);
    }, [open, onOpenChange]);
    const go = (to) => {
        onOpenChange(false);
        nav(to);
    };
    return (_jsxs(CommandDialog, { open: open, onOpenChange: onOpenChange, children: [_jsx(CommandInput, { placeholder: "Type a command or search\u2026" }), _jsxs(CommandList, { children: [_jsx(CommandEmpty, { children: "No results." }), connectionId && (_jsx(_Fragment, { children: _jsxs(CommandGroup, { heading: "Navigate", children: [_jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/sql`), children: [_jsx(Code2, {}), " SQL Editor"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/er`), children: [_jsx(Network, {}), " ER Diagram"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/schema`), children: [_jsx(Hammer, {}), " Schema"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/saved`), children: [_jsx(BookOpen, {}), " Saved queries"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/audit`), children: [_jsx(FileClock, {}), " Audit log"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/slow-queries`), children: [_jsx(Timer, {}), " Slow queries"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/permissions`), children: [_jsx(ShieldCheck, {}), " Permissions"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/backup`), children: [_jsx(Archive, {}), " Backup"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/migration-export`), children: [_jsx(FileCode2, {}), " Migration export"] }), _jsxs(CommandItem, { onSelect: () => go(`/c/${connectionId}/webhooks`), children: [_jsx(Webhook, {}), " Webhooks"] })] }) })), _jsxs(CommandGroup, { heading: "Global", children: [_jsxs(CommandItem, { onSelect: () => go(`/connections`), children: [_jsx(Database, {}), " All connections"] }), _jsxs(CommandItem, { onSelect: () => go(`/schedules`), children: [_jsx(Calendar, {}), " Scheduled queries"] }), _jsxs(CommandItem, { onSelect: () => go(`/federated`), children: [_jsx(Workflow, {}), " Multi-DB query"] }), _jsxs(CommandItem, { onSelect: () => go(`/api-keys`), children: [_jsx(Key, {}), " API keys"] })] }), connectionId && schema && (tablesQ.data?.length ?? 0) > 0 && (_jsx(_Fragment, { children: _jsx(CommandGroup, { heading: "Tables", children: tablesQ.data.map((t) => (_jsxs(CommandItem, { value: `table ${t.name}`, onSelect: () => go(`/c/${connectionId}/t/${encodeURIComponent(schema)}/${encodeURIComponent(t.name)}`), children: [_jsx(Table2, {}), " ", _jsx("span", { className: "font-mono", children: t.name })] }, t.name))) }) })), (savedQ.data?.length ?? 0) > 0 && (_jsx(_Fragment, { children: _jsx(CommandGroup, { heading: "Saved queries", children: savedQ.data.slice(0, 20).map((s) => (_jsxs(CommandItem, { value: `saved ${s.name}`, onSelect: () => go(`/c/${connectionId}/saved#${s.id}`), children: [_jsx(BookOpen, {}), " ", s.name] }, s.id))) }) })), (connsQ.data?.length ?? 0) > 0 && (_jsx(_Fragment, { children: _jsx(CommandGroup, { heading: "Connections", children: connsQ.data.map((c) => (_jsxs(CommandItem, { value: `conn ${c.name}`, onSelect: () => go(`/c/${c.id}`), children: [_jsx(Database, {}), " ", c.name] }, c.id))) }) }))] })] }));
}
