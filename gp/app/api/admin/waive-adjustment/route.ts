import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { notifyClawbackWaived } from '@/lib/affiliateNotify'

// POST { adjustmentId, reason } — forgive a clawback that hasn't been netted
// into a payout yet (goodwill, or it was applied by mistake).
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response
    const body = await readJson(req)
    if (!isUuid(body?.adjustmentId)) return badRequest('Adjustment ID missing')
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    if (reason.length < 3) return badRequest('A reason (at least 3 characters) is required')

    const { data, error } = await auth.supabase.rpc('admin_waive_adjustment', { p_adjustment_id: body!.adjustmentId, p_admin_id: auth.adminId })
    if (error) {
      console.error('[admin/waive-adjustment] rpc failed', error)
      return NextResponse.json({ error: 'Could not waive this deduction.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'That deduction was already applied to a payout or waived.' }, { status: 409 })

    const d = data as { referrer_id: string; amount_usd: number }
    await logAdminAction(auth.supabase, {
      adminId: auth.adminId, action: 'clawback_waived', targetUserId: d.referrer_id, targetRef: body!.adjustmentId,
      details: { reason, amount_usd: d.amount_usd },
    })
    await notifyClawbackWaived(auth.supabase, d.referrer_id, Number(d.amount_usd)).catch(() => {})
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[admin/waive-adjustment] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
