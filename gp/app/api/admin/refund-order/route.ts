import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { createRefund, RefundOutcomeUnknownError } from '@/lib/paystack'

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
    .select('id, user_id, amount_usd, refunded_usd, payment_status, payment_method, paystack_reference, is_canary, pay_currency, pay_amount, dispute_status')
    .eq('id', body.orderId)
    .single()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (order.is_canary) return NextResponse.json({ error: 'This is an automated test payment — refund it from the Paystack dashboard if needed.' }, { status: 409 })
  if (order.payment_status !== 'paid') return NextResponse.json({ error: `Only a paid order can be refunded (status: ${order.payment_status}).` }, { status: 409 })
  if (!order.paystack_reference) return NextResponse.json({ error: 'This order has no Paystack reference.' }, { status: 409 })

  // An open chargeback dispute: refunding on top of it can pay the customer twice
  // (the refund AND the dispute outcome). Settle the dispute first.
  if (order.dispute_status === 'open') {
    return NextResponse.json({ error: 'This order has an open payment dispute. Resolve the dispute before refunding, otherwise the customer can be paid twice.' }, { status: 409 })
  }

  const remaining = Math.round((Number(order.amount_usd) - Number(order.refunded_usd ?? 0)) * 100) / 100
  if (remaining <= 0) return NextResponse.json({ error: 'This order has already been fully refunded.' }, { status: 409 })
  const full = body.amountUsd == null
  const amount = full ? remaining : Math.round((body.amountUsd as number) * 100) / 100
  if (amount < 0.01 || amount > remaining) {
    return NextResponse.json({ error: `Refund must be between $0.01 and $${remaining.toFixed(2)} (what's left on this order).` }, { status: 400 })
  }

  // A refund takes minutes (sometimes days) to settle, during which the order
  // still looks refundable. claim_refund_request() takes a row lock and records
  // that a request is in flight, atomically — so a double click or two admins
  // cannot both send one. The mark is cleared when Paystack reports the refund
  // processed or failed (webhook) and expires on its own after 24h.
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_refund_request', { p_order_id: order.id })
  if (claimErr) {
    console.error('[refund-order] claim_refund_request failed', claimErr)
    return NextResponse.json({ error: 'Could not start the refund. Please try again.' }, { status: 500 })
  }
  if (!claimed) {
    return NextResponse.json({ error: 'A refund for this order is already in flight. It clears when Paystack reports it processed or failed (or after 24 hours).' }, { status: 409 })
  }
  const releaseClaim = async () => {
    const { error: relErr } = await supabase.from('orders').update({ refund_requested_at: null }).eq('id', order.id)
    if (relErr) console.error('[refund-order] could not release the refund lock', order.id, relErr)
  }

  const failBeforeSend = async (message: string) => {
    await releaseClaim()
    return NextResponse.json({ error: message }, { status: 409 })
  }

  try {
    // Paystack refunds in the currency the customer PAID in. An M-Pesa order
    // was charged in KES, so a partial USD amount is converted at the rate
    // locked onto the order (the webhook converts back the same way); a full
    // refund just omits the amount.
    const payCur = String(order.pay_currency ?? 'USD').toUpperCase()
    // The amount is omitted ONLY for a full refund of an order with nothing
    // refunded yet. Once part of an order has been refunded, "no amount" is
    // ambiguous (Paystack could read it as the whole original charge), so the
    // remaining amount is always sent explicitly.
    const untouched = Number(order.refunded_usd ?? 0) === 0
    let amountMajor: number | undefined
    if (!(full && untouched)) {
      if (payCur === 'USD' || order.pay_amount == null) {
        amountMajor = amount
      } else {
        amountMajor = Math.round(Number(order.pay_amount) * (amount / Number(order.amount_usd)))
        // Each earlier partial refund was rounded to whole shillings on its own, so the
        // proportional figure for the LAST bit can come out a shilling above what is
        // actually left of the charge and Paystack refuses it. When the shillings already
        // returned are all on record, never ask for more than what is left.
        const { data: prior, error: priorErr } = await supabase.from('order_refunds').select('charged_amount').eq('order_id', order.id)
        if (priorErr) throw priorErr
        if ((prior ?? []).length > 0 && (prior ?? []).every(r => r.charged_amount != null)) {
          const returned = (prior ?? []).reduce((s, r) => s + Number(r.charged_amount), 0)
          const leftMajor = Math.max(Math.floor(Number(order.pay_amount) - returned), 0)
          if (leftMajor < 1) return await failBeforeSend('The whole KES amount of this order has already been returned.')
          amountMajor = full ? leftMajor : Math.min(amountMajor, leftMajor)
        }
      }
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
    if (err instanceof RefundOutcomeUnknownError) {
      // We cannot tell whether Paystack started the refund. Keep the in-flight
      // claim (it clears on the refund.processed/failed webhook or after 24h) so a
      // retry cannot pay the customer twice, and make the admin check Paystack.
      await logAdminAction(supabase, {
        adminId, action: 'order.refund_unconfirmed', targetUserId: order.user_id, targetRef: order.id,
        details: { amount_usd: amount, reason, error: String(err.message) },
      })
      return NextResponse.json({
        error: 'Paystack did not confirm the refund, so it may still have started. The order is locked against a second request — check the Paystack dashboard; the lock clears automatically when Paystack reports the refund processed or failed, or after 24 hours.',
      }, { status: 502 })
    }
    // Paystack refused the request outright: nothing is in flight, so allow a retry.
    await releaseClaim()
    await logAdminAction(supabase, {
      adminId, action: 'order.refund_failed', targetUserId: order.user_id, targetRef: order.id,
      details: { amount_usd: amount, reason, error: String(err?.message ?? err) },
    })
    return NextResponse.json({ error: err?.message ?? 'The refund request failed.' }, { status: 502 })
  }
}
