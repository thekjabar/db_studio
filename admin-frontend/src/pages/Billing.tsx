import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DollarSign, Sparkles, Save, Loader2, Layers } from 'lucide-react';
import { api, money, type PlanConfig } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';

export default function Billing() {
  const q = useQuery({ queryKey: ['billing'], queryFn: () => api.getBilling() });
  const qc = useQueryClient();
  const [seat, setSeat] = useState(0);
  const [freeAi, setFreeAi] = useState(0);
  const [packCalls, setPackCalls] = useState(0);
  const [packPrice, setPackPrice] = useState(0);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (q.data) {
      setSeat(q.data.pricePerSeatCents);
      setFreeAi(q.data.dailyFreeAiCalls);
      setPackCalls(q.data.aiTopUpCallsPerPack);
      setPackPrice(q.data.aiTopUpPriceCents);
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: () => api.updateBilling({
      pricePerSeatCents: seat,
      dailyFreeAiCalls: freeAi,
      aiTopUpCallsPerPack: packCalls,
      aiTopUpPriceCents: packPrice,
      reason,
    }),
    onSuccess: () => {
      toast.success('Pricing updated — effective for new billing periods');
      qc.invalidateQueries({ queryKey: ['billing'] });
      setReason('');
    },
    onError: (e: { response?: { data?: { message?: string } } }) => {
      toast.error(e.response?.data?.message ?? 'Update failed');
    },
  });

  if (q.isLoading || !q.data) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-semibold">Billing settings</h1>
        <p className="text-sm text-muted-foreground">
          Global pricing applied to every workspace. Changes take effect on the next billing period.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!reason.trim()) {
            toast.error('A reason is required so pricing changes are auditable.');
            return;
          }
          save.mutate();
        }}
        className="space-y-6 max-w-2xl"
      >
        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-primary" />
            <h2 className="font-medium">Per-seat pricing</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="seat">Price per seat per month (cents)</Label>
              <Input
                id="seat"
                type="number"
                min={0}
                value={seat}
                onChange={(e) => setSeat(parseInt(e.target.value) || 0)}
              />
            </div>
            <div className="text-2xl font-semibold tabular-nums w-32 text-right">
              {money(seat, q.data.currency)}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            1 seat = 1 workspace member. The owner is billed for everyone on their team.
          </p>
        </Card>

        <Card className="p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-medium">AI usage</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="freeAi">Free calls / user / day</Label>
              <Input
                id="freeAi"
                type="number"
                min={0}
                value={freeAi}
                onChange={(e) => setFreeAi(parseInt(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="packCalls">Extra calls per top-up pack</Label>
              <Input
                id="packCalls"
                type="number"
                min={1}
                value={packCalls}
                onChange={(e) => setPackCalls(parseInt(e.target.value) || 1)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="packPrice">Pack price (cents / month)</Label>
              <Input
                id="packPrice"
                type="number"
                min={0}
                value={packPrice}
                onChange={(e) => setPackPrice(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            One pack adds {packCalls} extra calls per day, per user, all month. Priced at {money(packPrice, q.data.currency)} / month.
          </p>
        </Card>

        <Card className="p-5 space-y-2">
          <h2 className="font-medium">Change log</h2>
          <Label htmlFor="reason" className="text-muted-foreground font-normal">
            Reason for this change (required)
          </Label>
          <Textarea
            id="reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Annual price increase per board decision"
          />
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending || !reason.trim()}>
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </div>
      </form>

      <PlanTiers />
    </div>
  );
}

/**
 * Per-tier pricing + feature limits for the customer-facing plans (Free / Pro /
 * Team). Prices are whole IQD per seat / month — Wayl settles in Iraqi Dinar.
 */
function PlanTiers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => api.getPlans() });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 pt-2">
        <Layers className="h-4 w-4 text-primary" />
        <h2 className="text-lg font-semibold">Plan tiers</h2>
      </div>
      <p className="text-sm text-muted-foreground -mt-2">
        Customer-facing subscription tiers. Prices are per seat, per month, in IQD. Limits
        apply immediately to every workspace on that tier.
      </p>
      {q.isLoading || !q.data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading plans…
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {q.data.map((p) => (
            <PlanCardEditor key={p.tier} plan={p} onSaved={() => qc.invalidateQueries({ queryKey: ['plans'] })} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlanCardEditor({ plan, onSaved }: { plan: PlanConfig; onSaved: () => void }) {
  const [f, setF] = useState(plan);
  const [reason, setReason] = useState('');
  useEffect(() => setF(plan), [plan]);

  const save = useMutation({
    mutationFn: () =>
      api.updatePlan(plan.tier, {
        name: f.name,
        seatPriceIqd: f.seatPriceIqd,
        maxConnections: f.maxConnections,
        aiEnabled: f.aiEnabled,
        dailyAiCalls: f.dailyAiCalls,
        maxScheduledQueries: f.maxScheduledQueries,
        maxWebhooksPerConnection: f.maxWebhooksPerConnection,
        maxSeats: f.maxSeats,
        reason,
      }),
    onSuccess: () => {
      toast.success(`${plan.name} plan updated`);
      setReason('');
      onSaved();
    },
    onError: (e: { response?: { data?: { message?: string } } }) =>
      toast.error(e.response?.data?.message ?? 'Update failed'),
  });

  const num = (v: string) => (v === '' ? 0 : parseInt(v) || 0);

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{plan.name}</span>
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{plan.tier}</span>
      </div>

      <Field label="Display name">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="Price / seat / month (IQD)">
        <Input
          type="number"
          min={0}
          value={f.seatPriceIqd}
          onChange={(e) => setF({ ...f, seatPriceIqd: num(e.target.value) })}
        />
      </Field>
      <Field label="Max connections">
        <Input
          type="number"
          min={0}
          value={f.maxConnections}
          onChange={(e) => setF({ ...f, maxConnections: num(e.target.value) })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={f.aiEnabled}
          onChange={(e) => setF({ ...f, aiEnabled: e.target.checked })}
        />
        AI assistant enabled
      </label>
      <Field label="AI calls / user / day">
        <Input
          type="number"
          min={0}
          value={f.dailyAiCalls}
          disabled={!f.aiEnabled}
          onChange={(e) => setF({ ...f, dailyAiCalls: num(e.target.value) })}
        />
      </Field>
      <Field label="Max scheduled queries">
        <Input
          type="number"
          min={0}
          value={f.maxScheduledQueries}
          onChange={(e) => setF({ ...f, maxScheduledQueries: num(e.target.value) })}
        />
      </Field>
      <Field label="Max webhooks / connection">
        <Input
          type="number"
          min={0}
          value={f.maxWebhooksPerConnection}
          onChange={(e) => setF({ ...f, maxWebhooksPerConnection: num(e.target.value) })}
        />
      </Field>
      <Field label="Max seats (blank = unlimited)">
        <Input
          type="number"
          min={1}
          value={f.maxSeats ?? ''}
          onChange={(e) =>
            setF({ ...f, maxSeats: e.target.value === '' ? null : num(e.target.value) })
          }
        />
      </Field>

      <Input
        placeholder="Reason for change (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        className="w-full"
        size="sm"
        disabled={save.isPending || !reason.trim()}
        onClick={() => save.mutate()}
      >
        {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save {plan.name}
      </Button>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground font-normal">{label}</Label>
      {children}
    </div>
  );
}
