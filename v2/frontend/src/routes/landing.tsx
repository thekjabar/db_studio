import { Link } from "react-router-dom";
import { ArrowRight, Database, Download } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";
import { LandingHeroMock } from "@/components/landing-hero-mock";
import { AnimatedBackdrop } from "@/components/animated-backdrop";
import { LandingHowItWorks } from "@/components/landing-how-it-works";
import { LandingStats } from "@/components/landing-stats";
import { LandingMarquee } from "@/components/landing-marquee";
import { LandingShowcase } from "@/components/landing-showcase";
import { LandingFeatureCards } from "@/components/landing-feature-cards";
import { LandingPricing } from "@/components/landing-pricing";
// import { LandingTestimonials } from "@/components/landing-testimonials"; // hidden until real quotes
import { LandingFaq } from "@/components/landing-faq";
import { ScrollReveal } from "@/components/scroll-reveal";


export default function LandingPage() {
  const accessToken = useAuth((s) => s.accessToken);
  const isAuthed = !!accessToken;

  return (
    <div className="relative min-h-screen bg-background text-foreground overflow-x-hidden">
      <AnimatedBackdrop />
      {/* All content sits above the z-0 fixed backdrop so the ambient glows
          show through the (mostly transparent) sections. */}
      <div className="relative z-10">
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
          <Link
            to="/download"
            className="hidden sm:inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Download agent
          </Link>
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

      {/* Hero — dramatic, centered above a floating product window. Layered
          animated backdrop (mesh + conic glow + fading grid) gives depth; the
          copy cascades in on load via staggered hero-rise. */}
      <section className="relative overflow-hidden">
        {/* Layered backdrop — z-0 so it paints above the page bg but below the
            hero content (which is relative z-10). */}
        <div aria-hidden className="absolute inset-0 z-0 pointer-events-none">
          <div className="absolute inset-0 hero-grid opacity-80" />
          <div className="absolute -top-1/3 left-1/2 -translate-x-1/2 h-[120%] w-[140%] hero-conic opacity-70" />
          <div className="absolute inset-0 hero-mesh" />
          {/* Fade the backdrop into the page below the hero. */}
          <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-b from-transparent to-background" />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto px-6 pt-20 pb-10 sm:pt-28 text-center">
          <div
            className="hero-rise landing-float inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3.5 py-1.5 text-xs text-foreground/80 mb-7 backdrop-blur-sm"
            style={{ animationDelay: "0ms" }}
          >
            Every tool a DB team actually needs — in one studio
          </div>

          <h1
            className="hero-rise text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.05]"
            style={{ animationDelay: "90ms" }}
          >
            One studio for your
            <br className="hidden sm:block" />{" "}
            <span className="landing-gradient-text">entire database</span>.
          </h1>

          <p
            className="hero-rise mt-7 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed"
            style={{ animationDelay: "180ms" }}
          >
            Browse, query, schedule, and share across Postgres, MySQL, SQL Server, and SQLite —
            role-aware, with an AI that actually knows your schema.
          </p>

          <div
            className="hero-rise mt-9 flex items-center justify-center gap-3 flex-wrap"
            style={{ animationDelay: "270ms" }}
          >
            {isAuthed ? (
              <Link
                to="/connections"
                className="cta-sheen cta-glow inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-6 py-3 text-sm font-semibold"
              >
                Go to your connections <ArrowRight className="h-4 w-4" />
              </Link>
            ) : (
              <>
                <Link
                  to="/signup"
                  className="cta-sheen cta-glow inline-flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg px-6 py-3 text-sm font-semibold"
                >
                  Get started free <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 border border-border bg-card/50 backdrop-blur-sm hover:bg-accent rounded-lg px-6 py-3 text-sm font-medium"
                >
                  Sign in
                </Link>
              </>
            )}
          </div>

          <div
            className="hero-rise mt-6 flex items-center justify-center gap-4 text-[11px] text-muted-foreground"
            style={{ animationDelay: "360ms" }}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              No credit card required
            </span>
            <span className="hidden sm:inline">Postgres · MySQL · SQL Server · SQLite</span>
          </div>
        </div>

        {/* Floating product window, centered below the copy. */}
        <div
          className="hero-rise relative z-10 max-w-5xl mx-auto px-6 pb-20"
          style={{ animationDelay: "450ms" }}
        >
          <div className="hero-window-float rounded-xl border border-border/70 bg-card/80 backdrop-blur-md shadow-2xl shadow-primary/10 overflow-hidden ring-1 ring-white/5">
            <LandingHeroMock />
          </div>
          {/* Glow puddle under the window. */}
          <div
            aria-hidden
            className="absolute -bottom-2 left-1/2 -translate-x-1/2 h-24 w-3/4 rounded-full bg-primary/20 blur-3xl"
          />
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

      {/* Social proof — testimonial cards. Hidden until we have real, attributed
          quotes. Re-enable by uncommenting <LandingTestimonials /> below. */}
      {/* <LandingTestimonials /> */}

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
    </div>
  );
}
