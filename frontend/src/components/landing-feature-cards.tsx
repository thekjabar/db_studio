import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  BookMarked,
  Filter,
  History,
  Mail,
  Send,
  ShieldCheck,
  Sparkles,
  Timer,
  Webhook,
  Workflow,
} from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { cn } from "@/lib/utils";

/**
 * Feature card grid with scroll reveal. Each card:
 *   - fades + slides up on first view, with per-card stagger
 *   - on hover, a gradient border-glow sweeps around it via a conic
 *     gradient overlay masked to the border
 *   - title color shifts to the primary tint
 *
 * The hover effect is a thin wrapper around the card that renders a conic
 * gradient in a pseudo-element. We achieve this entirely in CSS via a
 * background + mask trick — no JS per-frame.
 */

interface FeatureItem {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: FeatureItem[] = [
  {
    icon: Sparkles,
    title: "AI that knows your schema",
    body: "Persistent chat per connection. The model sees tables, columns, and FKs — queries actually run the first time.",
  },
  {
    icon: BarChart3,
    title: "Dashboards from SQL",
    body: "Pin a saved query to a chart. Line, bar, area, pie. Auto-refresh. Public share links with an owner-revocable token.",
  },
  {
    icon: Timer,
    title: "Alerts on query results",
    body: "Run a query every 5 min, fire Slack + email if count > threshold. Cooldowns prevent flapping.",
  },
  {
    icon: Activity,
    title: "Live DB health",
    body: "Cache hit ratio, replication lag, long-running queries, locks — per connection, refreshed every 20 seconds.",
  },
  {
    icon: ShieldCheck,
    title: "Query review workflow",
    body: "Gate destructive statements behind owner approval. Approved queries execute exactly once within 24h.",
  },
  {
    icon: Filter,
    title: "Row-level filtering",
    body: "Scope a table to 'tenant_id = my user id' for specific members. Grammar-validated — no SQL injection surface.",
  },
  {
    icon: BookMarked,
    title: "Schema docs + ownership",
    body: "Markdown descriptions on tables and columns, tags, owner emails. Rendered inline in the data browser.",
  },
  {
    icon: Workflow,
    title: "Federated multi-DB joins",
    body: "Join a table in Postgres with one in MySQL via a DuckDB bridge. Same query window, one result set.",
  },
  {
    icon: Send,
    title: "One-click result delivery",
    body: "Pipe any query's output to email, Slack, or an HTTPS webhook — on demand, without scheduling first.",
  },
  {
    icon: History,
    title: "Team query history",
    body: "See what the team ran, when, and against which connection. Filter by user, action, SQL text.",
  },
  {
    icon: Webhook,
    title: "Row-change webhooks",
    body: "POST JSON when a watched row changes. HMAC-signed, retried with backoff, delivery log kept.",
  },
  {
    icon: Mail,
    title: "SSO + sessions",
    body: "OIDC per workspace (Okta/Azure AD/Google). Users see and revoke individual sessions.",
  },
];

export function LandingFeatureCards() {
  return (
    <section className="relative landing-animations">
      <div className="max-w-6xl mx-auto px-6 py-20 sm:py-28">
        <ScrollReveal from="up">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs text-muted-foreground mb-4">
              What's inside
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              Every feature a DB team actually needs.
            </h2>
            <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
              No plugin store. No feature toggles to buy. It's all in the box.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <ScrollReveal
              key={f.title}
              from="up"
              // Stagger within visual rows. We divide by grid-cols at the
              // top breakpoint (3) so the delay resets per row-ish, avoiding
              // a 12-card cascade that feels slow.
              delay={(i % 3) * 80 + Math.floor(i / 3) * 40}
            >
              <FeatureCard item={f} />
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ item }: { item: FeatureItem }) {
  const Icon = item.icon;
  return (
    <div className={cn("group relative rounded-xl p-px overflow-hidden", "feature-card-gradient")}>
      <div className="relative rounded-xl border border-border bg-card/80 backdrop-blur-sm p-5 h-full transition-colors group-hover:border-primary/30">
        <div className="h-9 w-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center mb-3 transition-transform group-hover:scale-110">
          <Icon className="h-4 w-4 text-primary" />
        </div>
        <div className="font-semibold transition-colors group-hover:text-primary">{item.title}</div>
        <div className="mt-1 text-sm text-muted-foreground leading-relaxed">{item.body}</div>
      </div>
    </div>
  );
}
