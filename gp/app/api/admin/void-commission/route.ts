import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// POST { commissionId, reason } — undo ONE commission.
//   unpaid           → voided (and taken off its pending payout, which is deleted if it empties)
//   already paid out → a clawback is recorded; the next payout cycle nets it against the
//                      affiliate's new commissions (they are never asked to send money back)
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response
    const body = await readJson(req)
    if (!isUuid(body?.commissionId)) return badRequest('Commission ID missing')
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    if (reason.length < 3) return badRequest('A reason (at least 3 characters) is required')

    const { data, error } = await auth.supabase.rpc('admin_void_commission', { p_commission_id: body!.commissionId, p_reason: reason })
    if (error) {
      console.error('[admin/void-commission] rpc failed', error)
      return NextResponse.json({ error: 'Could not void this commission.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'That commission is already void.' }, { status: 409 })

    const d = data as { action: string; referrer_id: string; amount_usd: number }
    await logAdminAction(auth.supabase, {
      adminId: auth.adminId, action: 'commission_voided', targetUserId: d.referrer_id, targetRef: body!.commissionId,
      details: { reason, result: d.action, amount_usd: d.amount_usd },
    })
    return NextResponse.json({ success: true, action: d.action, amount_usd: d.amount_usd })
  } catch (err) {
    console.error('[admin/void-commission] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
