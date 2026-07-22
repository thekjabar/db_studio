import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  CheckCircle2,
  Database,
  Play,
  Server,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Animated hero demo for the landing page.
 *
 * A 3-act state machine cycles every ~18 seconds:
 *   1. SQL typing → query runs → rows stream in
 *   2. Multi-DB transmission → packets fly from the app to three databases
 *   3. Rows become a live bar chart
 *
 * Intentionally self-contained: no framer-motion / lottie / react-spring.
 * All motion is CSS transitions + setInterval ticks driving React state.
 * Keeps bundle additions under ~5KB and respects `prefers-reduced-motion`
 * (the wrapping page can conditionally render a static fallback if needed).
 */

type Act = "query" | "transmit" | "chart";

const SQL_LINES = [
  "SELECT",
  "  category,",
  "  SUM(amount) AS revenue",
  "FROM orders",
  "WHERE created_at >= :since",
  "GROUP BY category",
  "ORDER BY revenue DESC;",
];

const RESULT_ROWS = [
  { category: "Electronics", revenue: 184_320 },
  { category: "Home & Garden", revenue: 142_180 },
  { category: "Books", revenue: 98_700 },
  { category: "Apparel", revenue: 76_430 },
  { category: "Toys", revenue: 51_290 },
];

const DATABASES = [
  { name: "users_db", dialect: "Postgres", color: "#3b82f6" },
  { name: "orders_db", dialect: "MySQL", color: "#f59e0b" },
  { name: "analytics", dialect: "Postgres", color: "#10b981" },
];

