import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { verifyTransaction, paymentMismatchReason } from '@/lib/paystack'
import { activateBandwidth } from '@/lib/bandwidth'

// POST { orderId, override?: boolean, reason?: string } — re-verify an uncredited
// order directly with Paystack and credit it if the money really arrived.
//
// Several payment alerts end in "handle manually" (a payment that did not match
// its order, a credit that kept failing, an unknown order) with nothing to
// handle it WITH: adjust-bandwidth is not tied to an order, so it leaves no
// invoice, no 'paid' order and no referral processing. This runs the same path
// the webhook, verify-payment and reconcile use (activateBandwidth), so the
// invoice number, bandwidth, confirmation e-mail and referral steps all happen.
//
// A mismatch (wrong amount / currency / reference) is reported, not credited,
// unless the admin sends override=true with a reason — a deliberate, audit-logged
// decision to credit the order as it was placed (e.g. a customer who paid a few
// shillings less because their bank rounded the M-Pesa amount).
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ orderId?: unknown; override?: unknown; reason?: unknown }>(req)
  if (!body || !isUuid(body.orderId)) return badRequest('Order ID missing or invalid')
  const override = body.override === true
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
  if (override && reason.length < 3) return badRequest('A reason (at least 3 characters) is required to credit a mismatched payment')

  const { data: order } = await supabase
    .from('orders')
    .select('id, user_id, payment_status, amount_usd, gb_amount, paystack_reference, bandwidth_credited, is_canary, pay_currency, pay_amount')
    .eq('id', body.orderId)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (order.is_canary) return NextResponse.json({ error: 'This is an automated test payment.' }, { status: 409 })
  if (order.bandwidth_credited || order.payment_status === 'paid') return NextResponse.json({ error: 'This order is already credited.' }, { status: 409 })
  if (order.payment_status === 'refunded') return NextResponse.json({ error: 'This order has been refunded and cannot be credited.' }, { status: 409 })
  if (!order.paystack_reference) return NextResponse.json({ error: 'This order has no Paystack reference.' }, { status: 409 })

  let txn
  try {
    txn = await verifyTransaction(order.paystack_reference)
  } catch (e: any) {
    return NextResponse.json({ error: `Could not read the transaction from Paystack: ${e?.message ?? 'unknown error'}` }, { status: 502 })
  }
  if (txn.status !== 'success') {
    return NextResponse.json({ error: `Paystack reports this transaction as "${txn.status}" — nothing was paid, so nothing is credited.`, paystack_status: txn.status }, { status: 409 })
  }

  const mismatch = paymentMismatchReason(txn, order)
  if (mismatch && !override) {
    return NextResponse.json({
      error: `The payment does not match the order: ${mismatch}. Credit it anyway only if you are sure — send override with a reason.`,
      mismatch, can_override: true,
    }, { status: 409 })
  }

  const result = await activateBandwidth({
    order_id: order.id, user_id: order.user_id, gb_amount: Number(order.gb_amount),
    paystack_reference: order.paystack_reference, amount_usd: Number(order.amount_usd), is_canary: false,
  })
  if (result.status === 'error') {
    return NextResponse.json({ error: `The credit did not commit (${result.error}). Nothing was changed — try again.` }, { status: 500 })
  }

  await logAdminAction(supabase, {
    adminId, action: mismatch ? 'order.credit_override' : 'order.verified_and_credited', targetUserId: order.user_id, targetRef: order.id,
    details: { status: result.status, ...(mismatch ? { mismatch, reason } : {}) },
  })
  return NextResponse.json({ success: true, status: result.status })
}
