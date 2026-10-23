import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// POST { referralId, reason } — fraud found AFTER money accrued. Flags and
// confirms the referral (it can never earn again) and voids everything it
// earned: unpaid commissions are removed, paid ones become clawbacks netted
// against the affiliate's future payouts. A standard GB bonus the referral earned
// is taken back too (what is still unspent, from both accounts).
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response
    const body = await readJson(req)
    if (!isUuid(body?.referralId)) return badRequest('Referral ID missing')
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    if (reason.length < 3) return badRequest('A reason (at least 3 characters) is required')

    const { data, error } = await auth.supabase.rpc('admin_void_referral_earnings', { p_referral_id: body!.referralId, p_reason: reason })
    if (error) {
      console.error('[admin/void-referral-earnings] rpc failed', error)
      return NextResponse.json({ error: 'Could not void this referral\'s earnings.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Referral not found.' }, { status: 404 })

    const d = data as { referrer_id: string; voided: number; clawbacks: number; amount_usd: number; bonus_clawed_referrer_gb?: number; bonus_clawed_referred_gb?: number }
    await logAdminAction(auth.supabase, {
      adminId: auth.adminId, action: 'referral_earnings_voided', targetUserId: d.referrer_id, targetRef: body!.referralId,
      details: { reason, voided: d.voided, clawbacks: d.clawbacks, amount_usd: d.amount_usd, bonus_clawed_referrer_gb: d.bonus_clawed_referrer_gb ?? 0, bonus_clawed_referred_gb: d.bonus_clawed_referred_gb ?? 0 },
    })
    return NextResponse.json({ success: true, voided: d.voided, clawbacks: d.clawbacks, amount_usd: d.amount_usd, bonus_clawed_referrer_gb: d.bonus_clawed_referrer_gb ?? 0, bonus_clawed_referred_gb: d.bonus_clawed_referred_gb ?? 0 })
  } catch (err) {
    console.error('[admin/void-referral-earnings] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
