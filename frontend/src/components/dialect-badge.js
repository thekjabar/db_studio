import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Database } from "lucide-react";
import { cn } from "@/lib/utils";
const COLOR = {
    POSTGRES: "bg-sky-500/15 text-sky-400 border-sky-500/30",
    MYSQL: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    SQLITE: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    MSSQL: "bg-red-500/15 text-red-400 border-red-500/30",
};
const LABEL = {
    POSTGRES: "Postgres",
    MYSQL: "MySQL",
    SQLITE: "SQLite",
    MSSQL: "MSSQL",
};
export function DialectBadge({ dialect, className }) {
    return (_jsxs("span", { className: cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", COLOR[dialect], className), children: [_jsx(Database, { className: "h-3 w-3" }), LABEL[dialect]] }));
}
