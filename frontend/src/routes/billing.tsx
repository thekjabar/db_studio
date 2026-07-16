import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  Check,
  CreditCard,
  Database,
  Loader2,
  Minus,
  Plus,
  Sparkles,
  Users,
} from "lucide-react";
import {
  api,
  extractErrorMessage,
  type BillingOverview,
  type PlanLimits,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuth } from "@/lib/auth-store";

const PENDING_KEY = "qs_pending_payment";

function iqd(n: number): string {
  return `${n.toLocaleString("en-US")} IQD`;
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  ACTIVE: { label: "Active", className: "bg-primary/15 text-primary border-primary/30" },
  TRIALING: { label: "Trial", className: "bg-blue-500/15 text-blue-500 border-blue-500/30" },
  PAST_DUE: { label: "Past due", className: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  SUSPENDED: { label: "Suspended", className: "bg-destructive/15 text-destructive border-destructive/30" },
  CANCELLED: { label: "Cancelled", className: "bg-muted text-muted-foreground border-border" },
};

export default function BillingRoute() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [verifying, setVerifying] = useState(false);

  const billingQ = useQuery({ queryKey: ["billing"], queryFn: () => api.getBilling() });

  // Verify-on-return: after Wayl bounces the customer back here, re-check the
  // payment straight from Wayl (webhook may not have landed yet).
  useEffect(() => {
    const ref = localStorage.getItem(PENDING_KEY);
    if (!ref) return;
    localStorage.removeItem(PENDING_KEY);
    setVerifying(true);
    api
      .verifyPayment(ref)
      .then((res) => {
        const s = res.payment?.status;
        if (s === "PAID") toast.success("Payment received — your plan is now active!");
        else if (s === "FAILED") toast.error("The payment was cancelled or failed.");
        else toast("Payment is still processing — we'll activate your plan once it settles.");
        qc.setQueryData(["billing"], res as BillingOverview);
      })
      .catch((e) => toast.error(extractErrorMessage(e)))
      .finally(() => {
        setVerifying(false);
        qc.invalidateQueries({ queryKey: ["billing"] });
      });
  }, [qc]);

  const checkout = useMutation({
    mutationFn: (seats: number) => api.createCheckout(seats),
    onSuccess: (res) => {
      // Remember the attempt so we can verify when Wayl redirects us back.
      localStorage.setItem(PENDING_KEY, res.referenceId);
      window.location.href = res.url;
    },
    onError: (e) => toast.error(extractErrorMessage(e)),
  });

  const data = billingQ.data;

  return (
    <div className="min-h-screen gradient-bg">
      <header className="h-14 flex items-center justify-between px-6 border-b border-border bg-card/50 backdrop-blur-sm">
        <Link to="/connections" className="flex items-center gap-2 font-semibold">
          <Database className="h-5 w-5 text-primary" />
          Query Schema
        </Link>
        <div className="flex items-center gap-3">
          <Link to="/connections" className="text-sm text-muted-foreground hover:text-foreground">
            Connections
          </Link>
          <span className="hidden sm:inline text-sm text-muted-foreground truncate max-w-50">
            {user?.email}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />
            Billing &amp; plans
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data ? (
              <>
                Workspace <span className="font-medium text-foreground">{data.workspace.name}</span>
                {data.workspace.isPersonal && " (personal)"}
                {data.currentSeats > 0 && (
                  <> · {data.currentSeats} seat{data.currentSeats === 1 ? "" : "s"}</>
                )}
              </>
            ) : (
              "Manage your subscription and payment."
            )}
          </p>
        </div>

        {billingQ.isLoading || verifying ? (
          <div className="flex items-center gap-2 text-muted-foreground py-16 justify-center">
            <Loader2 className="h-5 w-5 animate-spin" />
            {verifying ? "Confirming your payment…" : "Loading…"}
          </div>
        ) : billingQ.isError || !data ? (
          <div className="text-destructive text-sm py-16 text-center">
            {extractErrorMessage(billingQ.error)}
          </div>
        ) : (
          <div className="space-y-6">
            <CurrentPlanCard data={data} />

            {!data.waylEnabled && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
                Online payments aren't enabled on this server yet. Checkout is temporarily
                unavailable.
              </div>
            )}
            {!data.isOwner && (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                Only the workspace owner can change the plan. Ask them to manage billing.
              </div>
            )}

            {data.unlimited ? (
              <UnlimitedCard data={data} />
            ) : (
              <div className="grid gap-4 md:grid-cols-[1fr_1.3fr]">
                <FreePlanCard data={data} />
                <SeatPicker
                  data={data}
                  busy={checkout.isPending}
                  onBuy={(seats) => checkout.mutate(seats)}
                />
              </div>
            )}

            <PaymentHistory data={data} />
          </div>
        )}
      </main>
    </div>
  );
}

