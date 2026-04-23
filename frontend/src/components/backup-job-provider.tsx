import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, extractErrorMessage } from "@/lib/api";

/**
 * A single global backup job that lives at the app root so it survives
 * navigation. The `Backup` route reads/writes through this context instead
 * of holding its own state — switching pages mid-stream doesn't interrupt
 * the download. On completion the browser save dialog fires from this
 * provider, independent of what's currently rendered.
 */

interface BackupOptions {
  connectionId: string;
  connectionName: string;
  format: "sql" | "custom";
  schemaOnly?: boolean;
  schema?: string;
}

export interface BackupJob {
  id: string;
  options: BackupOptions;
  bytes: number;
  estimateBytes: number | null;
  elapsedMs: number;
  status: "starting" | "streaming" | "done" | "error" | "cancelled";
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

interface Ctx {
  current: BackupJob | null;
  start: (opts: BackupOptions) => Promise<void>;
  cancel: () => void;
  clear: () => void;
}

const BackupJobCtx = createContext<Ctx | null>(null);

export function BackupJobProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<BackupJob | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<BackupJob | null>(null);
  jobRef.current = job;

  const start = useCallback(async (opts: BackupOptions) => {
    if (jobRef.current && jobRef.current.status === "streaming") {
      toast.error("Another backup is already running");
      return;
    }

    // Open the "Save as…" file picker SYNCHRONOUSLY while the user gesture is
    // still valid. Any `await` before this call would drop the gesture flag
    // and the browser would throw SecurityError. If the API isn't available
    // (Firefox/Safari/HTTP origin) we fall through to the in-memory path.
    let fileHandle: FileSystemFileHandle | null = null;
    const picker = (window as unknown as {
      showSaveFilePicker?: (o: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;
    if (typeof picker === "function" && window.isSecureContext) {
      try {
        const ext = opts.format === "custom" ? "dump" : "sql";
        const safeName = opts.connectionName.replace(/[^a-z0-9-_]+/gi, "_");
        const today = new Date().toISOString().slice(0, 10);
        fileHandle = await picker({
          suggestedName: `${safeName}-${today}.${ext}`,
          types: [
            {
              description: opts.format === "custom" ? "Postgres custom dump" : "SQL",
              accept:
                opts.format === "custom"
                  ? { "application/octet-stream": [".dump"] }
                  : { "application/sql": [".sql"] },
            },
          ],
        });
      } catch (err) {
        // User cancelled the save dialog — bail out cleanly without starting.
        if ((err as Error).name === "AbortError") {
          toast.info("Backup cancelled");
          return;
        }
        // Anything else: log and continue to the in-memory fallback.
        // eslint-disable-next-line no-console
        console.warn("showSaveFilePicker failed, using in-memory path:", err);
      }
    }

    const id = crypto.randomUUID();
    const startedAt = Date.now();
    setJob({
      id,
      options: opts,
      bytes: 0,
      estimateBytes: null,
      elapsedMs: 0,
      status: "starting",
      startedAt,
    });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await api.downloadBackup(
        opts.connectionId,
        { format: opts.format, schemaOnly: opts.schemaOnly, schema: opts.schema },
        (p) => {
          setJob((prev) =>
            prev && prev.id === id
              ? {
                  ...prev,
                  bytes: p.bytes,
                  estimateBytes: p.estimateBytes,
                  elapsedMs: p.elapsedMs,
                  status: p.bytes > 0 ? "streaming" : prev.status,
                }
              : prev,
          );
        },
        ac.signal,
        fileHandle,
      );
      setJob((prev) =>
        prev && prev.id === id
          ? { ...prev, status: "done", finishedAt: Date.now() }
          : prev,
      );
      toast.success(`Backup "${opts.connectionName}" downloaded`);
    } catch (err) {
      const isAbort = (err as Error).name === "AbortError";
      setJob((prev) =>
        prev && prev.id === id
          ? {
              ...prev,
              status: isAbort ? "cancelled" : "error",
              error: isAbort ? undefined : extractErrorMessage(err),
              finishedAt: Date.now(),
            }
          : prev,
      );
      if (isAbort) toast.info("Backup cancelled");
      else toast.error(extractErrorMessage(err));
    } finally {
      abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (jobRef.current?.status === "streaming" || jobRef.current?.status === "starting") return;
    setJob(null);
  }, []);

  const value = useMemo<Ctx>(() => ({ current: job, start, cancel, clear }), [job, start, cancel, clear]);

  return <BackupJobCtx.Provider value={value}>{children}</BackupJobCtx.Provider>;
}

export function useBackupJob(): Ctx {
  const ctx = useContext(BackupJobCtx);
  if (!ctx) throw new Error("useBackupJob must be used inside BackupJobProvider");
  return ctx;
}
