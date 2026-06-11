import { create } from "zustand";
import { persist } from "zustand/middleware";
function applyTheme(t) {
    if (typeof document === "undefined")
        return;
    document.documentElement.classList.toggle("dark", t === "dark");
}
function resolveMode(mode) {
    if (mode === "LIGHT")
        return "light";
    if (mode === "DARK")
        return "dark";
    if (typeof window !== "undefined" && window.matchMedia) {
        return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
}
// Debounced save-to-server. Mutating fast (dropdown click, toggle spam) shouldn't
// hit the API every tick — collapse to the last value after 400ms idle.
let savePending = null;
function persistToServer(mode) {
    if (savePending)
        clearTimeout(savePending);
    savePending = setTimeout(() => {
        import("./api")
            .then(({ api }) => api.updateProfile({ theme: mode }).catch(() => null))
            .catch(() => null);
    }, 400);
}
export const useTheme = create()(persist((set, get) => ({
    theme: "dark",
    mode: "DARK",
    toggle: () => {
        const nextMode = get().theme === "dark" ? "LIGHT" : "DARK";
        const next = resolveMode(nextMode);
        applyTheme(next);
        set({ theme: next, mode: nextMode });
        persistToServer(nextMode);
    },
    set: (t) => {
        const mode = t === "dark" ? "DARK" : "LIGHT";
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
}), {
    name: "db-studio-theme",
    onRehydrateStorage: () => (state) => {
        if (state)
            applyTheme(state.theme);
    },
}));
/** Apply a server-sourced theme without persisting back to the server. Used
 *  after login / refresh when the user's saved preference arrives. */
export function applyServerTheme(mode) {
    if (!mode)
        return;
    const resolved = resolveMode(mode);
    applyTheme(resolved);
    useTheme.setState({ theme: resolved, mode });
}
if (typeof document !== "undefined") {
    document.documentElement.classList.add("dark");
}
