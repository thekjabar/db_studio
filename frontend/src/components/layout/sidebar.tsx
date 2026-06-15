import { useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
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
  Archive,
  Timer,
  FileCode2,
  Webhook,
  History,
  Activity,
  Filter,
  BookMarked,
  Sparkles,
  Blocks,
  BookOpenText,
  GitCompare,
  ScanSearch,
  TrendingDown,
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

      <nav className="border-t border-border p-1 space-y-0.5 overflow-y-auto">
        {/* Always-visible core — these are used on every session, no point
            hiding them behind a toggle. */}
        <NavItem to={`/c/${connectionId}/sql`} icon={<Code2 className="h-3.5 w-3.5" />} label="SQL Editor" />
        <NavItem to={`/c/${connectionId}/builder`} icon={<Blocks className="h-3.5 w-3.5" />} label="Query builder" />
        <NavItem to={`/c/${connectionId}/dictionary`} icon={<BookOpenText className="h-3.5 w-3.5" />} label="Data dictionary" />
        <NavItem to={`/c/${connectionId}/er`} icon={<Network className="h-3.5 w-3.5" />} label="ER Diagram" />
        <NavItem to={`/c/${connectionId}/schema`} icon={<Hammer className="h-3.5 w-3.5" />} label="Schema" />
        <NavItem to={`/c/${connectionId}/ai`} icon={<Sparkles className="h-3.5 w-3.5" />} label="AI chat" />

        <NavSection
          label="History"
          storageKey="sidebar.history"
          paths={["/saved", "/query-history", "/audit"]}
          connectionId={connectionId}
        >
          <NavItem to={`/c/${connectionId}/saved`} icon={<BookOpen className="h-3.5 w-3.5" />} label="Saved queries" />
          <NavItem to={`/c/${connectionId}/query-history`} icon={<History className="h-3.5 w-3.5" />} label="Query history" />
          <NavItem to={`/c/${connectionId}/audit`} icon={<FileClock className="h-3.5 w-3.5" />} label="Audit log" />
        </NavSection>

        <NavSection
          label="Performance"
          storageKey="sidebar.perf"
          paths={["/slow-queries", "/plan-regressions", "/db-health", "/reviews"]}
          connectionId={connectionId}
        >
          <NavItem to={`/c/${connectionId}/slow-queries`} icon={<Timer className="h-3.5 w-3.5" />} label="Slow queries" />
          <NavItem to={`/c/${connectionId}/plan-regressions`} icon={<TrendingDown className="h-3.5 w-3.5" />} label="Plan regressions" />
          <NavItem to={`/c/${connectionId}/db-health`} icon={<Activity className="h-3.5 w-3.5" />} label="DB health" />
          <NavItem to={`/c/${connectionId}/reviews`} icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Query reviews" />
          <NavItem to={`/c/${connectionId}/diff`} icon={<GitCompare className="h-3.5 w-3.5" />} label="Compare results" />
        </NavSection>

        <NavSection
          label="Governance"
          storageKey="sidebar.gov"
          paths={["/row-filters", "/docs", "/permissions"]}
          connectionId={connectionId}
        >
          <NavItem to={`/c/${connectionId}/docs`} icon={<BookMarked className="h-3.5 w-3.5" />} label="Docs" />
          <NavItem to={`/c/${connectionId}/row-filters`} icon={<Filter className="h-3.5 w-3.5" />} label="Row filters" />
          <NavItem to={`/c/${connectionId}/permissions`} icon={<ShieldCheck className="h-3.5 w-3.5" />} label="Permissions" />
          <NavItem to={`/c/${connectionId}/sensitive`} icon={<ScanSearch className="h-3.5 w-3.5" />} label="Sensitive data" />
        </NavSection>

        <NavSection
          label="Admin"
          storageKey="sidebar.admin"
          paths={["/migrate", "/migration-export", "/backup", "/webhooks"]}
          connectionId={connectionId}
        >
          <NavItem to={`/c/${connectionId}/migrate`} icon={<FileCode2 className="h-3.5 w-3.5" />} label="Migration builder" />
          <NavItem to={`/c/${connectionId}/migration-export`} icon={<FileCode2 className="h-3.5 w-3.5" />} label="Migration export" />
          <NavItem to={`/c/${connectionId}/backup`} icon={<Archive className="h-3.5 w-3.5" />} label="Backup" />
          <NavItem to={`/c/${connectionId}/webhooks`} icon={<Webhook className="h-3.5 w-3.5" />} label="Webhooks" />
        </NavSection>
      </nav>
    </aside>
  );
}

/**
 * Collapsible nav section. Auto-expands when the user is on one of its
 * child routes so they can see where they are even after reloading.
 * Preference stored in localStorage keyed by section so opens survive
 * reloads and aren't per-connection.
 */
function NavSection({
  label,
  storageKey,
  paths,
  connectionId,
  children,
}: {
  label: string;
  storageKey: string;
  paths: string[];
  connectionId: string;
  children: ReactNode;
}) {
  const loc = useLocation();
  // Auto-open when navigating into any child path. Guarded so a user who
  // manually collapses the section isn't fought by the auto-expand.
  const containsActive = paths.some((p) => loc.pathname.includes(`/c/${connectionId}${p}`));
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored != null) return stored === "1";
    } catch {
      /* ignore */
    }
    return containsActive;
  });
  // If the user navigates into the section from elsewhere, open it once.
  // We don't close on navigation out — that's annoying when bouncing between
  // tabs.
  useMemo(() => {
    if (containsActive && !open) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containsActive]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] uppercase font-medium tracking-wider text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span>{label}</span>
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
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
