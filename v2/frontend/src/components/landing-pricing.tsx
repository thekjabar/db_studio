import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Tier {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  cta: string;
  highlight: boolean;
  features: string[];
}

interface PublicPlan {
  tier: "FREE" | "PRO" | "TEAM";
  name: string;
  seatPriceIqd: number;
  maxConnections: number;
  aiEnabled: boolean;
  dailyAiCalls: number;
  maxScheduledQueries: number;
  maxWebhooksPerConnection: number;
  maxSeats: number | null;
}

const TAGLINES: Record<string, string> = {
  FREE: "Try every feature free for a week.",
  PRO: "For teams that live in their database.",
  TEAM: "For larger teams that need more room.",
};
const CTAS: Record<string, string> = { FREE: "Start free trial", PRO: "Choose Pro", TEAM: "Choose Team" };

function planToTier(p: PublicPlan): Tier {
  const isFree = p.tier === "FREE";
  const features: string[] = [];
  features.push(
    isFree
      ? `${p.maxConnections} database connection${p.maxConnections === 1 ? "" : "s"}`
      : `Up to ${p.maxConnections} connections`,
  );
  features.push("SQL editor + visual query builder");
  features.push("Schema browser & ER diagram");
  features.push(p.aiEnabled ? `${p.dailyAiCalls} AI queries / day` : "AI assistant on paid plans");
  if (p.maxScheduledQueries > 0) features.push(`${p.maxScheduledQueries} scheduled queries & email reports`);
  if (p.maxWebhooksPerConnection > 0) features.push(`Webhooks & CDC streaming (${p.maxWebhooksPerConnection}/connection)`);
  features.push(p.maxSeats == null ? "Unlimited team seats" : `Up to ${p.maxSeats} seat${p.maxSeats === 1 ? "" : "s"}`);

  return {
    name: p.name,
    price: isFree ? "Free" : `${p.seatPriceIqd.toLocaleString()} IQD`,
    cadence: isFree ? "7-day trial" : "per seat / month",
    tagline: TAGLINES[p.tier] ?? "",
    cta: CTAS[p.tier] ?? "Get started",
    highlight: p.tier === "PRO",
    features,
  };
}

/** Offline fallback so the section renders even if the plans API is unreachable. */
const FALLBACK: Tier[] = [
  { name: "Trial", price: "Free", cadence: "7-day trial", tagline: TAGLINES.FREE, cta: CTAS.FREE, highlight: false, features: ["1 database connection", "SQL editor + visual query builder", "Schema browser & ER diagram"] },
  { name: "Pro", price: "—", cadence: "per seat / month", tagline: TAGLINES.PRO, cta: CTAS.PRO, highlight: true, features: ["Unlimited connections", "Scheduled queries & email reports", "Webhooks & CDC streaming", "AI assistant", "Priority support"] },
  { name: "Team", price: "—", cadence: "per seat / month", tagline: TAGLINES.TEAM, cta: CTAS.TEAM, highlight: false, features: ["Everything in Pro", "More connections & AI", "Unlimited team seats"] },
];

export function LandingPricing() {
  const [tiers, setTiers] = useState<Tier[]>(FALLBACK);

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/billing/plans/public`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((plans: PublicPlan[]) => {
        if (alive && Array.isArray(plans) && plans.length) setTiers(plans.map(planToTier));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section id="pricing" className="landing-animations max-w-6xl mx-auto px-6 py-24">
      <ScrollReveal from="up">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Simple pricing that scales with your team
          </h2>
          <p className="mt-4 text-muted-foreground">
            Start with a free trial, then pay only for the seats you use. Prices in Iraqi dinar, billed monthly.
          </p>
        </div>
      </ScrollReveal>

      <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
        {tiers.map((tier, i) => (
          <ScrollReveal key={tier.name + i} from="up" delay={i * 110} className="h-full">
            <div
              className={cn(
                "relative flex flex-col h-full rounded-2xl border p-6 transition-transform duration-300 hover:-translate-y-1",
                tier.highlight
                  ? "border-primary/50 bg-linear-to-br from-primary/10 via-card to-card shadow-lg shadow-primary/10"
                  : "border-border bg-card",
              )}
            >
              {tier.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground shadow">
                  Most popular
                </div>
              )}
              <div className="text-sm font-medium text-muted-foreground">{tier.name}</div>
              <div className="mt-2 flex items-end gap-1.5">
                <span className="text-4xl font-semibold tracking-tight">{tier.price}</span>
                <span className="mb-1 text-xs text-muted-foreground">{tier.cadence}</span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{tier.tagline}</p>

              <ul className="mt-6 space-y-2.5 flex-1">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Check className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <Link
                to="/signup"
                className={cn(
                  "mt-7 inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition-colors",
                  tier.highlight
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border hover:bg-accent",
                )}
              >
                {tier.cta} <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </ScrollReveal>
        ))}
      </div>
    </section>
  );
}
