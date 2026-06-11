import { jsx as _jsx } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
export function ScrollReveal({ children, from = "up", delay = 0, duration = 700, threshold = 0.15, className, as = "div", style, }) {
    const ref = useRef(null);
    const [revealed, setRevealed] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el)
            return;
        // Respect reduced-motion globally — nothing to do, show content immediately.
        if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setRevealed(true);
            return;
        }
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting) {
                    setRevealed(true);
                    io.disconnect();
                }
            }
        }, { threshold, rootMargin: "0px 0px -10% 0px" });
        io.observe(el);
        return () => io.disconnect();
    }, [threshold]);
    const hiddenOffset = 24;
    const hiddenTransform = from === "up"
        ? `translate3d(0, ${hiddenOffset}px, 0)`
        : from === "down"
            ? `translate3d(0, -${hiddenOffset}px, 0)`
            : from === "left"
                ? `translate3d(-${hiddenOffset}px, 0, 0)`
                : from === "right"
                    ? `translate3d(${hiddenOffset}px, 0, 0)`
                    : "translate3d(0, 0, 0)";
    const merged = {
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
    const Tag = as;
    return (_jsx(Tag, { ref: ref, className: cn(className), style: merged, children: children }));
}
/** Count-up-on-reveal number — when the wrapper enters the viewport, the
 *  displayed value animates from 0 to `value` over `duration` ms. Perfect
 *  for stats strips. */
export function CountUpOnReveal({ value, duration = 1200, format, className, }) {
    const ref = useRef(null);
    const [shown, setShown] = useState(0);
    const started = useRef(false);
    useEffect(() => {
        const el = ref.current;
        if (!el)
            return;
        if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setShown(value);
            return;
        }
        const io = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting && !started.current) {
                    started.current = true;
                    io.disconnect();
                    const start = performance.now();
                    const step = (t) => {
                        const p = Math.min(1, (t - start) / duration);
                        const eased = 1 - Math.pow(1 - p, 3);
                        setShown(value * eased);
                        if (p < 1)
                            requestAnimationFrame(step);
                        else
                            setShown(value);
                    };
                    requestAnimationFrame(step);
                }
            }
        }, { threshold: 0.4 });
        io.observe(el);
        return () => io.disconnect();
    }, [value, duration]);
    const text = format ? format(shown) : Math.round(shown).toLocaleString();
    return (_jsx("span", { ref: ref, className: cn("tabular-nums", className), children: text }));
}
