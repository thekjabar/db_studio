import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ChartConfig } from "@/lib/api";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  columns: string[];
  initial?: ChartConfig | null;
  onSave: (c: ChartConfig | null) => void;
}

export function ChartConfigDialog({ open, onOpenChange, columns, initial, onSave }: Props) {
  const [type, setType] = useState<ChartConfig["type"]>("bar");
  const [x, setX] = useState<string>(columns[0] ?? "");
  const [y, setY] = useState<string[]>(columns.slice(1, 2));
  const [stacked, setStacked] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setType(initial.type);
      setX(initial.x);
      setY(initial.y);
      setStacked(!!initial.stacked);
    } else {
      setType("bar");
      setX(columns[0] ?? "");
      setY(columns.slice(1, 2));
      setStacked(false);
    }
  }, [open, initial, columns]);

  const toggleY = (col: string) => {
    setY((prev) => (prev.includes(col) ? prev.filter((p) => p !== col) : [...prev, col]));
  };

  const apply = () => {
    if (!x || !y.length) return;
    onSave({ type, x, y, stacked: stacked || undefined });
    onOpenChange(false);
  };

  const clear = () => {
    onSave(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Configure chart</DialogTitle>
          <DialogDescription>
            Pick a chart type, the X axis (category/time), and one or more Y columns (numeric).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Chart type</Label>
            <Select value={type} onValueChange={(v) => setType(v as ChartConfig["type"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="area">Area</SelectItem>
                <SelectItem value="pie">Pie</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>X axis (category)</Label>
            <Select value={x} onValueChange={setX}>
              <SelectTrigger><SelectValue placeholder="Pick a column" /></SelectTrigger>
              <SelectContent>
                {columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Y axis (numeric — {type === "pie" ? "one" : "one or more"})</Label>
            <div className="flex flex-wrap gap-1 rounded-md border border-border p-2 max-h-32 overflow-auto">
              {columns.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    if (type === "pie") setY([c]);
                    else toggleY(c);
                  }}
                  className={[
                    "px-2 py-0.5 rounded-sm text-[11px] font-mono border transition-colors",
                    y.includes(c)
                      ? "bg-primary/15 text-primary border-primary/30"
                      : "border-border hover:bg-accent",
                  ].join(" ")}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          {(type === "bar" || type === "area") && y.length > 1 && (
            <div className="flex items-center gap-2">
              <Switch checked={stacked} onCheckedChange={setStacked} />
              <Label>Stack series</Label>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {initial && (
            <Button variant="ghost" onClick={clear} className="mr-auto text-destructive">
              Remove chart
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={apply} disabled={!x || !y.length}>Save chart</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
