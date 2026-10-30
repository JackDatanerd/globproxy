import { anyLeaksSupplier, SUPPLIER_TEXT_ERROR } from '@/lib/supplierGuard'
import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendRefundDeclinedEmail } from '@/lib/billingEmails'

// POST { requestId, note? } — decline a customer's refund request (Billing →
// "Request refund"). Approving one is the existing Refund button on Admin →
// Orders: when Paystack reports the refund processed, apply_order_refund closes
// the request itself. The customer is e-mailed the decision, with the note.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ requestId?: unknown; note?: unknown }>(req)
  if (!body || !isUuid(body.requestId)) return badRequest('Request ID missing or invalid')
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''
  if (anyLeaksSupplier(note)) return badRequest(SUPPLIER_TEXT_ERROR)

  // Conditional on still being open: two admins, or a decline racing the refund.
  const { data: rows, error } = await supabase.from('refund_requests')
    .update({ status: 'declined', decline_note: note || null, resolved_at: new Date().toISOString() })
    .eq('id', body.requestId).eq('status', 'open')
    .select('id, user_id, order_id')
  if (error) {
    console.error('[refund-request] decline failed', error)
    return NextResponse.json({ error: 'Could not decline the request. Please try again.' }, { status: 500 })
  }
  const row = rows?.[0]
  if (!row) return NextResponse.json({ error: 'This request is no longer open.' }, { status: 409 })

  const { data: order } = await supabase.from('orders').select('amount_usd, gb_amount').eq('id', row.order_id).maybeSingle()
  await sendRefundDeclinedEmail(supabase, row.user_id, {
    amountUsd: Number(order?.amount_usd ?? 0), gb: Number(order?.gb_amount ?? 0), note: note || null,
  })
  await logAdminAction(supabase, { adminId, action: 'order.refund_request_declined', targetUserId: row.user_id, targetRef: row.order_id, details: { note } })
  return NextResponse.json({ success: true })
}
