import { Link } from "react-router-dom";
import { ArrowRight, Database, Sparkles } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";
import { LandingHeroDemo } from "@/components/landing-hero-demo";
import { AnimatedBackdrop } from "@/components/animated-backdrop";
import { LandingHowItWorks } from "@/components/landing-how-it-works";
import { LandingStats } from "@/components/landing-stats";
import { LandingMarquee } from "@/components/landing-marquee";
import { LandingShowcase } from "@/components/landing-showcase";
import { LandingFeatureCards } from "@/components/landing-feature-cards";
import { LandingPricing } from "@/components/landing-pricing";
import { LandingTestimonials } from "@/components/landing-testimonials";
import { LandingFaq } from "@/components/landing-faq";
import { ScrollReveal } from "@/components/scroll-reveal";


export default function LandingPage() {
  const accessToken = useAuth((s) => s.accessToken);
  const isAuthed = !!accessToken;

  return (
    <div className="relative min-h-screen bg-background text-foreground overflow-x-hidden">
      <AnimatedBackdrop />
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-20">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          Query Schema
        </Link>
        <div className="flex items-center gap-2">
          <a
            href="#pricing"
            className="hidden sm:inline text-sm text-muted-foreground hover:text-foreground px-3 py-1.5"
          >
            Pricing
          </a>
          <ThemeToggle />
          {isAuthed ? (
            <Link
              to="/connections"
              className="text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 inline-flex items-center gap-1.5"
            >
              Open app <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="text-sm text-muted-foreground hover:text-foreground px-3 py-1.5"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </header>

      {/* Hero — two-column layout on desktop: copy on the left, live demo on the right.
          On mobile the demo stacks below the copy so it's still visible without scrolling
          past an empty header. */}
      <section className="relative overflow-hidden">
        {/* Ambient gradient behind the hero — same recipe as the app shell's
            gradient-bg utility but without importing it, since the landing
            surface should stay a bit more muted. */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(ellipse 70% 40% at 20% 20%, rgba(62,207,142,0.15), transparent 60%), radial-gradient(ellipse 60% 50% at 90% 80%, rgba(62,207,142,0.08), transparent 60%)",
          }}
        />
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-24 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-12 items-center">
          <div>
            <div className="landing-float inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs text-muted-foreground mb-6">
              <Sparkles className="h-3 w-3 text-primary" />
              Every tool a DB admin actually needs, in one place
            </div>
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.1]">
              The database studio for teams who
              {" "}
              <span className="landing-gradient-text">don't want five tools</span>.
            </h1>
            <p className="mt-6 text-base sm:text-lg text-muted-foreground max-w-xl">
              Browse, query, schedule, back up, and share work across Postgres, MySQL, SQL Server,
              and SQLite. One interface, role-aware, with an AI that actually knows your schema.
            </p>
            <div className="mt-8 flex items-center gap-3 flex-wrap">
              {isAuthed ? (
                <Link
                  to="/connections"
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-5 py-2.5 text-sm font-medium"
                >
                  Go to your connections <ArrowRight className="h-4 w-4" />
                </Link>
              ) : (
                <>
                  <Link
                    to="/signup"
                    className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-5 py-2.5 text-sm font-medium"
                  >
                    Get started free <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    to="/login"
                    className="inline-flex items-center gap-2 border border-border hover:bg-accent rounded-md px-5 py-2.5 text-sm"
                  >
                    Sign in
                  </Link>
                </>
              )}
            </div>
            <div className="mt-6 flex items-center gap-4 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live demo →
              </span>
              <span>Postgres · MySQL · SQL Server · SQLite</span>
            </div>
          </div>

          <div className="landing-hero-respect-rm">
            <LandingHeroDemo />
          </div>
        </div>
      </section>

      {/* Stats strip — count-up numbers that animate on scroll. */}
      <LandingStats />

      {/* Integration marquee — horizontally scrolling pill list. */}
      <LandingMarquee />

      {/* How it works — 3-step vertical flow with animated connectors. */}
      <LandingHowItWorks />

      {/* Product showcase — side-by-side reveals alternating sides. */}
      <LandingShowcase />

      {/* Feature cards — 12 cards in a responsive grid, each with its own
          scroll-reveal and hover gradient-border. */}
      <LandingFeatureCards />

      {/* Social proof — testimonial cards. */}
      <LandingTestimonials />

      {/* Pricing — three tiers, middle one highlighted. */}
      <LandingPricing />

      {/* FAQ — self-contained accordion. */}
      <LandingFaq />

      {/* Closing call-out */}
      <section className="landing-animations max-w-5xl mx-auto px-6 py-24">
        <ScrollReveal from="up">
          <div className="relative rounded-2xl border border-border bg-linear-to-br from-primary/15 via-card to-card p-8 sm:p-14 text-center overflow-hidden">
            {/* Decorative grid tile inside the card — a subtle visual echo of
                the page backdrop so the card reads as part of the same surface. */}
            <div
              aria-hidden
              className="absolute inset-0 opacity-[0.12] pointer-events-none"
              style={{
                backgroundImage:
                  "radial-gradient(rgba(62,207,142,0.6) 1px, transparent 1px)",
                backgroundSize: "24px 24px",
              }}
            />
            <h2 className="relative text-3xl sm:text-4xl font-semibold tracking-tight">
              One studio for your whole team. <span className="text-primary">Secure by default.</span>
            </h2>
            <p className="relative mt-4 text-muted-foreground max-w-xl mx-auto">
              Connect your databases, invite your team, and start in minutes. Connection credentials
              are encrypted with AES-256-GCM, access is role-aware, and every action is audit-logged.
            </p>
            <div className="relative mt-8 flex items-center justify-center gap-3 flex-wrap">
              <Link
                to={isAuthed ? "/connections" : "/signup"}
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-6 py-3 text-sm font-medium shadow-lg shadow-primary/20"
              >
                {isAuthed ? "Open the app" : "Start using it"} <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </ScrollReveal>
      </section>

      <footer className="border-t border-border text-xs text-muted-foreground py-6 text-center">
        © {new Date().getFullYear()} Query Schema
      </footer>
    </div>
  );
}
