import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";
import { cn } from "@/lib/utils";

/**
 * FAQ accordion — self-contained (no Radix dependency). One panel open at a
 * time; smooth height transition via grid-rows trick (animates cleanly without
 * measuring scrollHeight). Good for SEO and pre-empting common objections.
 */
const FAQS = [
  {
    q: "Which databases does Query Schema support?",
    a: "PostgreSQL, MySQL, SQL Server, and SQLite. You can connect to managed providers (Supabase, Neon, RDS, PlanetScale, Railway) or your own instances, optionally over an SSH tunnel.",
  },
  {
    q: "Is my data safe?",
    a: "Connection credentials are encrypted with AES-256-GCM and never leave your server. Access is role-aware (owner / editor / viewer), with optional row-level filters and column masking so people only see what they should. Every action is audit-logged.",
  },
  {
    q: "Does the AI see my data?",
    a: "The AI assistant is given your schema (table and column names) to write accurate SQL — never your row data unless you explicitly run a query and ask it about results.",
  },
  {
    q: "Can I run scheduled reports?",
    a: "Yes. Schedule any query on a cron, get the results by email (with CSV + inline chart) or Slack, and set threshold or anomaly alerts so you’re only pinged when something actually changes.",
  },
  {
    q: "Do you offer SSO and team controls?",
    a: "Yes. Enterprise plans add SSO (SAML / OIDC) and SCIM provisioning, plus row-level and column-level access controls, audit-log retention/export, and a support SLA.",
  },
  {
    q: "How do federated queries work?",
    a: "You can JOIN across multiple connections in a single query. The planner pushes filters and projections down to each source database, then merges the results — so you can analyze data spread across services without an ETL pipeline.",
  },
] as const;

export function LandingFaq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="landing-animations max-w-3xl mx-auto px-6 py-24">
      <ScrollReveal from="up">
        <div className="text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <p className="mt-4 text-muted-foreground">Everything you need to know before you start.</p>
        </div>
      </ScrollReveal>

      <div className="mt-12 space-y-3">
        {FAQS.map((f, i) => {
          const isOpen = open === i;
          return (
            <ScrollReveal key={f.q} from="up" delay={i * 60}>
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
                  aria-expanded={isOpen}
                >
                  <span className="text-sm font-medium">{f.q}</span>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300",
                      isOpen && "rotate-180 text-primary",
                    )}
                  />
                </button>
                <div
                  className={cn(
                    "grid transition-all duration-300 ease-out",
                    isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className="overflow-hidden">
                    <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
                  </div>
                </div>
              </div>
            </ScrollReveal>
          );
        })}
      </div>
    </section>
  );
}
