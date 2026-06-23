import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { cn } from "@/lib/utils";

/**
 * Pricing section — three tiers. Copy is intentionally generic so it reads
 * sensibly for a hosted SaaS without committing to exact numbers the operator
 * hasn't finalized; swap the figures when billing is wired up. The middle tier
 * is visually highlighted as the recommended plan (standard SaaS pattern).
 */
const TIERS = [
  {
    name: "Free",
    price: "$0",
    cadence: "forever",
    tagline: "For solo work and side projects.",
    cta: "Start free",
    highlight: false,
    features: [
      "1 database connection",
      "SQL editor + visual query builder",
      "Schema browser & ER diagram",
      "10 AI queries / day",
      "Community support",
    ],
  },
  {
    name: "Pro",
    price: "$19",
    cadence: "per user / month",
    tagline: "For teams that live in their database.",
    cta: "Start 14-day trial",
    highlight: true,
    features: [
      "Unlimited connections",
      "Scheduled queries & email reports",
      "Webhooks & CDC streaming",
      "Cross-database federated queries",
      "Plan-regression & slow-query insights",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "talk to us",
    tagline: "For orgs with compliance needs.",
    cta: "Contact sales",
    highlight: false,
    features: [
      "SSO (SAML / OIDC) & SCIM",
      "Row-level & column-level access",
      "Audit log retention & export",
      "Dedicated private cloud",
      "SLA & dedicated support",
    ],
  },
] as const;

export function LandingPricing() {
  return (
    <section id="pricing" className="landing-animations max-w-6xl mx-auto px-6 py-24">
      <ScrollReveal from="up">
        <div className="text-center max-w-2xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Simple pricing that scales with your team
          </h2>
          <p className="mt-4 text-muted-foreground">
            Start free, upgrade when you need scheduling, sharing, and governance. No credit card to
            get going.
          </p>
        </div>
      </ScrollReveal>

      <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
        {TIERS.map((tier, i) => (
          <ScrollReveal key={tier.name} from="up" delay={i * 110} className="h-full">
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