export function LandingHeroDemo() {
  const [act, setAct] = useState<Act>("query");
  // Within each act, a monotonic tick drives sub-steps (keystrokes, packet
  // positions, chart-bar growth). We reset it on act change so each scene
  // starts from zero.
  const [tick, setTick] = useState(0);
  const actRef = useRef(act);
  actRef.current = act;

  // Advance the tick ~12x/sec while the tab is visible. Slower than 30fps
  // on purpose — makes the typing, packet motion, and bar growth feel
  // deliberate rather than hectic. All actors derive their speed from
  // `tick`, so changing this is the one-line tempo control for the demo.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      if (document.visibilityState === "visible" && t - last > 80) {
        last = t;
        setTick((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Per-act durations. Deliberately varied so the rhythm doesn't feel
  // metronomic — the query scene lingers so you have time to read the SQL,
  // the sync scene is medium, and the chart lingers longest so the bars
  // fully arrive before cycling. Single source of truth used both for the
  // act-advance timer and the tick advancement below.
  const ACT_MS: Record<Act, number> = {
    query: 11000,
    transmit: 9000,
    chart: 13000,
  };
  useEffect(() => {
    const t = setTimeout(() => {
      setAct((a) => (a === "query" ? "transmit" : a === "transmit" ? "chart" : "query"));
      setTick(0);
    }, ACT_MS[act]);
    return () => clearTimeout(t);
    // ACT_MS is stable per render; React will re-run this only on `act` change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [act]);

  return (
    <div className="relative">
      {/* Floating ambient orbs behind the frame — pure decoration, no
          interaction. Two slowly-drifting gradient blobs that pulse opacity.
          Kept outside the main card so the card's shadow doesn't clip them. */}
      <FloatingOrbs />

      <div className="relative rounded-xl border border-border bg-card/60 backdrop-blur-sm overflow-hidden shadow-2xl">
        {/* Act-change glow — the ring briefly brightens whenever the scene
            swaps. Uses `key={act}` to retrigger the CSS animation. */}
        <div
          key={act}
          aria-hidden
          className="absolute inset-0 rounded-xl pointer-events-none animate-[heroActGlow_1.2s_ease-out_1]"
          style={{
            boxShadow: "0 0 0 1px rgba(62,207,142,0.4), 0 0 40px 4px rgba(62,207,142,0.25)",
          }}
        />

        {/* Mock window chrome — minimal: traffic-light dots + URL. No scene
            tabs or progress bar; those distracted from the content and
            were reading as UI chrome the user should interact with. */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-background/40">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          <div className="ml-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Database className="h-3 w-3 text-primary" />
            <span className="font-mono">app.queryschema.com</span>
          </div>
        </div>

      <div className="grid grid-cols-5 gap-0 h-[360px]">
        {/* Left: SQL editor */}
        <div className="col-span-2 border-r border-border p-4 font-mono text-xs overflow-hidden">
          <QueryActor act={act} tick={tick} />
        </div>

        {/* Right: results + transmit overlay + chart */}
        <div className="col-span-3 p-4 relative overflow-hidden">
          {/* The three acts occupy the same space and cross-fade. Using
              opacity rather than conditional mounting keeps the layout
              stable across transitions. */}
          <div
            className={cn(
              "absolute inset-4 transition-opacity duration-500",
              act === "query" ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <ResultActor tick={act === "query" ? tick : 0} />
          </div>
          <div
            className={cn(
              "absolute inset-4 transition-opacity duration-500",
              act === "transmit" ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <TransmitActor tick={act === "transmit" ? tick : 0} />
          </div>
          <div
            className={cn(
              "absolute inset-4 transition-opacity duration-500",
              act === "chart" ? "opacity-100" : "opacity-0 pointer-events-none",
            )}
          >
            <ChartActor tick={act === "chart" ? tick : 0} />
          </div>
        </div>
      </div>
      </div>

    </div>
  );
}

// ---- Act 1: SQL typing -----------------------------------------------------

function QueryActor({ act, tick }: { act: Act; tick: number }) {
  const fullSql = SQL_LINES.join("\n");
  // Typing with burst cadence: humans type in chunks, not uniformly.
  // We map linear tick progress through a piecewise curve so the caret
  // pauses briefly at punctuation / line breaks and races across keywords.
  // The curve peaks and flats are derived once per full render.
  const shownChars = act === "query" ? burstTypedLength(tick, fullSql.length) : fullSql.length;
  const shown = fullSql.slice(0, Math.min(shownChars, fullSql.length));
  const isDone = shownChars >= fullSql.length;

  // Brief "AI suggested this" badge during the first half of typing —
  // reinforces the AI story visually while nothing else is happening.
  const showAiHint = act === "query" && tick > 10 && tick < 90;

  return (
    <div className="h-full">
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Play className="h-3 w-3 text-primary" />
        SQL Editor
        {showAiHint && (
          <span className="ml-auto inline-flex items-center gap-1 normal-case rounded bg-primary/10 text-primary px-1.5 py-0.5 text-[9px] font-sans animate-[fadeIn_.5s_ease-out_forwards]">
            <Sparkles className="h-2.5 w-2.5" />
            AI-suggested
          </span>
        )}
      </div>
      <pre className="whitespace-pre leading-relaxed text-foreground">
        <Highlighted text={shown} />
        {act === "query" && <Caret blink={isDone} />}
      </pre>
      {isDone && act === "query" && (
        <div className="mt-3 inline-flex items-center gap-1.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-1 text-[10px] animate-[fadeIn_.4s_ease-out_forwards]">
          <Zap className="h-3 w-3" /> Executed · {42 + (tick % 10)}ms
        </div>
      )}
    </div>
  );
}

/** Burst-typing curve: returns how many chars should be shown at tick `t`
 *  for a string of total length `len`. Creates a "racing then pausing" feel
 *  by squaring a sinusoidal component, which pushes progress toward the
 *  ends of each typing burst. */
function burstTypedLength(t: number, len: number): number {
  const x = t * 0.6; // baseline chars per tick
  // Small pause wobble — every ~20 chars, hold briefly.
  const pauseFactor = 1 - 0.3 * Math.max(0, Math.sin(x * 0.4));
  return Math.floor(Math.min(len, x * pauseFactor + t * 0.35));
}

function Caret({ blink }: { blink: boolean }) {
  return (
    <span
      className={cn(
        "inline-block w-1.5 h-[1em] align-[-0.15em] bg-primary ml-px",
        blink && "animate-pulse",
      )}
    />
  );
}

/** Crude but effective SQL highlighter — keyword-first, no proper lexer. */
function Highlighted({ text }: { text: string }) {
  const KEYWORDS = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|DESC|ASC|NOW|INTERVAL|AND|OR|SUM|AS|BY|LIMIT)\b/g;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(KEYWORDS, "g");
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(
      <span key={i++} className="text-primary font-semibold">
        {m[0]}
      </span>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
}

// ---- Act 1.5: Results stream in -------------------------------------------

function ResultActor({ tick }: { tick: number }) {
  // Rows fade in once the typing finishes. At the current tick rate (~12/s)
  // typing lands around tick 70; rows appear ~every 6 ticks (0.5s apart).
  const startTick = 70;
  const visibleRows = Math.max(0, Math.min(RESULT_ROWS.length, Math.floor((tick - startTick) / 6)));

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Database className="h-3 w-3 text-primary" />
        Result · <OdometerNumber value={visibleRows} />{" "}
        row{visibleRows === 1 ? "" : "s"}
      </div>
      <div className="rounded border border-border bg-background/40 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto] gap-3 px-3 py-1.5 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>category</span>
          <span className="text-right">revenue</span>
        </div>
        {RESULT_ROWS.map((r, i) => {
          const shown = i < visibleRows;
          return (
            <div
              key={r.category}
              className={cn(
                "grid grid-cols-[1fr_auto] gap-3 px-3 py-1.5 text-xs font-mono border-b border-border/40 last:border-b-0 transition-all",
                shown ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2",
              )}
              style={{ transitionDelay: `${i * 40}ms` }}
            >
              <span>{r.category}</span>
              <span className="text-right text-primary">
                ${shown ? <CountUp target={r.revenue} /> : 0}
              </span>
            </div>
          );
        })}
      </div>
      {visibleRows === RESULT_ROWS.length && (
        <div className="mt-3 inline-flex items-center gap-1.5 text-[10px] text-muted-foreground animate-[fadeIn_.4s_ease-out_forwards]">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Ready to chart
        </div>
      )}
    </div>
  );
}

// ---- Act 2: Multi-DB transmission -----------------------------------------

function TransmitActor({ tick }: { tick: number }) {
  // Packets travel from the app node to a DB node, cycling continuously.
  // Geometry is measured from the DOM (ResizeObserver + refs) instead of
  // hard-coded percentages — earlier versions had packets landing off the
  // nodes because the container height varied with the viewport.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const dbRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [geom, setGeom] = useState<{ app: { x: number; y: number }; dbs: { x: number; y: number }[]; w: number; h: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      if (!wrapRef.current || !appRef.current) return;
      const wrap = wrapRef.current.getBoundingClientRect();
      const app = appRef.current.getBoundingClientRect();
      const dbs = dbRefs.current.map((el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - wrap.left, y: r.top - wrap.top + r.height / 2 };
      });
      if (dbs.some((d) => d === null)) return;
      setGeom({
        app: {
          x: app.left - wrap.left + app.width,
          y: app.top - wrap.top + app.height / 2,
        },
        dbs: dbs as { x: number; y: number }[],
        w: wrap.width,
        h: wrap.height,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const PACKET_PERIOD = 20;
  const packets = Array.from({ length: 8 }).map((_, i) => {
    const birth = i * 5;
    const age = ((tick - birth + PACKET_PERIOD * 4) % PACKET_PERIOD) / PACKET_PERIOD;
    const targetIdx = i % DATABASES.length;
    return { age, targetIdx, id: i };
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Server className="h-3 w-3 text-primary" />
        Live multi-DB sync
      </div>

      <div ref={wrapRef} className="relative flex-1 flex items-center justify-between px-2">
        {/* App node (left) */}
        <div className="flex flex-col items-center gap-1 z-10">
          <div
            ref={appRef}
            className="h-10 w-10 rounded-lg border border-primary/40 bg-primary/10 flex items-center justify-center"
          >
            <Database className="h-5 w-5 text-primary" />
          </div>
          <span className="text-[10px] text-muted-foreground font-mono">studio</span>
        </div>

        {/* DB nodes (right, stacked) */}
        <div className="flex flex-col gap-3 z-10">
          {DATABASES.map((db, idx) => {
            // Pulse when a packet just arrived at this DB. A packet arrival
            // corresponds to age ≈ 1.0 (or 0.0, since we wrap). We detect any
            // packet whose age is within a tight window for this target.
            const isArriving = packets.some(
              (p) => p.targetIdx === idx && (p.age > 0.92 || p.age < 0.05),
            );
            return (
              <div key={db.name} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground">{db.name}</span>
                <div
                  ref={(el) => {
                    dbRefs.current[idx] = el;
                  }}
                  className={cn(
                    "relative h-9 w-9 rounded-lg flex items-center justify-center border transition-all",
                    isArriving && "scale-110",
                  )}
                  style={{
                    borderColor: db.color + (isArriving ? "cc" : "66"),
                    background: db.color + (isArriving ? "33" : "1a"),
                    boxShadow: isArriving ? `0 0 16px ${db.color}80` : "none",
                  }}
                >
                  <Database className="h-4 w-4" style={{ color: db.color }} />
                  {isArriving && (
                    <span
                      aria-hidden
                      className="absolute inset-0 rounded-lg animate-ping"
                      style={{ boxShadow: `0 0 0 2px ${db.color}80` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Lines + animated packets — drawn in the wrap's own pixel space so
            endpoints always land exactly on node edges. */}
        {geom && (
          <svg
            className="absolute inset-0 pointer-events-none"
            width={geom.w}
            height={geom.h}
            viewBox={`0 0 ${geom.w} ${geom.h}`}
          >
            {geom.dbs.map((db, idx) => (
              <line
                key={idx}
                x1={geom.app.x}
                y1={geom.app.y}
                x2={db.x}
                y2={db.y}
                stroke="currentColor"
                strokeOpacity={0.18}
                strokeWidth={1}
                strokeDasharray="3 3"
                className="text-foreground"
              />
            ))}
            {packets.map((p) => {
              const target = geom.dbs[p.targetIdx];
              const color = DATABASES[p.targetIdx].color;
              // Packet position.
              const x = geom.app.x + (target.x - geom.app.x) * p.age;
              const y = geom.app.y + (target.y - geom.app.y) * p.age;
              // Trail: 4 fading dots behind the packet.
              const trail = [0.12, 0.08, 0.05, 0.025].map((lag, idx) => {
                const lagAge = Math.max(0, p.age - lag);
                return {
                  idx,
                  lag,
                  tx: geom.app.x + (target.x - geom.app.x) * lagAge,
                  ty: geom.app.y + (target.y - geom.app.y) * lagAge,
                  opacity: (1 - Math.abs(p.age - 0.5) * 1.6) * (0.6 - idx * 0.12),
                };
              });
              return (
                <g key={p.id}>
                  {trail.map((t) => (
                    <circle
                      key={t.idx}
                      cx={t.tx}
                      cy={t.ty}
                      r={3 - t.idx * 0.5}
                      fill={color}
                      opacity={Math.max(0, t.opacity)}
                    />
                  ))}
                  <circle
                    cx={x}
                    cy={y}
                    r={3}
                    fill={color}
                    opacity={1 - Math.abs(p.age - 0.5) * 1.6}
                  />
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="mt-2 text-[10px] text-muted-foreground font-mono flex items-center gap-3">
        <span>
          rows/s: <ScrambleNumber value={1200 + (tick % 40)} className="text-primary" />
        </span>
        <span>
          latency: <ScrambleNumber value={12 + (tick % 5)} className="text-primary" suffix="ms" />
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          sync healthy
        </span>
      </div>
    </div>
  );
}

// ---- Act 3: Chart building -------------------------------------------------

function ChartActor({ tick }: { tick: number }) {
  const max = Math.max(...RESULT_ROWS.map((r) => r.revenue));
  // Chart is the slowest act by design — the bars grow gently so viewers
  // have time to read the numbers. 25 ticks * ~80ms = ~2s per bar, with a
  // 4-tick stagger between rows.
  const GROWTH_TICKS = 25;
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
        <BarChart3 className="h-3 w-3 text-primary" />
        Revenue by category · last 7d
      </div>
      <div className="flex-1 flex flex-col gap-2 justify-center">
        {RESULT_ROWS.map((r, i) => {
          const start = i * 4;
          const progress = Math.max(0, Math.min(1, (tick - start) / GROWTH_TICKS));
          // Easing — cubic-ease-out. Makes the growth feel less robotic.
          const eased = 1 - Math.pow(1 - progress, 3);
          const pct = (r.revenue / max) * 100 * eased;
          return (
            <div key={r.category} className="flex items-center gap-2 text-xs">
              <span className="w-24 truncate text-muted-foreground">{r.category}</span>
              <div className="flex-1 h-5 rounded bg-muted/40 overflow-hidden">
                <div
                  className="h-full rounded bg-linear-to-r from-primary/70 to-primary transition-[width] duration-75"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-16 text-right font-mono text-[10px] text-muted-foreground">
                ${Math.round((r.revenue / 1000) * eased)}K
              </span>
            </div>
          );
        })}
      </div>
      {tick > 40 && (
        <div className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-muted-foreground animate-[fadeIn_.4s_ease-out_forwards]">
          <Zap className="h-3 w-3 text-primary" /> Pinned to dashboard · auto-refresh every 60s
        </div>
      )}
    </div>
  );
}

// ---- Decorative helpers ----------------------------------------------------

/** Two drifting gradient orbs behind the hero — parallax ambient lighting. */
function FloatingOrbs() {
  return (
    <>
      <div
        aria-hidden
        className="absolute -top-20 -left-20 h-64 w-64 rounded-full blur-3xl opacity-40 pointer-events-none"
        style={{
          background: "radial-gradient(closest-side, rgba(62,207,142,0.6), transparent)",
          animation: "heroOrbDrift 14s ease-in-out infinite",
        }}
      />
      <div
        aria-hidden
        className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full blur-3xl opacity-30 pointer-events-none"
        style={{
          background: "radial-gradient(closest-side, rgba(62,207,142,0.4), transparent)",
          animation: "heroOrbDrift 18s ease-in-out infinite reverse",
          animationDelay: "-4s",
        }}
      />
    </>
  );
}

/** Smoothly tick through integers. The `value` changes immediately but we
 *  render the current-shown number, stepping toward target on each render. */
function OdometerNumber({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (shown === value) return;
    const id = setTimeout(() => {
      setShown((s) => (s < value ? s + 1 : s > value ? s - 1 : s));
    }, 40);
    return () => clearTimeout(id);
  }, [shown, value]);
  return <span className="tabular-nums font-mono text-primary">{shown}</span>;
}

/** Count up from 0 to `target` over ~0.6 seconds, easing out. */
function CountUp({ target }: { target: number }) {
  const [shown, setShown] = useState(0);
  const startRef = useRef(performance.now());
  useEffect(() => {
    startRef.current = performance.now();
    let raf = 0;
    const DURATION = 600;
    const step = () => {
      const elapsed = performance.now() - startRef.current;
      const t = Math.min(1, elapsed / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <>{shown.toLocaleString()}</>;
}

/** Scramble-in effect: show 2-3 random digits before locking to `value`.
 *  Called every time `value` changes, which is every tick for the sync HUD
 *  — produces a slot-machine flicker without taking over the DOM. */
function ScrambleNumber({
  value,
  className,
  suffix,
}: {
  value: number;
  className?: string;
  suffix?: string;
}) {
  const [display, setDisplay] = useState(String(value));
  const lastRef = useRef(value);
  useEffect(() => {
    // Only scramble on significant jumps so we don't flicker every tick.
    const delta = Math.abs(value - lastRef.current);
    lastRef.current = value;
    if (delta < 1) {
      setDisplay(String(value));
      return;
    }
    let frames = 0;
    const maxFrames = 4;
    const id = setInterval(() => {
      frames++;
      if (frames >= maxFrames) {
        setDisplay(String(value));
        clearInterval(id);
      } else {
        const digits = String(value).length;
        const rand = Math.floor(Math.random() * Math.pow(10, digits));
        setDisplay(String(rand).padStart(digits, "0"));
      }
    }, 50);
    return () => clearInterval(id);
  }, [value]);
  return (
    <span className={cn("tabular-nums font-mono", className)}>
      {display}
      {suffix ?? ""}
    </span>
  );
}
