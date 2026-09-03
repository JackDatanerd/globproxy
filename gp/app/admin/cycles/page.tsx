import Link from 'next/link'
import { createAdminClient } from '@/lib/supabase/server'
import {
  currentAccruingCycle,
  lastCompletedCycle,
  cycleBefore,
  cycleAfter,
  cycleFromStart,
  formatCycleLabel,
  type PayoutCycle,
} from '@/lib/payoutCycle'
import { GEONODE_COST_PER_GB_USD } from '@/lib/constants'
import { formatGb } from '@/lib/format'

type PayoutMethodKey = 'usdt' | 'mpesa' | 'bank' | 'unset'

function cycleWindow(cycle: PayoutCycle) {
  // Half-open UTC window: [cycleStart 00:00Z, dayAfterCycleEnd 00:00Z).
  // Same "which calendar day does this row belong to" rule the payout
  // RPC uses (migration 0034), just expressed as an indexable range
  // instead of a ::date cast.
  const start = `${cycle.cycleStart}T00:00:00.000Z`
  const endExclusive = new Date(`${cycle.cycleEnd}T00:00:00.000Z`)
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)
  return { start, end: endExclusive.toISOString() }
}

function methodLabel(key: PayoutMethodKey): string {
  if (key === 'usdt') return 'USDT (TRC20)'
  if (key === 'mpesa') return 'M-Pesa'
  if (key === 'bank') return 'Bank transfer'
  return 'No method set'
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default async function AdminCyclesPage({
  searchParams,
}: {
  searchParams: Promise<{ start?: string }>
}) {
  const sp = await searchParams
  const supabase = await createAdminClient()

  // Default to the last fully-completed cycle — the one "Run payout
  // cycle" on /admin/affiliates would act on right now, which is the
  // number an admin actually needs before a payout run. Only accept a
  // `?start=` override if it's genuinely a cycle-start day (the 1st or
  // 16th); cycleFromStart() derives everything else itself rather than
  // trusting an end date from the URL.
  let cycle: PayoutCycle = lastCompletedCycle()
  if (sp.start && /^\d{4}-\d{2}-(01|16)$/.test(sp.start)) {
    cycle = cycleFromStart(sp.start)
  }

  const accruing = currentAccruingCycle()
  const isAccruingCycle = cycle.cycleStart === accruing.cycleStart
  const prev = cycleBefore(cycle)
  const next = cycleAfter(cycle)
  const canGoNext = next.cycleStart <= accruing.cycleStart // never navigate past the still-accruing cycle

  const { start, end } = cycleWindow(cycle)

  const [{ data: orders }, { data: existingPayouts }] = await Promise.all([
    supabase
      .from('orders')
      .select('amount_usd, gb_amount')
      .eq('payment_status', 'paid')
      .eq('is_canary', false)
      .gte('created_at', start)
      .lt('created_at', end),
    supabase
      .from('affiliate_payouts')
      .select('amount_usd, payout_method')
      .eq('cycle_start', cycle.cycleStart)
      .eq('cycle_end', cycle.cycleEnd),
  ])

  const totalSales = orders?.reduce((s, o) => s + Number(o.amount_usd), 0) ?? 0
  const totalGbSold = orders?.reduce((s, o) => s + Number(o.gb_amount), 0) ?? 0
  const orderCount = orders?.length ?? 0
  const geonodeCost = totalGbSold * GEONODE_COST_PER_GB_USD

  // "How much of that is from the affiliate program" is the cost side —
  // what's owed to affiliates for this window — broken down by payout
  // method so the admin knows how much USDT/bank/M-Pesa to have ready.
  // Once this cycle has actually been run, affiliate_payouts is the
  // authoritative, method-snapshotted source (the destination is locked
  // in at run time — see migration 0034 — so it can't drift even if an
  // affiliate changes their method afterward). Until then, this is
  // projected from commissions still accruing in this window against
  // each affiliate's CURRENT payout method — a preview, not a
  // guarantee, since that method can still change before the cycle is
  // actually run.
  const cycleHasBeenRun = (existingPayouts?.length ?? 0) > 0

  const byMethod: Record<PayoutMethodKey, number> = { usdt: 0, mpesa: 0, bank: 0, unset: 0 }
  let totalCommissionCost = 0

  if (cycleHasBeenRun) {
    for (const p of existingPayouts ?? []) {
      const amt = Number(p.amount_usd)
      totalCommissionCost += amt
      const key = (p.payout_method as PayoutMethodKey) ?? 'unset'
      byMethod[key] = (byMethod[key] ?? 0) + amt
    }
  } else {
    const { data: commissions } = await supabase
      .from('affiliate_commissions')
      .select('referrer_id, commission_amount_usd')
      .gte('created_at', start)
      .lt('created_at', end)
      .neq('status', 'void')

    const referrerIds = [...new Set((commissions ?? []).map(c => c.referrer_id))]
    const { data: referrerProfiles } = referrerIds.length > 0
      ? await supabase.from('profiles').select('id, payout_method').in('id', referrerIds)
      : { data: [] as { id: string; payout_method: string | null }[] }
    const methodByReferrer = new Map((referrerProfiles ?? []).map(p => [p.id, p.payout_method]))

    for (const c of commissions ?? []) {
      const amt = Number(c.commission_amount_usd)
      totalCommissionCost += amt
      const key = (methodByReferrer.get(c.referrer_id) as PayoutMethodKey | null) ?? 'unset'
      byMethod[key] = (byMethod[key] ?? 0) + amt
    }
  }

  const grossProfit = totalSales - geonodeCost - totalCommissionCost

  const cycleHref = (c: PayoutCycle) => `/admin/cycles?start=${c.cycleStart}`

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Sales cycles</h1>
        <p className="text-muted text-sm mt-1">
          Revenue, affiliate cost, and profit per biweekly cycle — same boundaries as affiliate payouts.
        </p>
      </div>

      <div className="flex items-center justify-between mb-6 bg-white border border-border rounded-xl px-6 py-4">
        <Link href={cycleHref(prev)} className="text-xs font-mono text-accent hover:underline whitespace-nowrap">
          ← Prev cycle
        </Link>
        <div className="text-center">
          <div className="font-display font-bold text-base text-ink">{formatCycleLabel(cycle)}</div>
          {isAccruingCycle && (
            <div className="text-[10px] font-mono text-yellow-600 uppercase tracking-widest mt-1">
              Still accruing — not yet payable
            </div>
          )}
        </div>
        {canGoNext ? (
          <Link href={cycleHref(next)} className="text-xs font-mono text-accent hover:underline whitespace-nowrap">
            Next cycle →
          </Link>
        ) : (
          <span className="text-xs font-mono text-muted opacity-40 whitespace-nowrap">Next cycle →</span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total sales', value: money(totalSales), sub: `${orderCount} paid order${orderCount === 1 ? '' : 's'}` },
          { label: 'Geonode cost', value: money(geonodeCost), sub: `${formatGb(totalGbSold)} GB × $${GEONODE_COST_PER_GB_USD}` },
          {
            label: 'Affiliate cost',
            value: money(totalCommissionCost),
            sub: cycleHasBeenRun ? 'Actual — cycle run' : 'Projected — not yet run',
          },
          { label: 'Gross profit', value: money(grossProfit), sub: 'Before processor fees & opex' },
        ].map(m => (
          <div key={m.label} className="bg-white border border-border rounded-xl p-5">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">{m.label}</div>
            <div className="font-display text-3xl font-bold text-ink">{m.value}</div>
            <div className="text-xs text-muted mt-1">{m.sub}</div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="font-display font-bold text-base text-ink">Affiliate payout needed by method</h2>
          <p className="text-xs text-muted mt-1">
            {cycleHasBeenRun
              ? 'What was actually batched for this cycle — the amount to have ready in each method.'
              : "Preview based on each affiliate's current payout method — can still change before the cycle is run."}
          </p>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Method', 'Amount'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['usdt', 'mpesa', 'bank', 'unset'] as const).map((key, i, arr) => (
              <tr key={key} className={i < arr.length - 1 ? 'border-b border-border' : ''}>
                <td className="px-6 py-3 text-sm text-ink">{methodLabel(key)}</td>
                <td className="px-6 py-3 font-mono text-sm text-accent">{money(byMethod[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Link href="/admin/affiliates" className="text-xs font-mono text-accent hover:underline">
        → Manage affiliates &amp; run this cycle&apos;s payout
      </Link>
    </div>
  )
}
