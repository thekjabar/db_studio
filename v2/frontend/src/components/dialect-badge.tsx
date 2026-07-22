import { Database } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Dialect } from "@/lib/api";

const COLOR: Record<Dialect, string> = {
  POSTGRES: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  MYSQL: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  SQLITE: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  MSSQL: "bg-red-500/15 text-red-400 border-red-500/30",
};

const LABEL: Record<Dialect, string> = {
  POSTGRES: "Postgres",
  MYSQL: "MySQL",
  SQLITE: "SQLite",
  MSSQL: "MSSQL",
};

export function DialectBadge({ dialect, className }: { dialect: Dialect; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        COLOR[dialect],
        className
      )}
    >
      <Database className="h-3 w-3" />
      {LABEL[dialect]}
    </span>
  );
}
