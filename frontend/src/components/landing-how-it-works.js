import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Database, Lock, Zap } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
/**
 * "How it works" — 3-step vertical flow. Each step is a rounded card with
 * an icon, a title, and a short blurb. Between steps, an SVG "light streak"
 * flows downward to tell the data-path story visually.
 *
 * Scroll reveal: cards fade + slide up one after the other with 120ms
 * staggered delays. Connectors reveal after both their adjacent cards.
 */
const STEPS = [
    {
        icon: Lock,
        title: "Connect securely",
        blurb: "Add a Postgres, MySQL, SQL Server, or SQLite connection. Credentials are encrypted with AES-256-GCM; the master key lives in your KMS of choice.",
    },
    {
        icon: Zap,
        title: "Query with anyone",
        blurb: "Write SQL with schema-aware autocomplete, or ask the AI. Share saved queries with your team, gate destructive changes behind approvals.",
    },
    {
        icon: Database,
        title: "Ship it live",
        blurb: "Pin queries to dashboards, schedule alerts to Slack, stream metrics to Prometheus. Your team sees the same numbers you do.",
    },
];
export function LandingHowItWorks() {
    return (_jsx("section", { className: "relative landing-animations", children: _jsxs("div", { className: "max-w-4xl mx-auto px-6 py-20 sm:py-28", children: [_jsx(ScrollReveal, { from: "up", children: _jsxs("div", { className: "text-center mb-16", children: [_jsx("div", { className: "inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs text-muted-foreground mb-4", children: "Three steps" }), _jsxs("h2", { className: "text-3xl sm:text-4xl font-semibold tracking-tight", children: ["From zero to shipped ", _jsx("span", { className: "text-primary", children: "in a morning" }), "."] }), _jsx("p", { className: "mt-4 text-muted-foreground max-w-xl mx-auto", children: "No SDK install, no schema generation, no dashboard editor. Just connect and work." })] }) }), _jsx("div", { className: "relative", children: STEPS.map((step, i) => {
                        const Icon = step.icon;
                        return (_jsxs("div", { className: "relative", children: [_jsx(ScrollReveal, { from: "up", delay: i * 140, children: _jsxs("div", { className: "flex items-start gap-4 py-4", children: [_jsxs("div", { className: "relative shrink-0", children: [_jsx("div", { className: "h-14 w-14 rounded-full border border-primary/30 bg-card/80 backdrop-blur-sm flex items-center justify-center", children: _jsx(Icon, { className: "h-6 w-6 text-primary" }) }), _jsx("span", { className: "absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-[10px] font-mono flex items-center justify-center shadow-lg", children: i + 1 })] }), _jsxs("div", { className: "flex-1 rounded-lg border border-border bg-card/60 backdrop-blur-sm p-5 shadow-sm", children: [_jsx("h3", { className: "font-semibold text-lg", children: step.title }), _jsx("p", { className: "mt-1.5 text-sm text-muted-foreground leading-relaxed", children: step.blurb })] })] }) }), i < STEPS.length - 1 && (_jsx(ScrollReveal, { from: "fade", delay: i * 140 + 200, duration: 500, children: _jsx(Connector, {}) }))] }, step.title));
                    }) })] }) }));
}
/** Vertical dashed line with a green light-streak repeatedly flowing down.
 *  Positioned so it aligns with the center of the circular icon above it. */
function Connector() {
    return (_jsx("div", { className: "relative h-12 ml-7 -my-1", "aria-hidden": true, children: _jsxs("svg", { className: "absolute inset-0 w-px h-full overflow-visible", viewBox: "0 0 1 100", preserveAspectRatio: "none", children: [_jsx("line", { x1: "0.5", y1: "0", x2: "0.5", y2: "100", stroke: "currentColor", strokeOpacity: "0.25", strokeDasharray: "2 3", vectorEffect: "non-scaling-stroke", className: "text-muted-foreground" }), _jsx("line", { x1: "0.5", y1: "0", x2: "0.5", y2: "100", stroke: "rgb(62,207,142)", strokeWidth: "2", strokeDasharray: "20 200", vectorEffect: "non-scaling-stroke", style: {
                        animation: "landingStreakFlow 2.4s ease-in-out infinite",
                    } })] }) }));
}
