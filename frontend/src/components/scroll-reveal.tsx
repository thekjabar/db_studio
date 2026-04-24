import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Reveal on scroll: hidden until the element enters the viewport, then fades
 * + slides into place. Uses IntersectionObserver (cheap, no scroll handlers).
 *
 * Design notes:
 *   - Once revealed, stay revealed. We don't re-hide on scroll-out — that's
 *     jittery UX and most sections never leave the viewport anyway.
 *   - `delay` staggers reveals in a sequence without needing a parent
 *     orchestrator — just pass increasing delays to children.
 *   - `from` picks the direction of the initial offset. "up" is the default
 *     because that's what 90% of hero-style sections want.
 *   - `prefers-reduced-motion` short-circuits to the revealed state.
 */
export type RevealDirection = "up" | "down" | "left" | "right" | "fade";

interface ScrollRevealProps {
  children: ReactNode;
  /** Animation offset direction. */
  from?: RevealDirection;
  /** Delay in ms before the reveal plays after entering viewport. */
  delay?: number;
  /** Total duration of the reveal transition in ms. */
  duration?: number;
  /** How much of the element must be visible before it reveals (0..1). */
  threshold?: number;
  /** Extra class on the wrapping element. */
  className?: string;
  /** Render as a different element — e.g. "section" or "li". */
  as?: keyof HTMLElementTagNameMap;
  /** Additional inline style — merged with the transform/opacity. */
  style?: CSSProperties;
}

export function ScrollReveal({
  children,
  from = "up",
  delay = 0,
  duration = 700,
  threshold = 0.15,
  className,
  as = "div",
  style,
}: ScrollRevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Respect reduced-motion globally — nothing to do, show content immediately.
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRevealed(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setRevealed(true);
            io.disconnect();
          }
        }
      },
      { threshold, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  const hiddenOffset = 24;
  const hiddenTransform =
    from === "up"
      ? `translate3d(0, ${hiddenOffset}px, 0)`
      : from === "down"
        ? `translate3d(0, -${hiddenOffset}px, 0)`
        : from === "left"
          ? `translate3d(-${hiddenOffset}px, 0, 0)`
          : from === "right"
            ? `translate3d(${hiddenOffset}px, 0, 0)`
            : "translate3d(0, 0, 0)";

  const merged: CSSProperties = {
    ...style,
    opacity: revealed ? 1 : 0,
    transform: revealed ? "translate3d(0, 0, 0)" : hiddenTransform,
    transitionProperty: "opacity, transform",
    transitionDuration: `${duration}ms`,
    transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)", // ease-out-quint
    transitionDelay: `${delay}ms`,
    willChange: revealed ? "auto" : "opacity, transform",
  };

  // `as` could be any HTML element name; we cast to any here because
  // TypeScript can't narrow the intrinsic tag name properly from a string.
  const Tag = as as unknown as React.ElementType;
  return (
    <Tag ref={ref as React.Ref<HTMLElement>} className={cn(className)} style={merged}>
      {children}
    </Tag>
  );
}

/** Count-up-on-reveal number — when the wrapper enters the viewport, the
 *  displayed value animates from 0 to `value` over `duration` ms. Perfect
 *  for stats strips. */
export function CountUpOnReveal({
  value,
  duration = 1200,
  format,
  className,
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !started.current) {
            started.current = true;
            io.disconnect();
            const start = performance.now();
            const step = (t: number) => {
              const p = Math.min(1, (t - start) / duration);
              const eased = 1 - Math.pow(1 - p, 3);
              setShown(value * eased);
              if (p < 1) requestAnimationFrame(step);
              else setShown(value);
            };
            requestAnimationFrame(step);
          }
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [value, duration]);

  const text = format ? format(shown) : Math.round(shown).toLocaleString();
  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {text}
    </span>
  );
}
