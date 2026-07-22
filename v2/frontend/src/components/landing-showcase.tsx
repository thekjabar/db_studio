import type { ReactNode } from "react";
import {
  BarChart3,
  Bell,
  Database,
  FileText,
  GitBranch,
  History,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { cn } from "@/lib/utils";

/**
 * Long-form showcase section. Three side-by-side panels alternate the copy
 * column's side so the eye naturally zig-zags down the page instead of
 * pouring straight through it. Each side reveals from opposite directions
 * on scroll, which gives a subtle "split" effect without going full
 * parallax.
 */

interface ShowcaseItem {
  eyebrow: string;
  title: string;
  blurb: string;
  bullets: string[];
  visual: ReactNode;
  /** Which side the copy column sits on. */
  copySide: "left" | "right";
}

export function LandingShowcase() {
  const items: ShowcaseItem[] = [
    {
      eyebrow: "Built for teams",
      title: "Ship changes without breaking anything.",
      blurb:
        "Every destructive statement runs through review. Every row edit lands in an audit log with before / after snapshots. Every schema change is one click away from being undone.",
      bullets: ["Query review with one-click approve", "Audit with revert", "Per-row before/after"],
      visual: <ReviewVisual />,
      copySide: "left",
    },
    {
      eyebrow: "Native AI",
      title: "An assistant that actually knows your schema.",
      blurb:
        "Type what you want, see it written as SQL. The model has your tables and foreign keys in its context, so its queries actually run. Chat history persists per connection.",
      bullets: ["Schema-grounded generation", "Persistent per-connection chats", "Explain + optimize mode"],
      visual: <AiVisual />,
      copySide: "right",
    },
    {
      eyebrow: "Observe + alert",
      title: "From query to alert in one place.",
      blurb:
        "Save a query, pin it to a dashboard, wire it to an alert, subscribe to results on Slack. Nothing leaves the studio — no third-party dashboard tool, no separate alerting stack.",
      bullets: ["Pin queries to charts", "Cron + condition alerts", "Public share links"],
      visual: <DashboardVisual />,
      copySide: "left",
    },
  ];

  return (
    <section className="relative landing-animations">
      <div className="max-w-6xl mx-auto px-6 py-20 sm:py-28 space-y-28">
        {items.map((item, i) => (
          <ShowcaseRow key={item.title} item={item} index={i} />
        ))}
      </div>
    </section>
  );
}

function ShowcaseRow({ item, index }: { item: ShowcaseItem; index: number }) {
  const copyFirst = item.copySide === "left";
  return (
    <div
      className={cn(
        "grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center",
        !copyFirst && "lg:[&>*:first-child]:order-2",
      )}
    >
      <ScrollReveal from={copyFirst ? "left" : "right"} delay={80}>
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs text-muted-foreground mb-4">
            {item.eyebrow}
          </div>
          <h3 className="text-3xl sm:text-4xl font-semibold tracking-tight">{item.title}</h3>
          <p className="mt-4 text-muted-foreground leading-relaxed max-w-lg">{item.blurb}</p>
          <ul className="mt-6 space-y-2">
            {item.bullets.map((b) => (
              <li key={b} className="flex items-center gap-2 text-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      </ScrollReveal>

      <ScrollReveal from={copyFirst ? "right" : "left"} delay={160} duration={800}>
        {item.visual}
      </ScrollReveal>

      {/* Intentionally unused ornament for consistency across rows. */}
      <span hidden aria-hidden>{index}</span>
    </div>
  );
}

// -------------- Visuals --------------
//
// Each visual is a small stylized "preview" of a feature area. They're not
// the real product — just evocative line-art mockups that read quickly and
// echo the real UI's typography.

function ReviewVisual() {
  return (
    <div className="relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground">
        <GitBranch className="h-3 w-3 text-primary" />
        <span className="font-mono">prod-postgres · 3 requests pending</span>
      </div>
      <div className="p-4 space-y-3">
        {[
          { who: "alex@", sql: "UPDATE users SET plan = 'pro' WHERE id = 41;", status: "Pending" },
          { who: "sam@", sql: "DELETE FROM sessions WHERE expires_at < NOW();", status: "Approved" },
          { who: "ben@", sql: "ALTER TABLE orders ADD COLUMN notes TEXT;", status: "Pending" },
        ].map((r) => (
          <div key={r.sql} className="rounded border border-border bg-background/40 p-3">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Users className="h-3 w-3" />
              <span className="font-mono">{r.who}</span>
              <span className="ml-auto text-[10px] font-medium rounded px-1.5 py-0.5"
                style={{
                  background: r.status === "Approved" ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)",
                  color: r.status === "Approved" ? "rgb(16,185,129)" : "rgb(245,158,11)",
                }}>
                {r.status}
              </span>
            </div>
            <pre className="mt-1.5 text-xs font-mono whitespace-pre-wrap">{r.sql}</pre>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <History className="h-3 w-3" />
          Full audit trail — one-click revert
        </div>
      </div>
    </div>
  );
}

function AiVisual() {
  return (
    <div className="relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" />
        <span className="font-mono">ai · orders-prod</span>
      </div>
      <div className="p-4 space-y-3 text-xs">
        <div className="rounded-md bg-primary/10 border border-primary/20 p-3">
          Show me last week's top 5 products by revenue, excluding refunds.
        </div>
        <div className="rounded-md border border-border bg-background/40 p-3 font-mono space-y-2">
          <div className="text-muted-foreground">Assistant</div>
          <pre className="whitespace-pre-wrap">{`SELECT
  product_id,
  SUM(amount) AS revenue
FROM orders
WHERE status <> 'refunded'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY product_id
ORDER BY revenue DESC
LIMIT 5;`}</pre>
          <button className="text-primary inline-flex items-center gap-1 text-[11px]">
            <Zap className="h-3 w-3" /> Run
          </button>
        </div>
        <div className="rounded-md bg-primary/10 border border-primary/20 p-3">
          Now break it down by day.
        </div>
      </div>
    </div>
  );
}

function DashboardVisual() {
  return (
    <div className="relative rounded-xl border border-border bg-card/60 backdrop-blur-sm shadow-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-background/40 flex items-center gap-2 text-[11px] text-muted-foreground">
        <BarChart3 className="h-3 w-3 text-primary" />
        <span className="font-mono">dashboards · Weekly signups</span>
      </div>
      <div className="p-4 space-y-3">
        {/* Mini chart — bars with gradient fill, staggered heights */}
        <div className="grid grid-cols-7 gap-1 h-24 items-end">
          {[40, 65, 52, 78, 86, 70, 92].map((h, i) => (
            <div
              key={i}
              className="rounded-sm bg-linear-to-t from-primary/40 to-primary"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground border-t border-border pt-2">
          <Bell className="h-3 w-3 text-primary" />
          Alert: &gt; 1000 signups/day → Slack #growth
          <FileText className="h-3 w-3 text-primary ml-auto" />
          <Database className="h-3 w-3 text-primary" />
        </div>
      </div>
    </div>
  );
}
