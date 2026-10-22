import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { notifyPayoutVoided } from '@/lib/affiliateNotify'

// Cancel a PENDING payout (wrong destination, sent in error, transfer failed).
// void_affiliate_payout releases the commissions back to the affiliate's
// balance, deletes the payout row (its (referrer, cycle) slot must be free so
// the cycle can be run again) and returns the details — which are written to
// the audit log here, so nothing is lost. A payout already marked paid can't be
// voided: that's a real-money correction and goes through support.
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const body = await readJson(req)
    if (!isUuid(body?.payoutId)) return badRequest('Payout ID missing')
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    if (!reason) return badRequest('A reason is required')

    const { data, error } = await auth.supabase.rpc('void_affiliate_payout', { p_payout_id: body!.payoutId })
    if (error) {
      console.error('[admin/void-payout] rpc failed', error)
      return NextResponse.json({ error: 'Could not void this payout.' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Only a pending payout can be voided.' }, { status: 409 })

    await logAdminAction(auth.supabase, {
      adminId: auth.adminId,
      action: 'payout_voided',
      targetUserId: (data as any).referrer_id ?? null,
      targetRef: body!.payoutId,
      details: { reason, ...(data as object) },
    })
    const d = data as any
    if (d.referrer_id) {
      await notifyPayoutVoided(auth.supabase, d.referrer_id, { amount_usd: Number(d.amount_usd), cycle_start: d.cycle_start, cycle_end: d.cycle_end }, reason)
        .catch(e => console.error('[admin/void-payout] notify failed (non-fatal)', e))
    }
    return NextResponse.json({ success: true, released: d.commissions_released })
  } catch (err: any) {
    console.error('[admin/void-payout] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
