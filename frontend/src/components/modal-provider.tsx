import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ConfirmOpts = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PromptOpts = {
  title: string;
  description?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (v: string) => string | null;
};

type SelectOpts = {
  title: string;
  description?: string;
  options: { value: string; label?: string }[];
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type Pending =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (ok: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: "select"; opts: SelectOpts; resolve: (v: string | null) => void };

interface Ctx {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  select: (opts: SelectOpts) => Promise<string | null>;
}

const ModalCtx = React.createContext<Ctx | null>(null);

export function useModal() {
  const ctx = React.useContext(ModalCtx);
  if (!ctx) throw new Error("useModal must be used inside <ModalProvider>");
  return ctx;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const api = React.useMemo<Ctx>(
    () => ({
      confirm: (opts) => new Promise<boolean>((resolve) => setPending({ kind: "confirm", opts, resolve })),
      prompt: (opts) =>
        new Promise<string | null>((resolve) => {
          setValue(opts.defaultValue ?? "");
          setError(null);
          setPending({ kind: "prompt", opts, resolve });
        }),
      select: (opts) =>
        new Promise<string | null>((resolve) => {
          setValue(opts.defaultValue ?? opts.options[0]?.value ?? "");
          setError(null);
          setPending({ kind: "select", opts, resolve });
        }),
    }),
    [],
  );

  const close = (result: boolean | string | null) => {
    if (!pending) return;
    if (pending.kind === "confirm") pending.resolve(result as boolean);
    else pending.resolve(result as string | null);
    setPending(null);
  };

  const onOpenChange = (open: boolean) => {
    if (!open) close(pending?.kind === "confirm" ? false : null);
  };

  const onConfirm = () => {
    if (!pending) return;
    if (pending.kind === "confirm") {
      close(true);
      return;
    }
    if (pending.kind === "select") {
      close(value);
      return;
    }
    const v = value.trim();
    const err = pending.opts.validate?.(v) ?? null;
    if (err) {
      setError(err);
      return;
    }
    close(v);
  };

  return (
    <ModalCtx.Provider value={api}>
      {children}
      <Dialog open={!!pending} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          {pending && (
            <>
              <DialogHeader>
                <DialogTitle>{pending.opts.title}</DialogTitle>
                {pending.opts.description && (
                  <DialogDescription>{pending.opts.description}</DialogDescription>
                )}
              </DialogHeader>

              {pending.kind === "prompt" && (
                <div className="space-y-1.5">
                  <Input
                    autoFocus
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder={pending.opts.placeholder}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onConfirm();
                    }}
                  />
                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}

              {pending.kind === "select" && (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pending.opts.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label ?? o.value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => close(pending.kind === "confirm" ? false : null)}>
                  {pending.opts.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  variant={pending.kind === "confirm" && pending.opts.destructive ? "destructive" : "default"}
                  onClick={onConfirm}
                >
                  {pending.opts.confirmLabel ?? (pending.kind === "confirm" ? "Confirm" : "OK")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ModalCtx.Provider>
  );
}
