import { useEffect, useRef, useState } from "react";
import { BarChart3, Database, KeyRound, Play, Table2, TrendingUp, Zap } from "lucide-react";

/**
 * Hero product mockup — a polished, finished product window with WORKING tabs
 * (SQL / Chart / Schema). It animates to life on view: chart bars grow with a
 * stagger and the total counts up. Every frame reads as a complete UI — no
 * half-typed SQL or empty result states.
 */

const ROWS = [
  { category: "Electronics", revenue: 184, label: "$184K" },
  { category: "Home & Garden", revenue: 142, label: "$142K" },
  { category: "Books", revenue: 99, label: "$99K" },
  { category: "Apparel", revenue: 76, label: "$76K" },
  { category: "Toys", revenue: 51, label: "$51K" },
];
const MAX = 184;
const TOTAL = 552;

const SCHEMA = [
  { name: "id", type: "uuid", pk: true },
  { name: "category", type: "varchar" },
  { name: "amount", type: "numeric" },
  { name: "status", type: "varchar" },
  { name: "created_at", type: "timestamptz" },
  { name: "user_id", type: "uuid", fk: true },
];

type Tab = "sql" | "chart" | "schema";

export function LandingHeroMock() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>("sql");
  const [grown, setGrown] = useState(false);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setGrown(true);
      setTotal(TOTAL);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.disconnect();
          setTimeout(() => setGrown(true), 250);
          const start = performance.now();
          const dur = 1100;
          const step = (t: number) => {
            const p = Math.min(1, (t - start) / dur);
            setTotal(Math.round(TOTAL * (1 - Math.pow(1 - p, 3))));
            if (p < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const TABS: { id: Tab; icon: typeof Play; label: string }[] = [
    { id: "sql", icon: Play, label: "SQL" },
    { id: "chart", icon: BarChart3, label: "Chart" },
    { id: "schema", icon: Table2, label: "Schema" },
  ];

  return (
    <div className="select-none" ref={ref}>
      {/* Title bar */}
      <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-border bg-background/50">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
        <div className="ml-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Database className="h-3 w-3 text-primary" />
          <span className="font-mono">app.queryschema.com</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          connected
        </div>
      </div>

      {/* Working tab strip */}
      <div className="flex items-center gap-1 px-3 pt-2 border-b border-border bg-background/20">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "flex items-center gap-1.5 rounded-t-md px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors " +
                (active
                  ? "border-primary text-foreground bg-card"
                  : "border-transparent text-muted-foreground hover:text-foreground")
              }
            >
              <t.icon className="h-3 w-3" /> {t.label}
            </button>
          );
        })}
      </div>

      {/* Panel — min height so switching tabs doesn't jump the layout. */}
      <div className="min-h-[300px]">
        {tab === "sql" && (
          <div className="grid grid-cols-1 md:grid-cols-2">
            <div className="border-b md:border-b-0 md:border-r border-border p-4 font-mono text-[13px] leading-relaxed">
              <div className="flex">
                <div className="select-none pr-3 text-right text-muted-foreground/40 tabular-nums">
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <div key={n}>{n}</div>
                  ))}
                </div>
                <pre className="whitespace-pre-wrap flex-1">
                  <span className="text-primary font-medium">SELECT</span>
                  {"\n  category,\n  "}
                  <span className="text-primary font-medium">SUM</span>
                  {"(amount) "}
                  <span className="text-primary font-medium">AS</span>
                  {" revenue\n"}
                  <span className="text-primary font-medium">FROM</span>
                  {" orders\n"}
                  <span className="text-primary font-medium">WHERE</span>
                  {" created_at >= "}
                  <span className="text-amber-500">:since</span>
                  {"\n"}
                  <span className="text-primary font-medium">GROUP BY</span>
                  {" category\n"}
                  <span className="text-primary font-medium">ORDER BY</span>
                  {" revenue "}
                  <span className="text-primary font-medium">DESC</span>
                  {";"}
                  <span className="inline-block w-1.75 h-[1.05em] translate-y-0.5 ml-0.5 bg-primary hero-caret" />
                </pre>
              </div>
              <div className="mt-4 flex items-center gap-2 text-[10px] text-muted-foreground font-sans">
                <span className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary px-1.5 py-0.5">
                  <Zap className="h-3 w-3" /> 42ms
                </span>
                <span>5 rows · cached</span>
              </div>
            </div>
            <div className="p-4">
              <ChartHeader total={total} />
              <Bars grown={grown} />
            </div>
          </div>
        )}

        {tab === "chart" && (
          <div className="p-6">
            <ChartHeader total={total} big />
            <div className="mt-2">
              <Bars grown={grown} big />
            </div>
          </div>
        )}

        {tab === "schema" && (
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Table2 className="h-3 w-3 text-primary" /> public.orders · 6 columns
            </div>
            <div className="rounded-lg border border-border overflow-hidden text-xs">
              <div className="grid grid-cols-[1fr_1fr_auto] bg-muted/30 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <span>Column</span>
                <span>Type</span>
                <span>Key</span>
              </div>
              {SCHEMA.map((c) => (
                <div
                  key={c.name}
                  className="grid grid-cols-[1fr_1fr_auto] items-center px-3 py-2 border-t border-border font-mono"
                >
                  <span className="text-foreground">{c.name}</span>
                  <span className="text-muted-foreground">{c.type}</span>
                  <span>
                    {c.pk && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 text-amber-500 px-1.5 py-0.5 text-[10px] font-sans">
                        <KeyRound className="h-2.5 w-2.5" /> PK
                      </span>
                    )}
                    {c.fk && (
                      <span className="inline-flex items-center rounded bg-primary/15 text-primary px-1.5 py-0.5 text-[10px] font-sans">
                        FK
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChartHeader({ total, big }: { total: number; big?: boolean }) {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <BarChart3 className="h-3 w-3 text-primary" /> Revenue · last 7d
        </div>
        <div className="flex items-center gap-1 text-[10px] text-emerald-400">
          <TrendingUp className="h-3 w-3" /> +12.4%
        </div>
      </div>
      <div className="mb-4">
        <div className={(big ? "text-3xl" : "text-2xl") + " font-semibold tracking-tight tabular-nums"}>
          ${total}K
        </div>
        <div className="text-[10px] text-muted-foreground">total across 5 categories</div>
      </div>
    </>
  );
}

function Bars({ grown, big }: { grown: boolean; big?: boolean }) {
  return (
    <div className={big ? "space-y-3.5" : "space-y-2.5"}>
      {ROWS.map((r, i) => (
        <div key={r.category} className="flex items-center gap-3 text-xs">
          <span className="w-24 shrink-0 text-muted-foreground truncate">{r.category}</span>
          <div className={(big ? "h-6" : "h-4") + " flex-1 rounded-full bg-muted/40 overflow-hidden"}>
            <div
              className="h-full rounded-full bg-linear-to-r from-primary/60 to-primary"
              style={{
                width: grown ? `${(r.revenue / MAX) * 100}%` : "0%",
                transition: "width 900ms cubic-bezier(0.22, 1, 0.36, 1)",
                transitionDelay: `${i * 110}ms`,
              }}
            />
          </div>
          <span
            className="w-12 shrink-0 text-right tabular-nums text-muted-foreground transition-opacity duration-500"
            style={{ opacity: grown ? 1 : 0, transitionDelay: `${i * 110 + 300}ms` }}
          >
            {r.label}
          </span>
        </div>
      ))}
    </div>
  );
}
