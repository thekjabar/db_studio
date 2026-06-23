import { Quote, Star } from "lucide-react";
import { ScrollReveal } from "./scroll-reveal";

/**
 * Social-proof section — testimonial cards. These are placeholder quotes that
 * read as plausible early-customer feedback; replace with real attributed
 * quotes/logos as they come in. Each card reveals on scroll with a stagger.
 */
const QUOTES = [
  {
    quote:
      "We replaced three separate tools with Query Schema. The team now browses, queries, and ships schema changes from one place — and the AI actually understands our 200-table database.",
    name: "Maya Okafor",
    role: "Staff Engineer, Fintech",
    initials: "MO",
  },
  {
    quote:
      "Scheduled queries with email reports paid for themselves in a week. The plan-regression alerts caught an index that silently got dropped before it hit production.",
    name: "Daniel Reyes",
    role: "Data Platform Lead",
    initials: "DR",
  },
  {
    quote:
      "Row-level access and column masking let us give analysts direct database access without exposing PII. Audit log export made our SOC 2 review painless.",
    name: "Lina Park",
    role: "Head of Security",
    initials: "LP",
  },
] as const;

export function LandingTestimonials() {
  return (
    <section className="landing-animations relative border-y border-border/50 bg-card/30">
      <div className="max-w-6xl mx-auto px-6 py-24">
        <ScrollReveal from="up">
          <div className="text-center max-w-2xl mx-auto">
            <div className="flex items-center justify-center gap-1 text-primary mb-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star key={i} className="h-4 w-4 fill-current" />
              ))}
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              Loved by teams who ship fast
            </h2>
            <p className="mt-4 text-muted-foreground">
              From solo founders to data platform teams — one studio for everything they do with a
              database.
            </p>
          </div>
        </ScrollReveal>

        <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6">
          {QUOTES.map((q, i) => (
            <ScrollReveal key={q.name} from="up" delay={i * 110}>
              <figure className="relative h-full rounded-2xl border border-border bg-card p-6 transition-transform duration-300 hover:-translate-y-1">
                <Quote className="h-6 w-6 text-primary/40" />
                <blockquote className="mt-3 text-sm leading-relaxed text-foreground/90">
                  “{q.quote}”
                </blockquote>
                <figcaption className="mt-5 flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {q.initials}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{q.name}</span>
                    <span className="block text-xs text-muted-foreground">{q.role}</span>
                  </span>
                </figcaption>
              </figure>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
