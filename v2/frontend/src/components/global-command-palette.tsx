import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { CommandPalette } from "@/components/command-palette";

/**
 * Single global command palette. Mounted at app root so Ctrl+K works on
 * every route, including ones outside the connection shell (/connections,
 * /schedules, /api-keys, …). The TopBar's "Search" button dispatches a
 * `dbstudio:open-palette` CustomEvent instead of holding its own state, so
 * there's only one instance of the dialog in the tree.
 */
export function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const m = pathname.match(/^\/c\/([^/]+)/);
  const connectionId = m ? m[1] : undefined;

  useEffect(() => {
    const listener = () => setOpen(true);
    window.addEventListener("dbstudio:open-palette", listener);
    return () => window.removeEventListener("dbstudio:open-palette", listener);
  }, []);

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      connectionId={connectionId}
    />
  );
}
