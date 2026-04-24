import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DollarSign, Sparkles, Save, Loader2 } from 'lucide-react';
import { api, money } from '@/lib/api';
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
    <div className="p-6 space-y-6 max-w-2xl">
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
        className="space-y-6"
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
    </div>
  );
}
