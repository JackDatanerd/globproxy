import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// Marks a flagged referral as confirmed fraud. It stays flagged (so it never
// earns a GB bonus or commission) but leaves the review queue. "Clear" is the
// opposite call and still works on a confirmed one if you change your mind.
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const body = await readJson(req)
    if (!isUuid(body?.referralId)) return badRequest('Referral ID missing')

    const { data: ok, error } = await auth.supabase.rpc('confirm_referral_fraud', { p_referral_id: body!.referralId })
    if (error) {
      console.error('[admin/confirm-referral-fraud] rpc failed', error)
      return NextResponse.json({ error: 'Could not confirm this referral.' }, { status: 500 })
    }
    if (!ok) return NextResponse.json({ error: 'That referral is not flagged, or is already confirmed.' }, { status: 409 })

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'referral_fraud_confirmed', targetRef: body!.referralId })
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[admin/confirm-referral-fraud] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
