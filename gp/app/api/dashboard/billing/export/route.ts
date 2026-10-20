import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { toCsv, csvResponse } from '@/lib/csv'
import { NextResponse } from 'next/server'

// Reuses lib/csv.ts (added alongside the usage-history CSV export) rather
// than building a second CSV encoder — same escaping, same \r\n line
// endings, same filename-plus-date convention. Auth matches that route
// too: createClient() reads the browser's session cookie, so a plain
// `<a href>` GET (see app/dashboard/billing/page.tsx) works without any
// client-side fetch/Blob handling.
//
// Every order regardless of status, not just paid ones — "billing
// history" is the full record. Pending/cancelled/failed rows are
// legitimate bookkeeping context too (e.g. reconciling why a charge never
// landed), so this deliberately doesn't filter payment_status the way the
// invoice page does.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Per-user throttle (lib/rateLimit.ts) — this route pages through the full order history on every call.
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'billing-export')
  if (throttled) return throttled

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  // Page through everything: PostgREST silently truncates a single response
  // (1000 rows by default), and a failed query must be an error, not a
  // header-only CSV that looks like "no billing history".
  const PAGE = 1000
  const orders: any[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('orders')
      .select('created_at, paid_at, invoice_number, gb_amount, amount_usd, refunded_usd, payment_status, paystack_reference, failure_reason, payment_method, pay_currency, pay_amount')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[billing-export] query failed', error)
      return NextResponse.json({ error: 'Could not export billing history. Please try again.' }, { status: 500 })
    }
    orders.push(...(data ?? []))
    if ((data?.length ?? 0) < PAGE) break
  }

  // `date` matches the invoice: the day it was paid, falling back to creation
  // for orders that never were (pending/cancelled/failed).
  const csv = toCsv(orders, [
    { header: 'date', value: o => new Date(o.paid_at ?? o.created_at).toISOString().slice(0, 10) },
    { header: 'invoice_number', value: o => o.invoice_number ?? '' },
    { header: 'description', value: o => `${o.gb_amount} GB residential proxy bandwidth` },
    { header: 'gb', value: o => o.gb_amount },
    { header: 'amount_usd', value: o => Number(o.amount_usd).toFixed(2) },
    { header: 'refunded_usd', value: o => Number(o.refunded_usd ?? 0).toFixed(2) },
    { header: 'net_usd', value: o => Math.max(Number(o.amount_usd) - Number(o.refunded_usd ?? 0), 0).toFixed(2) },
    { header: 'status', value: o => o.payment_status },
    { header: 'payment_method', value: o => o.payment_method ?? '' },
    { header: 'charged_currency', value: o => o.pay_currency ?? 'USD' },
    { header: 'charged_amount', value: o => o.pay_amount != null ? Number(o.pay_amount).toFixed(2) : Number(o.amount_usd).toFixed(2) },
    { header: 'failure_reason', value: o => o.failure_reason ?? '' },
    { header: 'payment_reference', value: o => o.paystack_reference ?? '' },
  ])

  return csvResponse(csv, 'globproxy-billing-history')
}
