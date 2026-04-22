import { useMemo, useState } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Database,
  FileClock,
  Network,
  Search,
  Table2,
  Eye,
  BookOpen,
  Hammer,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  connectionId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  currentSchema: string;
  onSchemaChange: (s: string) => void;
}

export function Sidebar({ connectionId, collapsed, onToggleCollapse, currentSchema, onSchemaChange }: Props) {
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
    if (!filter) return list;
    return list.filter((t) => t.name.toLowerCase().includes(filter.toLowerCase()));
  }, [tablesQ.data, filter]);

  if (collapsed) {
    return (
      <aside className="w-12 shrink-0 border-r border-border bg-card flex flex-col items-center py-3 gap-2">
        <Button size="icon" variant="ghost" onClick={onToggleCollapse} title="Expand">
          <ChevronsRight className="h-4 w-4" />
        </Button>
        <NavLink to={`/c/${connectionId}/sql`} title="SQL Editor" className={({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary")}>
          <Code2 className="h-4 w-4" />
        </NavLink>
        <NavLink to={`/c/${connectionId}/er`} title="ER Diagram" className={({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary")}>
          <Network className="h-4 w-4" />
        </NavLink>
        <NavLink to={`/c/${connectionId}/schema`} title="Schema" className={({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary")}>
          <Hammer className="h-4 w-4" />
        </NavLink>
        <NavLink to={`/c/${connectionId}/audit`} title="Audit" className={({ isActive }) => cn("p-2 rounded-md hover:bg-accent", isActive && "bg-accent text-primary")}>
          <FileClock className="h-4 w-4" />
        </NavLink>
      </aside>
    );
  }

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <Link to="/connections" className="flex items-center gap-2 font-semibold text-sm">
          <Database className="h-4 w-4 text-primary" />
          <span>DB Studio</span>
        </Link>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onToggleCollapse}>
          <ChevronsLeft className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="p-3 space-y-2 border-b border-border">
        <div>
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Schema</label>
          <Select value={currentSchema} onValueChange={onSchemaChange}>
            <SelectTrigger className="h-8 mt-1 text-xs font-mono">
              <SelectValue placeholder={schemasQ.isLoading ? "Loading..." : "Select schema"} />
            </SelectTrigger>
            <SelectContent>
              {(schemasQ.data ?? []).map((s) => (
                <SelectItem key={s} value={s} className="font-mono text-xs">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search tables..."
            className="w-full h-8 pl-7 pr-2 text-xs bg-background border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {tablesQ.isLoading && <div className="px-3 py-2 text-xs text-muted-foreground">Loading tables...</div>}
        {tablesQ.error && (
          <div className="px-3 py-2 text-xs text-destructive">Failed to load tables</div>
        )}
        {!tablesQ.isLoading && filtered.length === 0 && (
          <div className="px-3 py-6 text-[11px] text-muted-foreground text-center">
            {filter
              ? <>No tables match <span className="font-mono text-foreground">{filter}</span>.</>
              : tablesQ.data && tablesQ.data.length === 0
                ? <>Schema <span className="font-mono text-foreground">{currentSchema}</span> has no tables.</>
                : "No tables"}
          </div>
        )}
        <ul className="px-1">
          {filtered.map((t) => {
            const Icon = t.type === "view" ? Eye : Table2;
            const active = currentTable === t.name;
            return (
              <li key={t.name}>
                <NavLink
                  to={`/c/${connectionId}/t/${encodeURIComponent(currentSchema)}/${encodeURIComponent(t.name)}`}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 rounded text-xs font-mono hover:bg-accent transition-colors",
                    active && "bg-accent text-primary"
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate flex-1">{t.name}</span>
                  {t.rowEstimate !== undefined && (
                    <span className="text-[10px] text-muted-foreground">{t.rowEstimate}</span>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </div>

      <nav className="border-t border-border p-1 space-y-0.5">
        <NavItem to={`/c/${connectionId}/sql`} icon={<Code2 className="h-3.5 w-3.5" />} label="SQL Editor" />
        <NavItem to={`/c/${connectionId}/er`} icon={<Network className="h-3.5 w-3.5" />} label="ER Diagram" />
        <NavItem to={`/c/${connectionId}/schema`} icon={<Hammer className="h-3.5 w-3.5" />} label="Schema" />
        <NavItem to={`/c/${connectionId}/saved`} icon={<BookOpen className="h-3.5 w-3.5" />} label="Saved queries" />
        <NavItem to={`/c/${connectionId}/audit`} icon={<FileClock className="h-3.5 w-3.5" />} label="Audit log" />
        <NavItem to={`/c/${connectionId}/permissions`} icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Permissions" />
      </nav>
    </aside>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn("flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent transition-colors", isActive && "bg-accent text-primary")
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
