import { create } from "zustand";

/**
 * Browser-style tabs for a connection.
 *
 * Tabs are DERIVED FROM NAVIGATION rather than opened explicitly: `syncTab` is
 * called from the shell whenever the route changes, so every existing link —
 * the sidebar, the command palette, search results, deep links — opens or
 * focuses a tab without any of them needing to know tabs exist.
 *
 * Kept per connection, and persisted so a reload restores the working set the
 * way a browser does.
 */
export interface Tab {
  /** Route path under /c/:id, e.g. "t/public/users" or "sql". Identity of the tab. */
  path: string;
  title: string;
  /** Secondary line, e.g. the schema for a table tab. */
  subtitle?: string;
}

interface TabsState {
  /** connectionId -> ordered tabs */
  tabs: Record<string, Tab[]>;
  /** connectionId -> active tab path */
  active: Record<string, string>;
  syncTab: (connectionId: string, tab: Tab) => void;
  closeTab: (connectionId: string, path: string) => string | undefined;
  closeOthers: (connectionId: string, path: string) => void;
  closeAll: (connectionId: string) => void;
  reorder: (connectionId: string, from: number, to: number) => void;
}

const KEY = "qs.tabs.v1";

function load(): Pick<TabsState, "tabs" | "active"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") {
        return { tabs: p.tabs ?? {}, active: p.active ?? {} };
      }
    }
  } catch {
    /* corrupt or unavailable storage must never break the app */
  }
  return { tabs: {}, active: {} };
}

function persist(s: Pick<TabsState, "tabs" | "active">) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs: s.tabs, active: s.active }));
  } catch {
    /* quota / private mode — tabs still work for this session */
  }
}

/** Hard cap so a long session can't grow an unusable strip (or unbounded storage). */
const MAX_TABS = 20;

export const useTabs = create<TabsState>((set, get) => ({
  ...load(),

  syncTab: (connectionId, tab) => {
    const state = get();
    const list = state.tabs[connectionId] ?? [];
    const existing = list.find((t) => t.path === tab.path);
    // Already open → just focus it. Re-clicking a table must not duplicate it.
    let next = existing
      ? list.map((t) => (t.path === tab.path ? { ...t, ...tab } : t))
      : [...list, tab];
    if (next.length > MAX_TABS) {
      // Drop the oldest tab that isn't the one being opened.
      const victim = next.find((t) => t.path !== tab.path);
      if (victim) next = next.filter((t) => t.path !== victim.path);
    }
    const s = {
      tabs: { ...state.tabs, [connectionId]: next },
      active: { ...state.active, [connectionId]: tab.path },
    };
    persist({ ...state, ...s });
    set(s);
  },

  /** Returns the path to navigate to after closing, or undefined if none left. */
  closeTab: (connectionId, path) => {
    const state = get();
    const list = state.tabs[connectionId] ?? [];
    const idx = list.findIndex((t) => t.path === path);
    if (idx === -1) return state.active[connectionId];
    const next = list.filter((t) => t.path !== path);
    const wasActive = state.active[connectionId] === path;
    // Browser behaviour: focus the neighbour to the right, else the left.
    const fallback = next[idx]?.path ?? next[idx - 1]?.path;
    const nextActive = wasActive ? fallback : state.active[connectionId];
    const s = {
      tabs: { ...state.tabs, [connectionId]: next },
      active: { ...state.active, [connectionId]: nextActive ?? "" },
    };
    persist({ ...state, ...s });
    set(s);
    return wasActive ? fallback : undefined;
  },

  closeOthers: (connectionId, path) => {
    const state = get();
    const keep = (state.tabs[connectionId] ?? []).filter((t) => t.path === path);
    const s = {
      tabs: { ...state.tabs, [connectionId]: keep },
      active: { ...state.active, [connectionId]: path },
    };
    persist({ ...state, ...s });
    set(s);
  },

  closeAll: (connectionId) => {
    const state = get();
    const s = {
      tabs: { ...state.tabs, [connectionId]: [] },
      active: { ...state.active, [connectionId]: "" },
    };
    persist({ ...state, ...s });
    set(s);
  },

  reorder: (connectionId, from, to) => {
    const state = get();
    const list = [...(state.tabs[connectionId] ?? [])];
    if (from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    const s = { tabs: { ...state.tabs, [connectionId]: list }, active: state.active };
    persist({ ...state, ...s });
    set(s);
  },
}));

/** Human label for a route under /c/:id. Table routes carry the schema through. */
export function titleForPath(path: string): { title: string; subtitle?: string } {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "t" && parts.length >= 3) {
    return { title: decodeURIComponent(parts[2]), subtitle: decodeURIComponent(parts[1]) };
  }
  if (parts[0] === "t" && parts.length === 2) {
    return { title: decodeURIComponent(parts[1]), subtitle: "schema" };
  }
  const NAMES: Record<string, string> = {
    sql: "SQL Editor",
    builder: "Query builder",
    diff: "Diff",
    dictionary: "Data dictionary",
    sensitive: "Sensitive scan",
    er: "ER Diagram",
    schema: "Schema",
    audit: "Audit",
    "query-history": "Query history",
    "db-health": "DB health",
    reviews: "Reviews",
    "row-filters": "Row filters",
    docs: "Schema docs",
    ai: "AI chat",
    migrate: "Migration builder",
    saved: "Saved queries",
    permissions: "Permissions",
    "db-users": "DB users",
    backup: "Backup",
    "slow-queries": "Slow queries",
    "plan-regressions": "Plan regressions",
    "migration-export": "Migration export",
    webhooks: "Webhooks",
  };
  return { title: NAMES[parts[0] ?? ""] ?? parts[0] ?? "Tab" };
}
