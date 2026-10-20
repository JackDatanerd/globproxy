import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

// Full commission / payout history as CSV. The referrals page only lists the
// latest rows; affiliates need the whole record for their own bookkeeping.
// Same shape as /api/dashboard/billing/export: createClient() reads the
// session cookie (so a plain <a href> works) and RLS limits every row to the
// caller's own (`referrer_id = auth.uid()`).
const PAGE = 1000
const MAX_ROWS = 50_000

async function fetchAll(supabase: Awaited<ReturnType<typeof createClient>>, table: string, cols: string, userId: string) {
  const rows: any[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from(table).select(cols)
      .eq('referrer_id', userId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < PAGE) break
  }
  return rows
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Per-user throttle (lib/rateLimit.ts) — this route pages through up to 50k rows on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'referrals-export')
  if (throttled) return throttled

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const dataset = new URL(req.url).searchParams.get('dataset') === 'payouts' ? 'payouts' : 'commissions'

  try {
    if (dataset === 'payouts') {
      const rows = await fetchAll(supabase, 'affiliate_payouts', 'id, created_at, cycle_start, cycle_end, amount_usd, status, payout_method, paid_at, payment_reference', user.id)
      return csvResponse(toCsv(rows, [
        { header: 'Created', value: r => r.created_at },
        { header: 'Cycle start', value: r => r.cycle_start },
        { header: 'Cycle end', value: r => r.cycle_end },
        { header: 'Amount (USD)', value: r => Number(r.amount_usd).toFixed(2) },
        { header: 'Status', value: r => r.status },
        { header: 'Method', value: r => r.payout_method },
        { header: 'Paid at', value: r => r.paid_at },
        { header: 'Reference', value: r => r.payment_reference },
      ]), 'globproxy-payouts')
    }
    const rows = await fetchAll(supabase, 'affiliate_commissions', 'id, created_at, gross_amount_usd, commission_rate, commission_amount_usd, status, payout_id', user.id)
    return csvResponse(toCsv(rows, [
      { header: 'Date', value: r => r.created_at },
      { header: 'Order amount (USD)', value: r => Number(r.gross_amount_usd).toFixed(2) },
      { header: 'Rate', value: r => r.commission_rate },
      { header: 'Commission (USD)', value: r => Number(r.commission_amount_usd).toFixed(2) },
      { header: 'State', value: r => (r.status === 'void' ? 'reversed' : r.status === 'paid' ? 'paid' : r.payout_id ? 'scheduled' : 'payable') },
    ]), 'globproxy-commissions')
  } catch (e) {
    console.error('[referrals-export] query failed', e)
    return NextResponse.json({ error: 'Could not export. Please try again.' }, { status: 500 })
  }
}
