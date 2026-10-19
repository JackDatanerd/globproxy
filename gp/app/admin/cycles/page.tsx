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
import { isIsoDate } from '@/lib/adminAuth'
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

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < 50000; from += 1000) {
    const { data } = await page(from, from + 999)
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
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
  // isIsoDate is a real calendar check: the old regex alone let 2026-13-01
  // through, which produced an invalid Date and crashed the page with a 500.
  if (sp.start && isIsoDate(sp.start) && /-(01|16)$/.test(sp.start)) {
    cycle = cycleFromStart(sp.start)
  }

  const accruing = currentAccruingCycle()
  const isAccruingCycle = cycle.cycleStart === accruing.cycleStart
  const prev = cycleBefore(cycle)
  const next = cycleAfter(cycle)
  const canGoNext = next.cycleStart <= accruing.cycleStart // never navigate past the still-accruing cycle

  const { start, end } = cycleWindow(cycle)

  // Sales come from admin_order_stats() (migration 0043): server-side,
  // net of refunds, canary excluded — the same numbers as the Overview and
  // Orders pages. This page used to sum gross order amounts (ignoring
  // partial refunds) from a query PostgREST caps at 1000 rows.
  const [statsRes, { data: existingPayouts }, commissions] = await Promise.all([
    supabase.rpc('admin_order_stats', { p_start: start, p_end: end }),
    supabase
      .from('affiliate_payouts')
      .select('amount_usd, payout_method')
      .eq('cycle_start', cycle.cycleStart)
      .eq('cycle_end', cycle.cycleEnd),
    // Every non-void commission earned on this window's sales, paged in
    // 1000-row chunks so a busy cycle isn't silently truncated.
    fetchAll<{ referrer_id: string; commission_amount_usd: number; status: string; payout_id: string | null }>((from, to) =>
      supabase
        .from('affiliate_commissions')
        .select('referrer_id, commission_amount_usd, status, payout_id')
        .gte('created_at', start)
        .lt('created_at', end)
        .neq('status', 'void')
        .order('created_at', { ascending: true })
        .range(from, to)
    ),
  ])

  const stats = (statsRes.data?.[0] ?? null) as { revenue_usd: number; gb_sold: number; order_count: number } | null
  const totalSales = Number(stats?.revenue_usd ?? 0)
  const totalGbSold = Number(stats?.gb_sold ?? 0)
  const orderCount = Number(stats?.order_count ?? 0)
  const geonodeCost = totalGbSold * GEONODE_COST_PER_GB_USD

  // Affiliate cost = EVERY non-void commission earned on this window's
  // sales. It used to be only the payouts batched for the cycle once any
  // existed — so balances held back (no payout method, security hold, below
  // minimum) vanished from the liability and profit looked too high.
  const totalCommissionCost = commissions.reduce((sum, c) => sum + Number(c.commission_amount_usd), 0)
  const batchedCost = commissions.filter(c => c.payout_id).reduce((sum, c) => sum + Number(c.commission_amount_usd), 0)
  const unbatchedPending = commissions.filter(c => !c.payout_id && c.status === 'pending')
  const unbatchedCost = unbatchedPending.reduce((sum, c) => sum + Number(c.commission_amount_usd), 0)
  const cycleHasBeenRun = (existingPayouts?.length ?? 0) > 0

  // "Payout needed by method" = what's actually been batched for this cycle
  // (method snapshotted at run time — migration 0034) PLUS a projection of
  // the not-yet-batched remainder against each affiliate's CURRENT method.
  const byMethod: Record<PayoutMethodKey, number> = { usdt: 0, mpesa: 0, bank: 0, unset: 0 }
  for (const p of existingPayouts ?? []) {
    const key = (p.payout_method as PayoutMethodKey) ?? 'unset'
    byMethod[key] = (byMethod[key] ?? 0) + Number(p.amount_usd)
  }
  if (unbatchedPending.length > 0) {
    const referrerIds = [...new Set(unbatchedPending.map(c => c.referrer_id))]
    const methodByReferrer = new Map<string, string | null>()
    for (let i = 0; i < referrerIds.length; i += 100) {
      const { data: referrerProfiles } = await supabase.from('profiles').select('id, payout_method').in('id', referrerIds.slice(i, i + 100))
      for (const p of referrerProfiles ?? []) methodByReferrer.set(p.id, p.payout_method)
    }
    for (const c of unbatchedPending) {
      const key = (methodByReferrer.get(c.referrer_id) as PayoutMethodKey | null) ?? 'unset'
      byMethod[key] = (byMethod[key] ?? 0) + Number(c.commission_amount_usd)
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
          { label: 'Total sales', value: money(totalSales), sub: `${orderCount} paid order${orderCount === 1 ? '' : 's'} · net of refunds` },
          { label: 'Geonode cost', value: money(geonodeCost), sub: `${formatGb(totalGbSold)} GB × $${GEONODE_COST_PER_GB_USD}` },
          {
            label: 'Affiliate cost',
            value: money(totalCommissionCost),
            sub: `${money(batchedCost)} batched · ${money(unbatchedCost)} not yet batched${cycleHasBeenRun ? '' : ' (cycle not run)'}`,
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
              ? "Payouts batched for this cycle, plus a preview of anything not yet batched (against each affiliate's current method). Earlier balances carried over into this cycle's run are included in the payout amounts."
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
