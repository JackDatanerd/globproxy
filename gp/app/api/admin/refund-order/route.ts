import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { createRefund } from '@/lib/paystack'

// POST { orderId, amountUsd?, reason } — starts a refund with Paystack.
// Nothing local changes here: Paystack answers "pending", and the
// refund.processed webhook does the rest (takes the proportional bandwidth
// back, issues the credit note, reduces the affiliate commission, emails the
// customer) — the same path a refund started in the Paystack dashboard takes.
// Omit amountUsd for the full remaining amount.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ orderId?: unknown; amountUsd?: unknown; reason?: unknown }>(req)
  if (!body || !isUuid(body.orderId)) return badRequest('Order ID missing or invalid')
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
  const reason = body.reason.trim().slice(0, 300)
  if (body.amountUsd != null && (typeof body.amountUsd !== 'number' || !Number.isFinite(body.amountUsd) || body.amountUsd <= 0)) {
    return badRequest('amountUsd must be a positive number')
  }

  const { data: order } = await supabase
    .from('orders')
    .select('id, user_id, amount_usd, refunded_usd, payment_status, payment_method, paystack_reference, is_canary, pay_currency, pay_amount')
    .eq('id', body.orderId)
    .single()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (order.is_canary) return NextResponse.json({ error: 'This is an automated test payment — refund it from the Paystack dashboard if needed.' }, { status: 409 })
  if (order.payment_status !== 'paid') return NextResponse.json({ error: `Only a paid order can be refunded (status: ${order.payment_status}).` }, { status: 409 })
  if (!order.paystack_reference) return NextResponse.json({ error: 'This order has no Paystack reference.' }, { status: 409 })

  const remaining = Math.round((Number(order.amount_usd) - Number(order.refunded_usd ?? 0)) * 100) / 100
  if (remaining <= 0) return NextResponse.json({ error: 'This order has already been fully refunded.' }, { status: 409 })
  const full = body.amountUsd == null
  const amount = full ? remaining : Math.round((body.amountUsd as number) * 100) / 100
  if (amount < 0.01 || amount > remaining) {
    return NextResponse.json({ error: `Refund must be between $0.01 and $${remaining.toFixed(2)} (what's left on this order).` }, { status: 400 })
  }

  // A refund takes minutes to settle, during which the order still looks
  // refundable. Without this, a double click sends two refunds to Paystack.
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { count: recent } = await supabase
    .from('admin_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'order.refund_requested')
    .eq('target_ref', order.id)
    .gte('created_at', since)
  if ((recent ?? 0) > 0) {
    return NextResponse.json({ error: 'A refund for this order was requested in the last 10 minutes and is still settling. Wait for it before sending another.' }, { status: 409 })
  }

  try {
    // Paystack refunds in the currency the customer PAID in. An M-Pesa order
    // was charged in KES, so a partial USD amount is converted at the rate
    // locked onto the order (the webhook converts back the same way); a full
    // refund just omits the amount.
    const payCur = String(order.pay_currency ?? 'USD').toUpperCase()
    let amountMajor: number | undefined
    if (!full) {
      amountMajor = payCur === 'USD' || order.pay_amount == null
        ? amount
        : Math.round(Number(order.pay_amount) * (amount / Number(order.amount_usd)))
    }
    const result = await createRefund({
      reference: order.paystack_reference,
      amount_major: amountMajor,
      currency: payCur,
      merchant_note: reason,
    })
    await logAdminAction(supabase, {
      adminId, action: 'order.refund_requested', targetUserId: order.user_id, targetRef: order.id,
      details: { amount_usd: amount, ...(amountMajor != null ? { amount_charged_currency: amountMajor, currency: payCur } : {}), reason, paystack_status: result?.status ?? 'unknown' },
    })
    return NextResponse.json({ success: true, amount_usd: amount, status: result?.status ?? 'pending' })
  } catch (err: any) {
    await logAdminAction(supabase, {
      adminId, action: 'order.refund_failed', targetUserId: order.user_id, targetRef: order.id,
      details: { amount_usd: amount, reason, error: String(err?.message ?? err) },
    })
    return NextResponse.json({ error: err?.message ?? 'The refund request failed.' }, { status: 502 })
  }
}
