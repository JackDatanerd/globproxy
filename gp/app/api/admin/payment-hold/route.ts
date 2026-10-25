import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { placePaymentHold, clearPaymentHold } from '@/lib/paymentHold'

// POST { userId, action: 'clear' | 'place', reason } — an account that lost a chargeback is
// put on payment hold automatically (lib/disputes.ts) and cannot buy until an admin reviews
// it and clears the hold here. 'place' lets staff hold an account by hand (suspected card
// fraud, a chargeback pattern across accounts). Both are audit-logged with the reason.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: unknown; action?: unknown; reason?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')
  if (body.action !== 'clear' && body.action !== 'place') return badRequest("action must be 'clear' or 'place'")
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3) return badRequest('A reason (at least 3 characters) is required')
  const reason = body.reason.trim().slice(0, 300)

  try {
    // The account must exist, be a live customer-type account, and not be an admin. The
    // foreign-key failure for a bad id used to surface as "already on payment hold".
    const { data: target, error: tErr } = await supabase.from('profiles').select('role, is_deleted').eq('id', body.userId).maybeSingle()
    if (tErr) throw tErr
    if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    if (body.action === 'place' && target.role === 'admin') return NextResponse.json({ error: 'An admin account cannot be put on payment hold.' }, { status: 403 })
    if (body.action === 'place' && target.is_deleted) return NextResponse.json({ error: 'This account has been deleted.' }, { status: 409 })
    if (body.action === 'place') {
      const placed = await placePaymentHold(supabase, body.userId, { reason, source: 'admin', createdBy: adminId })
      if (!placed) return NextResponse.json({ error: 'This account is already on payment hold.' }, { status: 409 })
      await logAdminAction(supabase, { adminId, action: 'user.payment_hold_placed', targetUserId: body.userId, targetRef: body.userId, details: { reason } })
      return NextResponse.json({ success: true, hold: true })
    }
    const cleared = await clearPaymentHold(supabase, body.userId)
    if (!cleared) return NextResponse.json({ error: 'This account is not on payment hold.' }, { status: 409 })
    await logAdminAction(supabase, { adminId, action: 'user.payment_hold_cleared', targetUserId: body.userId, targetRef: body.userId, details: { reason } })
    return NextResponse.json({ success: true, hold: false })
  } catch (e) {
    console.error('[payment-hold] failed', e)
    return NextResponse.json({ error: 'Could not update the payment hold. Please try again.' }, { status: 500 })
  }
}
