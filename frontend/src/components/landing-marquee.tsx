import {
  BarChart3,
  Boxes,
  Braces,
  Database,
  Key,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Terminal,
  Timer,
  Webhook,
} from "lucide-react";

/**
 * Infinite horizontal marquee of integrations + feature pillars. Two copies
 * of the list are rendered back-to-back and the container translates by -50%
 * over a long animation, so the seam never shows. Slides move CSS-only —
 * zero JS each frame.
 */
const PILLS = [
  { icon: Database, label: "PostgreSQL" },
  { icon: Database, label: "MySQL" },
  { icon: Database, label: "SQL Server" },
  { icon: Database, label: "SQLite" },
  { icon: Sparkles, label: "Anthropic AI" },
  { icon: MessageSquare, label: "Slack alerts" },
  { icon: Webhook, label: "Webhooks" },
  { icon: Timer, label: "Cron scheduler" },
  { icon: BarChart3, label: "Prometheus" },
  { icon: Key, label: "AWS KMS" },
  { icon: ShieldCheck, label: "OIDC SSO" },
  { icon: Terminal, label: "CLI" },
  { icon: Braces, label: "Terraform" },
  { icon: Boxes, label: "Docker" },
] as const;

export function LandingMarquee() {
  return (
    <section className="relative py-10 overflow-hidden landing-animations">
      <div className="text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground mb-6">
        Built-in integrations
      </div>
      {/* Fade-out edges so pills don't just appear and disappear at the
          viewport boundary. Mask-image is a clean way to do this without
          per-child opacity math. */}
      <div
        className="relative"
        style={{
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0, black 8%, black 92%, transparent 100%)",
          maskImage:
            "linear-gradient(to right, transparent 0, black 8%, black 92%, transparent 100%)",
        }}
      >
        <div
          className="flex gap-4 w-max"
          style={{ animation: "landingMarquee 40s linear infinite" }}
        >
          {/* Content is duplicated: the -50% translate moves exactly one
              copy's worth, so the loop seams invisibly. */}
          {[...PILLS, ...PILLS].map((p, i) => {
            const Icon = p.icon;
            return (
              <div
                key={`${p.label}-${i}`}
                className="shrink-0 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 backdrop-blur-sm px-4 py-2 text-sm text-muted-foreground"
              >
                <Icon className="h-3.5 w-3.5 text-primary" />
                <span>{p.label}</span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
