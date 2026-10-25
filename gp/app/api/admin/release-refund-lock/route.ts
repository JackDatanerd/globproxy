import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// POST { orderId, reason } — clears an order's refund lock (orders.refund_requested_at).
//
// A refund request locks its order against a second one until Paystack reports it processed
// or failed (or 24 h pass). When the outcome was never confirmed — a timeout, a webhook that
// never arrived — the lock sat there with no way to see or clear it. Only release it after
// checking the Paystack dashboard: if the refund DID go through and the lock is released,
// a second refund request can pay the customer twice. The audit row records who decided.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ orderId?: unknown; reason?: unknown }>(req)
  if (!body || !isUuid(body.orderId)) return badRequest('Order ID missing or invalid')
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
  const reason = body.reason.trim().slice(0, 300)

  const { data: released, error } = await supabase.from('orders')
    .update({ refund_requested_at: null })
    .eq('id', body.orderId).not('refund_requested_at', 'is', null)
    .select('id, user_id, refund_requested_at')
  if (error) {
    console.error('[release-refund-lock] failed', error)
    return NextResponse.json({ error: 'Could not release the refund lock. Please try again.' }, { status: 500 })
  }
  if (!released?.length) return NextResponse.json({ error: 'This order has no refund in flight (it may have just been confirmed).' }, { status: 409 })

  await logAdminAction(supabase, {
    adminId, action: 'order.refund_lock_released', targetUserId: released[0].user_id, targetRef: body.orderId,
    details: { reason },
  })
  return NextResponse.json({ success: true })
}