function CurrentPlanCard({ data }: { data: BillingOverview }) {
  const sub = data.subscription;
  const status = sub ? STATUS_LABEL[sub.status] : null;
  const paid = data.effectiveTier !== "FREE" && !data.locked;
  const tierName = data.locked
    ? "No active plan"
    : data.effectiveTier === "FREE"
      ? "Trial"
      : data.effectiveTier === "TEAM"
        ? "Team"
        : data.paidPlan.name;
  return (
    <div className="rounded-lg border border-border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Current plan</div>
        <div className="text-xl font-semibold mt-1 flex items-center gap-2">
          {tierName}
          {paid && <Sparkles className="h-4 w-4 text-primary" />}
        </div>
        {paid && data.currentSeats > 0 && (
          <div className="text-xs text-muted-foreground mt-1">
            {data.unlimited ? "Unlimited members" : `${data.currentSeats} seat${data.currentSeats === 1 ? "" : "s"}`}
          </div>
        )}
      </div>
      {sub && paid && status && (
        <div className="text-right">
          <Badge variant="outline" className={status.className}>
            {status.label}
          </Badge>
          <div className="text-xs text-muted-foreground mt-1">
            {sub.status === "CANCELLED" ? "Access until" : "Renews"}{" "}
            {format(new Date(sub.periodEnd), "d MMM yyyy")}
          </div>
        </div>
      )}
    </div>
  );
}

/** The dynamic per-seat purchase card: pick a team size, see the live total. */
function SeatPicker({
  data,
  busy,
  onBuy,
}: {
  data: BillingOverview;
  busy: boolean;
  onBuy: (seats: number) => void;
}) {
  const price = data.perSeatPriceIqd;
  const min = Math.max(1, data.minSeats);
  const hasPlan = data.currentSeats > 0;
  const [seats, setSeats] = useState(() => Math.max(min, data.currentSeats || min));

  // Keep in range if the overview refreshes.
  useEffect(() => {
    setSeats((s) => Math.max(min, Math.min(s, 1000)));
  }, [min]);

  const total = seats * price;
  const sameAsNow = hasPlan && seats === data.currentSeats;
  const canBuy = data.waylEnabled && data.isOwner && !sameAsNow;

  const dec = () => setSeats((s) => Math.max(min, s - 1));
  const inc = () => setSeats((s) => Math.min(1000, s + 1));

  return (
    <div className="rounded-lg border border-primary/40 bg-card p-5 flex flex-col">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-lg flex items-center gap-2">
          {data.paidPlan.name}
          <Sparkles className="h-4 w-4 text-primary" />
        </div>
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30">
          Per seat
        </Badge>
      </div>

      <div className="mt-3 mb-1 text-sm text-muted-foreground flex items-center gap-1.5">
        <Users className="h-4 w-4" /> Choose your team size
      </div>
      <div className="flex items-center gap-3 mb-1">
        <Button variant="outline" size="icon" className="h-10 w-10" onClick={dec} disabled={seats <= min}>
          <Minus className="h-4 w-4" />
        </Button>
        <input
          type="number"
          value={seats}
          min={min}
          max={1000}
          onChange={(e) => {
            const v = Math.floor(Number(e.target.value));
            if (Number.isFinite(v)) setSeats(Math.max(min, Math.min(1000, v)));
          }}
          className="w-20 text-center text-2xl font-bold bg-transparent border border-border rounded-md py-1 focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <Button variant="outline" size="icon" className="h-10 w-10" onClick={inc} disabled={seats >= 1000}>
          <Plus className="h-4 w-4" />
        </Button>
        <div className="ml-auto text-right">
          <div className="text-2xl font-bold">{iqd(total)}</div>
          <div className="text-xs text-muted-foreground">
            {seats} × {iqd(price)} / month
          </div>
        </div>
      </div>
      {min > 1 && (
        <p className="text-[11px] text-muted-foreground mb-2">
          Minimum {min} seats — that's how many members you already have.
        </p>
      )}

      <ul className="space-y-2 text-sm my-3 flex-1">
        <Feature ok>
          {seats} member{seats === 1 ? "" : "s"} across your connections
        </Feature>
        <Feature ok={data.paidPlan.aiEnabled}>
          {data.paidPlan.aiEnabled ? `AI assistant · ${data.paidPlan.dailyAiCalls}/day` : "No AI assistant"}
        </Feature>
        <Feature ok>{data.paidPlan.maxConnections} connections</Feature>
        <Feature ok>{data.paidPlan.maxScheduledQueries} scheduled queries</Feature>
        <Feature ok>{data.paidPlan.maxWebhooksPerConnection} webhooks / connection</Feature>
      </ul>

      <Button className="w-full" disabled={!canBuy || busy} onClick={() => onBuy(seats)}>
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : sameAsNow ? (
          `You have ${seats} seat${seats === 1 ? "" : "s"}`
        ) : hasPlan ? (
          `Change to ${seats} seat${seats === 1 ? "" : "s"} · ${iqd(total)}/mo`
        ) : (
          `Subscribe · ${iqd(total)}/mo`
        )}
      </Button>
      <p className="text-[11px] text-muted-foreground text-center mt-2">
        Billed monthly. Change your team size anytime.
      </p>
    </div>
  );
}

