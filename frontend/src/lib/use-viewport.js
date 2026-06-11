import { useEffect, useState } from "react";
const MOBILE_BREAKPOINT = 768; // px
const TABLET_BREAKPOINT = 1024; // px
function compute() {
    if (typeof window === "undefined")
        return { isMobile: false, isTablet: false };
    const w = window.innerWidth;
    return {
        isMobile: w < MOBILE_BREAKPOINT,
        isTablet: w < TABLET_BREAKPOINT,
    };
}
/** Returns viewport flags. Re-renders on resize (throttled via rAF). */
export function useViewport() {
    const [state, setState] = useState(compute);
    useEffect(() => {
        let raf = 0;
        const onResize = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => setState(compute()));
        };
        window.addEventListener("resize", onResize);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener("resize", onResize);
        };
    }, []);
    return state;
}
