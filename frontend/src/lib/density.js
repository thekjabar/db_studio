const STORAGE_KEY = "dbdash.density";
const DEFAULT = "MEDIUM";
export function getCachedDensity() {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "SMALL" || v === "MEDIUM" || v === "LARGE")
        return v;
    return DEFAULT;
}
export function applyDensity(d) {
    document.documentElement.dataset.density = d.toLowerCase();
    localStorage.setItem(STORAGE_KEY, d);
}
