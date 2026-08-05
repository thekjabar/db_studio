import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Table2, X } from "lucide-react";
import { titleForPath, useTabs } from "../../lib/tabs-store";

/**
 * Browser-style tab strip for a connection.
 *
 * It does not own navigation — it mirrors it. Any route change under /c/:id
 * opens or focuses a tab (see the `syncTab` effect), so links elsewhere in the
 * app keep working untouched and deep links restore correctly.
 */
export function TabBar() {
  const { id: connectionId } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, active, syncTab, closeTab, closeOthers, closeAll } = useTabs();
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Path relative to /c/:id — the tab's identity.
  const rel = connectionId
    ? location.pathname.replace(`/c/${connectionId}`, "").replace(/^\//, "")
    : "";

  useEffect(() => {
    if (!connectionId || !rel) return;
    const { title, subtitle } = titleForPath(rel);
    syncTab(connectionId, { path: rel, title, subtitle });
    // syncTab is stable (zustand); re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, rel]);

  // Keep the active tab in view when it changes via the sidebar.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [rel]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  if (!connectionId) return null;
  const list = tabs[connectionId] ?? [];
  if (list.length === 0) return null;
  const activePath = active[connectionId];

  function go(path: string) {
    navigate(`/c/${connectionId}/${path}`);
  }

  function onClose(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    e.preventDefault();
    const next = closeTab(connectionId!, path);
    // Only navigate when the tab being closed was the visible one.
    if (next) go(next);
    else if (next === undefined && activePath === path) navigate(`/c/${connectionId}/sql`);
  }

  return (
    <div className="relative border-b border-border bg-muted/30">
      <div
        ref={stripRef}
        className="flex items-stretch gap-px overflow-x-auto scrollbar-thin"
        role="tablist"
      >
        {list.map((t) => {
          const isActive = t.path === activePath;
          const isTable = t.path.startsWith("t/");
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={isActive}
              data-active={isActive}
              onClick={() => go(t.path)}
              onAuxClick={(e) => {
                // Middle-click closes, like a browser.
                if (e.button === 1) onClose(e as unknown as React.MouseEvent, t.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, path: t.path });
              }}
              title={t.subtitle ? `${t.subtitle}.${t.title}` : t.title}
              className={[
                "group flex min-w-[8rem] max-w-[16rem] shrink-0 cursor-pointer items-center gap-2",
                "border-r border-border px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-background text-foreground shadow-[inset_0_2px_0_0_hsl(var(--primary))]"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              ].join(" ")}
            >
              {isTable && <Table2 className="h-3.5 w-3.5 shrink-0 opacity-70" />}
              <span className="truncate">{t.title}</span>
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                onClick={(e) => onClose(e, t.path)}
                className="ml-auto shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-[10rem] rounded-md border border-border bg-popover p-1 text-sm shadow-md"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
            onClick={() => {
              const next = closeTab(connectionId, menu.path);
              if (next) go(next);
              setMenu(null);
            }}
          >
            Close
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
            onClick={() => {
              closeOthers(connectionId, menu.path);
              go(menu.path);
              setMenu(null);
            }}
          >
            Close others
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
            onClick={() => {
              closeAll(connectionId);
              navigate(`/c/${connectionId}/sql`);
              setMenu(null);
            }}
          >
            Close all
          </button>
        </div>
      )}
    </div>
  );
}
