import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { applyDisputeLoss } from '@/lib/disputes'
import { placePaymentHold } from '@/lib/paymentHold'

// POST { orderId, outcome: 'lost' | 'won', reason, amountUsd? } — settle a
// chargeback by hand. 'lost' takes back the proportional bandwidth that is not
// already allocated to a session, issues a credit note and marks the order
// (lib/disputes.ts) — the same thing the webhook does automatically when Paystack
// reports a resolution the merchant accepted. 'won' just records it. amountUsd
// limits a 'lost' clawback to part of the order (e.g. a partial chargeback).
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ orderId?: unknown; outcome?: unknown; reason?: unknown; amountUsd?: unknown }>(req)
  if (!body || !isUuid(body.orderId)) return badRequest('Order ID missing or invalid')
  if (body.outcome !== 'lost' && body.outcome !== 'won') return badRequest("outcome must be 'lost' or 'won'")
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
  const reason = body.reason.trim().slice(0, 300)
  if (body.amountUsd != null && (typeof body.amountUsd !== 'number' || !Number.isFinite(body.amountUsd) || body.amountUsd <= 0)) {
    return badRequest('amountUsd must be a positive number')
  }

  const { data: order } = await supabase
    .from('orders')
    .select('id, user_id, amount_usd, refunded_usd, is_canary, bandwidth_credited, dispute_status')
    .eq('id', body.orderId)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  if (!order.dispute_status) return NextResponse.json({ error: 'This order has no dispute.' }, { status: 409 })
  if (order.dispute_status === 'won' && body.outcome === 'won') return NextResponse.json({ error: 'This dispute is already recorded as won.' }, { status: 409 })
  if (order.dispute_status === 'lost') return NextResponse.json({ error: 'This dispute is already recorded as lost.' }, { status: 409 })

  if (body.outcome === 'won') {
    // Conditional on the status we just read: a concurrent 'lost' (admin or
    // webhook) must never be overwritten by 'won'.
    const { data: updated, error } = await supabase.from('orders')
      .update({ dispute_status: 'won', dispute_resolution: reason })
      .eq('id', order.id)
      .eq('dispute_status', order.dispute_status)
      .select('id')
    if (error) return NextResponse.json({ error: 'Could not record the outcome. Please try again.' }, { status: 500 })
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'This dispute changed while you were working (it may have just been settled). Reload and check its current status.' }, { status: 409 })
    }
    await logAdminAction(supabase, { adminId, action: 'order.dispute_won', targetUserId: order.user_id, targetRef: order.id, details: { reason } })
    return NextResponse.json({ success: true, outcome: 'won' })
  }

  if (!order.bandwidth_credited) {
    // The bank took the money back but the order never credited any bandwidth, so there is
    // nothing to claw back. It used to refuse here, which left an open dispute that could
    // only be closed by recording a false "won" (and the account paused for good). Record
    // the loss, conditional on the status just read, and hold the account like any other loss.
    const { data: updated, error } = await supabase.from('orders')
      .update({ dispute_status: 'lost', dispute_resolution: reason })
      .eq('id', order.id).eq('dispute_status', order.dispute_status).select('id')
    if (error) return NextResponse.json({ error: 'Could not record the outcome. Please try again.' }, { status: 500 })
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'This dispute changed while you were working (it may have just been settled). Reload and check its current status.' }, { status: 409 })
    }
    if (!order.is_canary) await placePaymentHold(supabase, order.user_id, { reason: `Payment dispute lost (admin ${adminId})`, source: 'dispute_lost', orderId: order.id })
    await logAdminAction(supabase, { adminId, action: 'order.dispute_lost', targetUserId: order.user_id, targetRef: order.id, details: { reason, uncredited: true } })
    return NextResponse.json({ success: true, outcome: 'lost', refund_usd: 0, gb_clawed: 0, gb_not_recoverable: 0 })
  }
  try {
    const r = await applyDisputeLoss(supabase, order, { source: `admin ${adminId}`, resolution: reason, amountUsd: body.amountUsd as number | undefined })
    await logAdminAction(supabase, {
      adminId, action: 'order.dispute_lost', targetUserId: order.user_id, targetRef: order.id,
      details: { reason, refund_usd: r.refundUsd, gb_clawed: r.gbClawed, gb_not_recoverable: r.gbNotRecoverable, credit_note: r.creditNote },
    })
    return NextResponse.json({ success: true, outcome: 'lost', refund_usd: r.refundUsd, gb_clawed: r.gbClawed, gb_not_recoverable: r.gbNotRecoverable })
  } catch (e) {
    console.error('[dispute-outcome] could not apply the loss', order.id, e)
    return NextResponse.json({ error: 'Could not apply the dispute outcome. Nothing was partly applied — please try again.' }, { status: 500 })
  }
}