function FreePlanCard({ data }: { data: BillingOverview }) {
  const free: PlanLimits & { maxSeats: number } = data.freePlan;
  const onFree = data.effectiveTier === "FREE" && !data.locked;
  return (
    <div className={`rounded-lg border bg-card p-5 flex flex-col ${onFree ? "border-primary/40" : "border-border"}`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold text-lg">{free.name}</div>
        {onFree && (
          <Badge variant="outline" className="bg-primary/15 text-primary border-primary/30">
            Current
          </Badge>
        )}
      </div>
      <div className="mt-2 mb-4 text-2xl font-bold">Free</div>
      <ul className="space-y-2 text-sm flex-1">
        <Feature ok>{free.maxSeats} member{free.maxSeats === 1 ? "" : "s"}</Feature>
        <Feature ok={free.aiEnabled}>
          {free.aiEnabled ? `AI assistant · ${free.dailyAiCalls}/day` : "No AI assistant"}
        </Feature>
        <Feature ok={free.maxConnections > 0}>{free.maxConnections} connections</Feature>
        <Feature ok={free.maxScheduledQueries > 0}>{free.maxScheduledQueries} scheduled queries</Feature>
        <Feature ok={free.maxWebhooksPerConnection > 0}>
          {free.maxWebhooksPerConnection} webhooks / connection
        </Feature>
      </ul>
      <p className="text-[11px] text-muted-foreground mt-4">
        Subscribe to unlock connections, the AI assistant and your team.
      </p>
    </div>
  );
}

/** Shown to the grandfathered unlimited (Team) plan — no seat picker needed. */
function UnlimitedCard({ data }: { data: BillingOverview }) {
  return (
    <div className="rounded-lg border border-primary/40 bg-card p-5">
      <div className="font-semibold text-lg flex items-center gap-2">
        Team <Sparkles className="h-4 w-4 text-primary" />
      </div>
      <div className="mt-2 text-2xl font-bold">Unlimited members</div>
      <ul className="space-y-2 text-sm mt-4">
        <Feature ok>Unlimited members across your connections</Feature>
        <Feature ok={data.paidPlan.aiEnabled}>AI assistant · {data.paidPlan.dailyAiCalls}/day</Feature>
        <Feature ok>{data.paidPlan.maxConnections}+ connections</Feature>
      </ul>
    </div>
  );
}

function PaymentHistory({ data }: { data: BillingOverview }) {
  const paid = data.recentPayments.filter((p) => p.status === "PAID");
  if (paid.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="text-sm font-medium mb-3">Payment history</div>
      <div className="divide-y divide-border">
        {paid.map((pmt) => (
          <div key={pmt.id} className="flex items-center justify-between py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {pmt.seats} seat{pmt.seats === 1 ? "" : "s"} · {iqd(pmt.amountIqd)}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground text-xs">
                {format(new Date(pmt.createdAt), "d MMM yyyy")}
              </span>
              <Badge variant="outline" className="bg-primary/15 text-primary border-primary/30">
                Paid
              </Badge>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Feature({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? (
        <Check className="h-4 w-4 text-primary shrink-0" />
      ) : (
        <Minus className="h-4 w-4 text-muted-foreground shrink-0" />
      )}
      <span className={ok ? "" : "text-muted-foreground"}>{children}</span>
    </li>
  );
}
