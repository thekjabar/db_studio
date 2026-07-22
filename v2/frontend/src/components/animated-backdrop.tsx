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
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden landing-backdrop"
    >
      {/* Dot grid — small primary-tinted dots on a huge transparent tile.
          Drift is pure background-position change so there's no layer to
          composite, no JS work per frame. */}
      <div
        className="absolute inset-0 opacity-[0.18] dark:opacity-[0.12]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(62,207,142,0.6) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          animation: "landingGridDrift 60s linear infinite",
        }}
      />

      {/* Diagonal light rays — big blurred gradient strips that sweep
          from top-left to bottom-right. Two beams with staggered delays so
          there's always roughly one on screen. */}
      <div
        className="absolute -inset-x-20 -top-1/4 h-[60vh] opacity-30 dark:opacity-20 blur-3xl"
        style={{
          background:
            "linear-gradient(115deg, transparent 30%, rgba(62,207,142,0.45) 45%, rgba(62,207,142,0.1) 55%, transparent 70%)",
          animation: "landingRaySweep 22s ease-in-out infinite",
        }}
      />
      <div
        className="absolute -inset-x-20 top-1/3 h-[70vh] opacity-20 dark:opacity-15 blur-3xl"
        style={{
          background:
            "linear-gradient(115deg, transparent 40%, rgba(62,207,142,0.3) 50%, transparent 65%)",
          animation: "landingRaySweep 26s ease-in-out infinite",
          animationDelay: "-9s",
        }}
      />

      {/* Top-down fade — pulls more background color in at the top so the
          hero sits on a slightly richer gradient. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 0%, rgba(62,207,142,0.12), transparent 60%)",
        }}
      />

      {/* Mid/lower-page ambient glows so sections below the hero sit on
          atmosphere instead of flat black. Spread down the scroll. */}
      <div
        className="absolute inset-x-0 top-[40%] h-[50vh] opacity-50 dark:opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse 50% 50% at 20% 30%, rgba(62,207,142,0.18), transparent 60%), radial-gradient(ellipse 45% 45% at 85% 70%, rgba(43,165,114,0.14), transparent 60%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[55vh] opacity-50 dark:opacity-40 blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse 55% 50% at 70% 40%, rgba(62,207,142,0.14), transparent 60%), radial-gradient(ellipse 40% 40% at 15% 80%, rgba(43,165,114,0.12), transparent 60%)",
        }}
      />
    </div>
  );
}
