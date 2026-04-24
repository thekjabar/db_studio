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
    blurb:
      "Add a Postgres, MySQL, SQL Server, or SQLite connection. Credentials are encrypted with AES-256-GCM; the master key lives in your KMS of choice.",
  },
  {
    icon: Zap,
    title: "Query with anyone",
    blurb:
      "Write SQL with schema-aware autocomplete, or ask the AI. Share saved queries with your team, gate destructive changes behind approvals.",
  },
  {
    icon: Database,
    title: "Ship it live",
    blurb:
      "Pin queries to dashboards, schedule alerts to Slack, stream metrics to Prometheus. Your team sees the same numbers you do.",
  },
] as const;

export function LandingHowItWorks() {
  return (
    <section className="relative landing-animations">
      <div className="max-w-4xl mx-auto px-6 py-20 sm:py-28">
        <ScrollReveal from="up">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-3 py-1 text-xs text-muted-foreground mb-4">
              Three steps
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">
              From zero to shipped <span className="text-primary">in a morning</span>.
            </h2>
            <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
              No SDK install, no schema generation, no dashboard editor. Just connect and work.
            </p>
          </div>
        </ScrollReveal>

        <div className="relative">
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div key={step.title} className="relative">
                <ScrollReveal from="up" delay={i * 140}>
                  <div className="flex items-start gap-4 py-4">
                    {/* Circular step number + icon */}
                    <div className="relative shrink-0">
                      <div className="h-14 w-14 rounded-full border border-primary/30 bg-card/80 backdrop-blur-sm flex items-center justify-center">
                        <Icon className="h-6 w-6 text-primary" />
                      </div>
                      <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary text-primary-foreground text-[10px] font-mono flex items-center justify-center shadow-lg">
                        {i + 1}
                      </span>
                    </div>

                    {/* Card body */}
                    <div className="flex-1 rounded-lg border border-border bg-card/60 backdrop-blur-sm p-5 shadow-sm">
                      <h3 className="font-semibold text-lg">{step.title}</h3>
                      <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{step.blurb}</p>
                    </div>
                  </div>
                </ScrollReveal>

                {/* Connector streak between this step and the next */}
                {i < STEPS.length - 1 && (
                  <ScrollReveal from="fade" delay={i * 140 + 200} duration={500}>
                    <Connector />
                  </ScrollReveal>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Vertical dashed line with a green light-streak repeatedly flowing down.
 *  Positioned so it aligns with the center of the circular icon above it. */
function Connector() {
  return (
    <div className="relative h-12 ml-7 -my-1" aria-hidden>
      <svg className="absolute inset-0 w-px h-full overflow-visible" viewBox="0 0 1 100" preserveAspectRatio="none">
        <line
          x1="0.5"
          y1="0"
          x2="0.5"
          y2="100"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke"
          className="text-muted-foreground"
        />
        <line
          x1="0.5"
          y1="0"
          x2="0.5"
          y2="100"
          stroke="rgb(62,207,142)"
          strokeWidth="2"
          strokeDasharray="20 200"
          vectorEffect="non-scaling-stroke"
          style={{
            animation: "landingStreakFlow 2.4s ease-in-out infinite",
          }}
        />
      </svg>
    </div>
  );
}
