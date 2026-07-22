import { CountUpOnReveal, ScrollReveal } from "./scroll-reveal";

/**
 * Stats strip — four count-up numbers. Each one animates from 0 to its
 * target when the element enters the viewport. Numbers are illustrative;
 * operators can swap them for real telemetry as the product matures.
 */
const STATS = [
  { value: 4, suffix: "", label: "Dialects supported", hint: "Postgres · MySQL · SQL Server · SQLite" },
  { value: 99.95, suffix: "%", label: "Typical query latency p95", hint: "on indexed reads under 100ms" },
  { value: 10_000, suffix: "+", label: "Rows streamed per second", hint: "federated joins across connections" },
  { value: 50, suffix: "ms", label: "Median round-trip time", hint: "editor → driver → result" },
] as const;

export function LandingStats() {
  return (
    <section className="relative border-y border-border/50 bg-card/40 backdrop-blur-sm landing-animations">
      <div className="max-w-6xl mx-auto px-6 py-12 grid grid-cols-2 sm:grid-cols-4 gap-6">
        {STATS.map((s, i) => (
          <ScrollReveal key={s.label} from="up" delay={i * 90}>
            <div className="text-center sm:text-left">
              <div className="text-3xl sm:text-4xl font-semibold text-primary tracking-tight">
                <CountUpOnReveal
                  value={s.value}
                  // Nicely-rounded formatting for the ratio-style stats so
                  // 99.95 doesn't bounce through garbage like 99.27 during
                  // the tween. For big numbers we use locale formatting.
                  format={(n) =>
                    s.suffix === "%"
                      ? n.toFixed(2)
                      : n >= 1000
                        ? Math.round(n).toLocaleString()
                        : Math.round(n).toString()
                  }
                />
                <span className="text-2xl ml-0.5">{s.suffix}</span>
              </div>
              <div className="mt-1 text-sm font-medium">{s.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{s.hint}</div>
            </div>
          </ScrollReveal>
        ))}
      </div>
    </section>
  );
}
