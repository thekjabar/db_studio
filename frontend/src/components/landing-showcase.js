import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { BarChart3, Bell, Database, FileText, GitBranch, History, Sparkles, Users, Zap, } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { cn } from "@/lib/utils";
export function LandingShowcase() {
    const items = [
        {
            eyebrow: "Built for teams",
            title: "Ship changes without breaking anything.",
            blurb: "Every destructive statement runs through review. Every row edit lands in an audit log with before / after snapshots. Every schema change is one click away from being undone.",
            bullets: ["Query review with one-click approve", "Audit with revert", "Per-row before/after"],
            visual: _jsx(ReviewVisual, {}),
            copySide: "left",
        },
        {
            eyebrow: "Native AI",
            title: "An assistant that actually knows your schema.",
            blurb: "Type what you want, see it written as SQL. The model has your tables and foreign keys in its context, so its queries actually run. Chat history persists per connection.",
            bullets: ["Schema-grounded generation", "Persistent per-connection chats", "Explain + optimize mode"],
            visual: _jsx(AiVisual, {}),
            copySide: "right",
        },
        {
            eyebrow: "Observe + alert",
            title: "From query to alert in one place.",
            blurb: "Save a query, pin it to a dashboard, wire it to an alert, subscribe to results on Slack. Nothing leaves the studio — no third-party dashboard tool, no separate alerting stack.",
            bullets: ["Pin queries to charts", "Cron + condition alerts", "Public share links"],
            visual: _jsx(DashboardVisual, {}),
            copySide: "left",
        },
    ];
    return (_jsx("section", { className: "relative landing-animations", children: _jsx("div", { className: "max-w-6xl mx-auto px-6 py-20 sm:py-28 space-y-28", children: items.map((item, i) => (_jsx(ShowcaseRow, { item: item, index: i }, item.title))) }) }));
}
function ShowcaseRow({ item, index }) {
    const copyFirst = item.copySide === "left";
    return (_jsxs("div", { className: cn("grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center", !copyFirst && "lg:[&>*:first-child]:order-2"), children: [_jsx(ScrollReveal, { from: copyFirst ? "left" : "right", delay: 80, children: _jsxs("div", { children: [_jsx("div", { className: "inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs text-muted-foreground mb-4", children: item.eyebrow }), _jsx("h3", { className: "text-3xl sm:text-4xl font-semibold tracking-tight", children: item.title }), _jsx("p", { className: "mt-4 text-muted-foreground leading-relaxed max-w-lg", children: item.blurb }), _jsx("ul", { className: "mt-6 space-y-2", children: item.bullets.map((b) => (_jsxs("li", { className: "flex items-center gap-2 text-sm", children: [_jsx("span", { className: "h-1.5 w-1.5 rounded-full bg-primary" }), b] }, b))) })] }) }), _jsx(ScrollReveal, { from: copyFirst ? "right" : "left", delay: 160, duration: 800, children: item.visual }), _jsx("span", { hidden: true, "aria-hidden": true, children: index })] }));
}
// -------------- Visuals --------------
//
// Each visual is a small stylized "preview" of a feature area. They're not
// the real product — just evocative line-art mockups that read quickly and
// echo the real UI's typography.
function ReviewVisual() {
    return (_jsxs("div", { className: "relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden", children: [_jsxs("div", { className: "px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground", children: [_jsx(GitBranch, { className: "h-3 w-3 text-primary" }), _jsx("span", { className: "font-mono", children: "prod-postgres \u00B7 3 requests pending" })] }), _jsxs("div", { className: "p-4 space-y-3", children: [[
                        { who: "alex@", sql: "UPDATE users SET plan = 'pro' WHERE id = 41;", status: "Pending" },
                        { who: "sam@", sql: "DELETE FROM sessions WHERE expires_at < NOW();", status: "Approved" },
                        { who: "ben@", sql: "ALTER TABLE orders ADD COLUMN notes TEXT;", status: "Pending" },
                    ].map((r) => (_jsxs("div", { className: "rounded border border-border bg-background/40 p-3", children: [_jsxs("div", { className: "flex items-center gap-2 text-[11px] text-muted-foreground", children: [_jsx(Users, { className: "h-3 w-3" }), _jsx("span", { className: "font-mono", children: r.who }), _jsx("span", { className: "ml-auto text-[10px] font-medium rounded px-1.5 py-0.5", style: {
                                            background: r.status === "Approved" ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)",
                                            color: r.status === "Approved" ? "rgb(16,185,129)" : "rgb(245,158,11)",
                                        }, children: r.status })] }), _jsx("pre", { className: "mt-1.5 text-xs font-mono whitespace-pre-wrap", children: r.sql })] }, r.sql))), _jsxs("div", { className: "flex items-center gap-1.5 text-[11px] text-muted-foreground", children: [_jsx(History, { className: "h-3 w-3" }), "Full audit trail \u2014 one-click revert"] })] })] }));
}
function AiVisual() {
    return (_jsxs("div", { className: "relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden", children: [_jsxs("div", { className: "px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground", children: [_jsx(Sparkles, { className: "h-3 w-3 text-primary" }), _jsx("span", { className: "font-mono", children: "ai \u00B7 orders-prod" })] }), _jsxs("div", { className: "p-4 space-y-3 text-xs", children: [_jsx("div", { className: "rounded-md bg-primary/10 border border-primary/20 p-3", children: "Show me last week's top 5 products by revenue, excluding refunds." }), _jsxs("div", { className: "rounded-md border border-border bg-background/40 p-3 font-mono space-y-2", children: [_jsx("div", { className: "text-muted-foreground", children: "Assistant" }), _jsx("pre", { className: "whitespace-pre-wrap", children: `SELECT
  product_id,
  SUM(amount) AS revenue
FROM orders
WHERE status <> 'refunded'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY product_id
ORDER BY revenue DESC
LIMIT 5;` }), _jsxs("button", { className: "text-primary inline-flex items-center gap-1 text-[11px]", children: [_jsx(Zap, { className: "h-3 w-3" }), " Run"] })] }), _jsx("div", { className: "rounded-md bg-primary/10 border border-primary/20 p-3", children: "Now break it down by day." })] })] }));
}
function DashboardVisual() {
    return (_jsxs("div", { className: "relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden", children: [_jsxs("div", { className: "px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground", children: [_jsx(BarChart3, { className: "h-3 w-3 text-primary" }), _jsx("span", { className: "font-mono", children: "dashboards \u00B7 Weekly signups" })] }), _jsxs("div", { className: "p-4 space-y-3", children: [_jsx("div", { className: "grid grid-cols-7 gap-1 h-24 items-end", children: [40, 65, 52, 78, 86, 70, 92].map((h, i) => (_jsx("div", { className: "rounded-sm bg-linear-to-t from-primary/40 to-primary", style: { height: `${h}%` } }, i))) }), _jsxs("div", { className: "flex items-center gap-2 text-[11px] text-muted-foreground border-t border-border pt-2", children: [_jsx(Bell, { className: "h-3 w-3 text-primary" }), "Alert: > 1000 signups/day \u2192 Slack #growth", _jsx(FileText, { className: "h-3 w-3 text-primary ml-auto" }), _jsx(Database, { className: "h-3 w-3 text-primary" })] })] })] }));
}
