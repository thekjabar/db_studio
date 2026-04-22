import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Code2, Database, FileClock, Hammer, Network, Table2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connectionId?: string;
  schema?: string;
}

export function CommandPalette({ open, onOpenChange, connectionId, schema }: Props) {
  const nav = useNavigate();

  const tablesQ = useQuery({
    queryKey: ["palette-tables", connectionId, schema],
    queryFn: () => api.listTables(connectionId!, schema!),
    enabled: open && !!connectionId && !!schema,
  });

  const connsQ = useQuery({
    queryKey: ["palette-connections"],
    queryFn: () => api.listConnections(),
    enabled: open,
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onOpenChange]);

  const go = (to: string) => {
    onOpenChange(false);
    nav(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {connectionId && (
          <CommandGroup heading="Navigate">
            <CommandItem onSelect={() => go(`/c/${connectionId}/sql`)}>
              <Code2 /> SQL Editor
            </CommandItem>
            <CommandItem onSelect={() => go(`/c/${connectionId}/er`)}>
              <Network /> ER Diagram
            </CommandItem>
            <CommandItem onSelect={() => go(`/c/${connectionId}/schema`)}>
              <Hammer /> Schema
            </CommandItem>
            <CommandItem onSelect={() => go(`/c/${connectionId}/audit`)}>
              <FileClock /> Audit log
            </CommandItem>
          </CommandGroup>
        )}
        {connectionId && schema && (tablesQ.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Tables">
            {tablesQ.data!.map((t) => (
              <CommandItem
                key={t.name}
                value={`table ${t.name}`}
                onSelect={() => go(`/c/${connectionId}/t/${encodeURIComponent(schema)}/${encodeURIComponent(t.name)}`)}
              >
                <Table2 /> <span className="font-mono">{t.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(connsQ.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Connections">
            {connsQ.data!.map((c) => (
              <CommandItem key={c.id} value={`conn ${c.name}`} onSelect={() => go(`/c/${c.id}`)}>
                <Database /> {c.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
