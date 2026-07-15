import { useEffect, useState } from "react";
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
  Sparkles,
} from "lucide-react";
import {
  api,
  extractErrorMessage,
  type BillingOverview,
  type PaidTier,
  type PlanOption,
  type PlanTier,
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
    mutationFn: (plan: PaidTier) => api.createCheckout(plan),
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

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <CreditCard className="h-6 w-6 text-primary" />
            Billing &amp; plans
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data ? (
              <>
                Workspace <span className="font-medium text-foreground">{data.workspace.name}</span>
                {data.workspace.isPersonal && " (personal)"} · {data.seats} seat
                {data.seats === 1 ? "" : "s"}
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
                Online payments aren't enabled on this server yet. Plans are visible, but
                checkout is temporarily unavailable.
              </div>
            )}
            {!data.isOwner && (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                Only the workspace owner can change the plan. Ask them to upgrade.
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-3">
              {data.plans.map((p) => (
                <PlanCard
                  key={p.tier}
                  plan={p}
                  seats={data.seats}
                  current={data.effectiveTier === p.tier}
                  canBuy={data.waylEnabled && data.isOwner && p.tier !== "FREE"}
                  busy={checkout.isPending}
                  onBuy={() => checkout.mutate(p.tier as PaidTier)}
                />
              ))}
            </div>

            {data.recentPayments.length > 0 && (
              <div className="rounded-lg border border-border bg-card p-5">
                <div className="text-sm font-medium mb-3">Recent payments</div>
                <div className="divide-y divide-border">
                  {data.recentPayments.map((pmt) => (
                    <div key={pmt.id} className="flex items-center justify-between py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{pmt.plan}</span>
                        <span className="text-muted-foreground">
                          {pmt.seats} seat{pmt.seats === 1 ? "" : "s"} · {iqd(pmt.amountIqd)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-muted-foreground text-xs">
                          {format(new Date(pmt.createdAt), "d MMM yyyy")}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            pmt.status === "PAID"
                              ? "bg-primary/15 text-primary border-primary/30"
                              : pmt.status === "FAILED"
                                ? "bg-destructive/15 text-destructive border-destructive/30"
                                : "bg-muted text-muted-foreground border-border"
                          }
                        >
                          {pmt.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function CurrentPlanCard({ data }: { data: BillingOverview }) {
  const sub = data.subscription;
  const status = sub ? STATUS_LABEL[sub.status] : null;
  const tierName = data.plans.find((p) => p.tier === data.effectiveTier)?.name ?? data.effectiveTier;
  return (
    <div className="rounded-lg border border-border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Current plan</div>
        <div className="text-xl font-semibold mt-1 flex items-center gap-2">
          {tierName}
          {data.effectiveTier !== "FREE" && <Sparkles className="h-4 w-4 text-primary" />}
        </div>
      </div>
      {sub && sub.plan !== "FREE" && status && (
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

function PlanCard({
  plan,
  seats,
  current,
  canBuy,
  busy,
  onBuy,
}: {
  plan: PlanOption;
  seats: number;
  current: boolean;
  canBuy: boolean;
  busy: boolean;
  onBuy: () => void;
}) {
  const isFree = plan.tier === "FREE";
  const highlight = plan.tier === "PRO";
  return (
    <div
      className={`rounded-lg border bg-card p-5 flex flex-col ${
        current
          ? "border-primary ring-1 ring-primary/40"
          : highlight
            ? "border-primary/40"
            : "border-border"
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="font-semibold text-lg">{plan.name}</div>
        {current && (
          <Badge variant="outline" className="bg-primary/15 text-primary border-primary/30">
            Current
          </Badge>
        )}
      </div>

      <div className="mt-2 mb-4">
        {isFree ? (
          <div className="text-2xl font-bold">Free</div>
        ) : (
          <>
            <div className="text-2xl font-bold">{iqd(plan.seatPriceIqd)}</div>
            <div className="text-xs text-muted-foreground">
              per seat / month · {iqd(plan.monthlyTotalIqd)} for {seats} seat
              {seats === 1 ? "" : "s"}
            </div>
          </>
        )}
      </div>

      <ul className="space-y-2 text-sm flex-1">
        <Feature ok>{plan.maxConnections} connections</Feature>
        <Feature ok={plan.aiEnabled}>
          {plan.aiEnabled ? `AI assistant · ${plan.dailyAiCalls}/day` : "No AI assistant"}
        </Feature>
        <Feature ok>{plan.maxScheduledQueries} scheduled queries</Feature>
        <Feature ok>{plan.maxWebhooksPerConnection} webhooks / connection</Feature>
        <Feature ok>
          {plan.maxSeats == null ? "Unlimited members" : `Up to ${plan.maxSeats} members`}
        </Feature>
      </ul>

      <div className="mt-5">
        {current ? (
          <Button variant="outline" className="w-full" disabled>
            Your plan
          </Button>
        ) : isFree ? (
          <Button variant="outline" className="w-full" disabled>
            —
          </Button>
        ) : (
          <Button className="w-full" disabled={!canBuy || busy} onClick={onBuy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>Upgrade to {plan.name}</>
            )}
          </Button>
        )}
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
