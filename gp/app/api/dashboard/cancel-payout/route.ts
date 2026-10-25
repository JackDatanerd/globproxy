import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireStepUp } from '@/lib/reauth'
import { requireActiveUser, rejectCrossSite } from '@/lib/apiAuth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { isUuid } from '@/lib/adminAuth'
import { logSecurityEvent } from '@/lib/securityEvents'
import { notifyPayoutVoided } from '@/lib/affiliateNotify'

// An affiliate cancels their OWN still-pending payout — the way out when the destination
// it was created with turns out to be wrong (a valid but mistyped address, an old phone
// number) and nothing has been sent yet. The commissions go back to their balance and are
// picked up by the next payout run with whatever method is on file then (a changed method
// is under the usual 48-hour hold). A payout already marked paid is a real-money
// correction and stays with support.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'cancel-payout')
    if (limited) return limited
    const perUser = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'cancel-payout')
    if (perUser) return perUser
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const mfaGate = await requireStepUp(req, user.id)
    if (mfaGate) return mfaGate

    let body: any
    try { body = await req.json() } catch { body = null }
    if (!isUuid(body?.payoutId)) return NextResponse.json({ error: 'Payout ID missing or invalid.' }, { status: 400 })

    const admin = await createAdminClient()
    const { data: own } = await admin.from('affiliate_payouts')
      .select('id, status').eq('id', body.payoutId).eq('referrer_id', user.id).maybeSingle()
    if (!own) return NextResponse.json({ error: 'Payout not found.' }, { status: 404 })
    if (own.status !== 'pending') return NextResponse.json({ error: 'Only a payout that has not been sent yet can be cancelled.' }, { status: 409 })

    const { data, error } = await admin.rpc('void_affiliate_payout', { p_payout_id: own.id })
    if (error) {
      console.error('[dashboard/cancel-payout] rpc failed', error)
      return NextResponse.json({ error: 'Could not cancel this payout.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Only a payout that has not been sent yet can be cancelled.' }, { status: 409 })
    const d = data as any

    await logSecurityEvent({ admin, userId: user.id, event: 'payout_method_changed', req, meta: { action: 'payout_cancelled_by_owner', payout_id: own.id, amount_usd: Number(d.amount_usd) } })
    await notifyPayoutVoided(admin, user.id, { amount_usd: Number(d.amount_usd), cycle_start: d.cycle_start, cycle_end: d.cycle_end }, 'You cancelled it from your Referrals page')
      .catch((e: unknown) => console.error('[dashboard/cancel-payout] notify failed (non-fatal)', e))
    return NextResponse.json({ success: true, released: d.commissions_released })
  } catch (err) {
    console.error('[dashboard/cancel-payout] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
