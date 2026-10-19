import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// A flagged referral (second signup from the same IP on one referrer's code)
// earns nothing — no GB bonus, no commission — until an admin has looked at
// it. Clearing the flag lets FUTURE orders earn; it does not back-date.
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response

    const body = await readJson(req)
    if (!isUuid(body?.referralId)) return badRequest('Referral ID missing')

    const { data: ok, error } = await auth.supabase.rpc('clear_referral_flag', { p_referral_id: body!.referralId })
    if (error) {
      console.error('[admin/clear-referral-flag] rpc failed', error)
      return NextResponse.json({ error: 'Could not clear the flag.' }, { status: 500 })
    }
    if (!ok) return NextResponse.json({ error: 'That referral is not flagged.' }, { status: 409 })

    await logAdminAction(auth.supabase, { adminId: auth.adminId, action: 'referral_flag_cleared', targetRef: body!.referralId })
    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[admin/clear-referral-flag] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
