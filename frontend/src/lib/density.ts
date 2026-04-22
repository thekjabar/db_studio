import type { Density } from "./auth-store";

const STORAGE_KEY = "dbdash.density";
const DEFAULT: Density = "MEDIUM";

export function getCachedDensity(): Density {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "SMALL" || v === "MEDIUM" || v === "LARGE") return v;
  return DEFAULT;
}

export function applyDensity(d: Density) {
  document.documentElement.dataset.density = d.toLowerCase();
  localStorage.setItem(STORAGE_KEY, d);
}
