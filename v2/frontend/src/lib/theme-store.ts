import { create } from "zustand";
import { persist } from "zustand/middleware";

type Theme = "dark" | "light";
export type ThemeMode = "LIGHT" | "DARK" | "SYSTEM";

interface ThemeState {
  theme: Theme;
  mode: ThemeMode;
  toggle: () => void;
  set: (t: Theme) => void;
  setMode: (m: ThemeMode) => void;
}

function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", t === "dark");
}

function resolveMode(mode: ThemeMode): Theme {
  if (mode === "LIGHT") return "light";
  if (mode === "DARK") return "dark";
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

// Debounced save-to-server. Mutating fast (dropdown click, toggle spam) shouldn't
// hit the API every tick — collapse to the last value after 400ms idle.
let savePending: ReturnType<typeof setTimeout> | null = null;
function persistToServer(mode: ThemeMode) {
  if (savePending) clearTimeout(savePending);
  savePending = setTimeout(() => {
    import("./api")
      .then(({ api }) => api.updateProfile({ theme: mode }).catch(() => null))
      .catch(() => null);
  }, 400);
}

export const useTheme = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      mode: "DARK",
      toggle: () => {
        const nextMode: ThemeMode = get().theme === "dark" ? "LIGHT" : "DARK";
        const next = resolveMode(nextMode);
        applyTheme(next);
        set({ theme: next, mode: nextMode });
        persistToServer(nextMode);
      },
      set: (t) => {
        const mode: ThemeMode = t === "dark" ? "DARK" : "LIGHT";
        applyTheme(t);
        set({ theme: t, mode });
        persistToServer(mode);
      },
      setMode: (m) => {
        const resolved = resolveMode(m);
        applyTheme(resolved);
        set({ theme: resolved, mode: m });
        persistToServer(m);
      },
    }),
    {
      name: "db-studio-theme",
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

/** Apply a server-sourced theme without persisting back to the server. Used
 *  after login / refresh when the user's saved preference arrives. */
export function applyServerTheme(mode: ThemeMode | undefined) {
  if (!mode) return;
  const resolved = resolveMode(mode);
  applyTheme(resolved);
  useTheme.setState({ theme: resolved, mode });
}

if (typeof document !== "undefined") {
  document.documentElement.classList.add("dark");
}
