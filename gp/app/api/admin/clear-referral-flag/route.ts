import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD, announceClearedReferral } from '@/lib/referrals'

// A flagged referral (second signup from the same IP on one referrer's code)
// earns nothing — no GB bonus, no commission — until an admin has looked at
// it. Clearing the flag back-fills what was held back (the referred user's
// already-credited orders: commissions at the rate that applied when each was
// paid, or the one-time GB bonus) and lets future orders earn normally.
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const body = await readJson(req)
    if (!isUuid(body?.referralId)) return badRequest('Referral ID missing')
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    if (reason.length < 3) return badRequest('A reason (at least 3 characters) is required')

    const { data: result, error } = await auth.supabase.rpc('clear_referral_flag', {
      p_referral_id: body!.referralId,
      p_gb: REFERRAL_GB_BONUS,
      p_min_order_usd: REFERRAL_MIN_ORDER_USD,
    })
    if (error) {
      console.error('[admin/clear-referral-flag] rpc failed', error)
      return NextResponse.json({ error: 'Could not clear the flag.' }, { status: 500 })
    }
    if (!result) return NextResponse.json({ error: 'That referral is not flagged.' }, { status: 409 })

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'referral_flag_cleared', targetRef: body!.referralId, details: { reason, ...(result as Record<string, unknown>) } })
    // What the clearing paid out back-dated is announced like a normal conversion.
    await announceClearedReferral(auth.supabase as any, body!.referralId, result as { bonus_credited?: boolean; commissions_backfilled?: number })
    return NextResponse.json({ success: true, backfill: result })
  } catch (err: any) {
    console.error('[admin/clear-referral-flag] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
