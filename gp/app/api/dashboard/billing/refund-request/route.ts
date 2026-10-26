import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { isUuid } from '@/lib/adminAuth'
import { alertAdminPayment } from '@/lib/paymentAlerts'
import { sendRefundRequestReceivedEmail } from '@/lib/billingEmails'
import { NextResponse } from 'next/server'

// POST { order_id, reason } — a customer asks for a refund from Billing. The
// refund policy (/refunds) used to be "e-mail support with your order id and
// confirm nothing was used": the admin then had to look up the order and check
// usage by hand. This records the request against the order, works out whether
// it falls inside the policy (paid within 72 hours, nothing used on the account),
// tells the admin, and confirms to the customer. An admin still decides: the
// request shows on Admin → Orders, where it is refunded with the normal Refund
// button (which closes it) or declined (the customer is e-mailed).
const POLICY_WINDOW_MS = 72 * 60 * 60 * 1000
const MAX_DECLINED_PER_ORDER = 2

export async function POST(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'refund-request')
  if (throttled) return throttled
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request' }, { status: 400 }) }
  if (!isUuid(body?.order_id)) return NextResponse.json({ error: 'Invalid order' }, { status: 400 })
  const reason = typeof body?.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : ''
  if (reason.length < 3) return NextResponse.json({ error: 'Please tell us briefly why you are asking for a refund.' }, { status: 400 })
  if (reason.length > 500) return NextResponse.json({ error: 'Please keep the reason under 500 characters.' }, { status: 400 })

  const admin = await createAdminClient()
  const { data: order, error: orderErr } = await admin
    .from('orders')
    .select('id, user_id, payment_status, amount_usd, refunded_usd, gb_amount, invoice_number, paid_at, is_canary, dispute_status')
    .eq('id', body.order_id).eq('user_id', user.id).maybeSingle()
  if (orderErr) {
    console.error('[refund-request] order lookup failed', orderErr)
    return NextResponse.json({ error: 'Could not look up the order. Please try again.' }, { status: 500 })
  }
  if (!order || order.is_canary) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (order.payment_status !== 'paid') {
    return NextResponse.json({ error: 'Only a paid order can be refunded.' }, { status: 409 })
  }
  const remaining = Number(order.amount_usd) - Number(order.refunded_usd ?? 0)
  if (remaining <= 0.005) return NextResponse.json({ error: 'This order has already been fully refunded.' }, { status: 409 })
  if (order.dispute_status === 'open') {
    return NextResponse.json({ error: 'This order has an open payment dispute. Please contact support@globproxy.com.' }, { status: 409 })
  }

  const { data: existing, error: exErr } = await admin
    .from('refund_requests').select('status').eq('order_id', order.id)
  if (exErr) {
    console.error('[refund-request] lookup failed', exErr)
    return NextResponse.json({ error: 'Could not record your request. Please try again.' }, { status: 500 })
  }
  if ((existing ?? []).some(r => r.status === 'open')) {
    return NextResponse.json({ error: 'You already have a refund request open for this order. We reply within 2 business days.' }, { status: 409 })
  }
  if ((existing ?? []).filter(r => r.status === 'declined').length >= MAX_DECLINED_PER_ORDER) {
    return NextResponse.json({ error: 'We have already reviewed this order twice. Please contact support@globproxy.com.' }, { status: 409 })
  }

  // Inside the policy: within 72 hours of payment AND nothing used on the account
  // (usage is synced from the proxy network, so this is the account's own figure).
  // "Nothing used" means nothing used SINCE this purchase: the account-wide used_gb is lifetime,
  // so a customer who spent an earlier pack could never again have a within-policy order. The
  // local daily usage (usage_daily, UTC buckets) is summed from the purchase day on — a day
  // bucket is coarse, so usage earlier on the same day counts against the customer (the safe side).
  const paidAt = order.paid_at ? Date.parse(order.paid_at) : NaN
  let used = 0
  if (Number.isFinite(paidAt)) {
    const sinceDay = new Date(paidAt).toISOString().slice(0, 10)
    const { data: days, error: uErr } = await admin.from('usage_daily').select('gb').eq('user_id', user.id).gte('day', sinceDay)
    if (uErr) {
      console.error('[refund-request] usage lookup failed', uErr)
      // Fall back to the lifetime figure rather than guessing "nothing used".
      const { data: acct } = await admin.from('bandwidth_accounts').select('used_gb').eq('user_id', user.id).maybeSingle()
      used = Number(acct?.used_gb ?? 0)
    } else {
      used = (days ?? []).reduce((s, r) => s + Number(r.gb ?? 0), 0)
    }
  }
  const withinPolicy = Number.isFinite(paidAt) && Date.now() - paidAt <= POLICY_WINDOW_MS && used <= 0

  const { data: created, error: insErr } = await admin.from('refund_requests')
    .insert({ order_id: order.id, user_id: user.id, reason, within_policy: withinPolicy })
    .select('id').single()
  if (insErr || !created) {
    // The partial unique index: a double click raced another request.
    if ((insErr as any)?.code === '23505') {
      return NextResponse.json({ error: 'You already have a refund request open for this order.' }, { status: 409 })
    }
    console.error('[refund-request] insert failed', insErr)
    return NextResponse.json({ error: 'Could not record your request. Please try again.' }, { status: 500 })
  }

  await alertAdminPayment('Customer refund request', {
    order_id: order.id, customer: user.email ?? user.id, invoice: order.invoice_number ?? '',
    amount_usd: Number(order.amount_usd), gb: Number(order.gb_amount),
    within_policy: withinPolicy ? 'yes — paid within 72h, nothing used' : `no — ${used > 0 ? `${used.toFixed(2)} GB used since purchase` : 'older than 72h'}`,
    reason,
    note: 'Approve it with the Refund button on Admin → Orders (the request closes itself), or decline it there.',
  })
  await sendRefundRequestReceivedEmail(admin, user.id, {
    amountUsd: Number(order.amount_usd), gb: Number(order.gb_amount), invoiceNumber: order.invoice_number ?? null, withinPolicy,
  })
  return NextResponse.json({ ok: true, within_policy: withinPolicy })
}
