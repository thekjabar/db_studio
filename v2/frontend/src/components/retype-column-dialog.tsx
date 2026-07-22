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
import { ColumnTypeSelect } from "@/components/column-type-select";

interface Props {
  open: boolean;
  columnName: string;
  currentType: string;
  onOpenChange: (v: boolean) => void;
  onConfirm: (newType: string) => void;
}

export function RetypeColumnDialog({ open, columnName, currentType, onOpenChange, onConfirm }: Props) {
  const [value, setValue] = useState<string>(currentType);

  useEffect(() => {
    if (open) setValue(currentType);
  }, [open, currentType]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Change type of <code className="font-mono text-primary">{columnName}</code>
          </DialogTitle>
          <DialogDescription>
            Pick the new Postgres type. Incompatible conversions will fail when applied.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label>Type</Label>
          <ColumnTypeSelect value={value} onChange={setValue} currentValue={currentType} />
          <p className="text-[11px] text-muted-foreground">
            Current: <span className="font-mono">{currentType}</span>
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(value)}
            disabled={!value || value === currentType}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
