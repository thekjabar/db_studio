import { useEffect, useState, Suspense } from "react";
import { Outlet, useParams, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { useViewport } from "@/lib/use-viewport";
import { FeedbackWidget } from "@/components/feedback-widget";
import { AnnouncementBanner } from "@/components/announcements";

export function AppShell() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { isMobile, isTablet } = useViewport();
  // Tablet: collapse sidebar by default (user can re-open).
  // Mobile: hide sidebar entirely; show as overlay when `mobileOpen`.
  const [collapsed, setCollapsed] = useState(isTablet && !isMobile);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [schema, setSchema] = useState<string>("public");

  // Draggable sidebar width (px), persisted. Clamped to a sane range.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("sidebarWidth"));
    return saved >= 180 && saved <= 480 ? saved : 240;
  });
  const startSidebarResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(480, Math.max(180, startW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      setSidebarWidth((w) => {
        localStorage.setItem("sidebarWidth", String(w));
        return w;
      });
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // When crossing breakpoints, update defaults.
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
    if (isTablet && !isMobile) setCollapsed(true);
    if (!isTablet) setCollapsed(false);
  }, [isMobile, isTablet]);

  // Close the mobile drawer after navigation.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const connQ = useQuery({
    queryKey: ["connection", id],
    queryFn: async () => (await api.listConnections()).find((c) => c.id === id),
    enabled: !!id,
  });

  const schemasQ = useQuery({
    queryKey: ["schemas", id],
    queryFn: () => api.listSchemas(id!),
    enabled: !!id,
  });

  // Initialize schema from available list
  useEffect(() => {
    if (schemasQ.data && schemasQ.data.length > 0 && !schemasQ.data.includes(schema)) {
      setSchema(schemasQ.data[0]);
    }
  }, [schemasQ.data]);

  // Crumbs from route
  const crumbs: { label: string; to?: string }[] = [];
  const path = location.pathname;
  if (path.includes("/sql")) crumbs.push({ label: "SQL Editor" });
  else if (path.includes("/er")) crumbs.push({ label: "ER Diagram" });
  else if (path.includes("/schema")) crumbs.push({ label: "Schema" });
  else if (path.includes("/audit")) crumbs.push({ label: "Audit" });
  else if (path.includes("/saved")) crumbs.push({ label: "Saved Queries" });
  else {
    const m = path.match(/\/t\/([^/]+)\/([^/]+)/);
    if (m) {
      crumbs.push({ label: decodeURIComponent(m[1]) });
      crumbs.push({ label: decodeURIComponent(m[2]) });
    }
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <AnnouncementBanner />
      <div className="flex-1 flex min-h-0">
      {id && !isMobile && (
        <Sidebar
          connectionId={id}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          currentSchema={schema}
          onSchemaChange={setSchema}
          width={collapsed ? undefined : sidebarWidth}
          onResizeStart={collapsed ? undefined : startSidebarResize}
        />
      )}
      {id && isMobile && mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed left-0 top-0 bottom-0 z-50">
            <Sidebar
              connectionId={id}
              collapsed={false}
              onToggleCollapse={() => setMobileOpen(false)}
              currentSchema={schema}
              onSchemaChange={setSchema}
            />
          </div>
        </>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          connection={connQ.data}
          onOpenPalette={() =>
            window.dispatchEvent(new CustomEvent("dbstudio:open-palette"))
          }
          crumbs={crumbs}
          onMenuClick={isMobile ? () => setMobileOpen(true) : undefined}
        />
        {/*
          overflow-y-auto lets static form/list pages (migration export,
          permissions, backup, etc.) scroll naturally. The fixed-height
          routes (SQL editor, table view, ER diagram) use `h-full flex` and
          manage their own internal scroll — they still render within the
          bounded flex row height here, so this doesn't break them.
        */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <Suspense
            fallback={
              <div className="h-full w-full flex items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            }
          >
            <Outlet context={{ schema, setSchema }} />
          </Suspense>
        </main>
      </div>
      </div>
      <FeedbackWidget />
    </div>
  );
}
