import { useEffect, useState } from "react";
import { Outlet, useParams, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Sidebar } from "./sidebar";
import { TopBar } from "./topbar";
import { CommandPalette } from "../command-palette";
import { useViewport } from "@/lib/use-viewport";

export function AppShell() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { isMobile, isTablet } = useViewport();
  // Tablet: collapse sidebar by default (user can re-open).
  // Mobile: hide sidebar entirely; show as overlay when `mobileOpen`.
  const [collapsed, setCollapsed] = useState(isTablet && !isMobile);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [schema, setSchema] = useState<string>("public");

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
    <div className="h-screen w-screen flex bg-background text-foreground overflow-hidden">
      {id && !isMobile && (
        <Sidebar
          connectionId={id}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          currentSchema={schema}
          onSchemaChange={setSchema}
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
          onOpenPalette={() => setPaletteOpen(true)}
          crumbs={crumbs}
          onMenuClick={isMobile ? () => setMobileOpen(true) : undefined}
        />
        <main className="flex-1 overflow-hidden">
          <Outlet context={{ schema, setSchema }} />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} connectionId={id} schema={schema} />
    </div>
  );
}
