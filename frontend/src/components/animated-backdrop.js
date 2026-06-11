import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Page-wide animated backdrop for the landing page.
 *
 * Layers (back to front, all pointer-events-none):
 *   1. Dot grid — CSS radial-gradient pattern, tiny opacity, drifts slowly
 *      via a long background-position keyframe.
 *   2. Light rays — two wide, soft diagonal beams that sweep across the
 *      page every ~18s, offset from each other.
 *   3. Glow fade — radial top gradient that brings the background-to-card
 *      contrast up so cards still read cleanly.
 *
 * All pure CSS. Zero JS. Honors `prefers-reduced-motion` via a global CSS
 * rule below the component's layer.
 */
export function AnimatedBackdrop() {
    return (_jsxs("div", { "aria-hidden": true, className: "pointer-events-none fixed inset-0 -z-10 overflow-hidden landing-backdrop", children: [_jsx("div", { className: "absolute inset-0 opacity-[0.18] dark:opacity-[0.12]", style: {
                    backgroundImage: "radial-gradient(rgba(62,207,142,0.6) 1px, transparent 1px)",
                    backgroundSize: "28px 28px",
                    animation: "landingGridDrift 60s linear infinite",
                } }), _jsx("div", { className: "absolute -inset-x-20 -top-1/4 h-[60vh] opacity-30 dark:opacity-20 blur-3xl", style: {
                    background: "linear-gradient(115deg, transparent 30%, rgba(62,207,142,0.45) 45%, rgba(62,207,142,0.1) 55%, transparent 70%)",
                    animation: "landingRaySweep 22s ease-in-out infinite",
                } }), _jsx("div", { className: "absolute -inset-x-20 top-1/3 h-[70vh] opacity-20 dark:opacity-15 blur-3xl", style: {
                    background: "linear-gradient(115deg, transparent 40%, rgba(62,207,142,0.3) 50%, transparent 65%)",
                    animation: "landingRaySweep 26s ease-in-out infinite",
                    animationDelay: "-9s",
                } }), _jsx("div", { className: "absolute inset-0", style: {
                    background: "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(62,207,142,0.12), transparent 60%)",
                } })] }));
}
