import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { cancelInvitation } from '@/lib/resellerAllocation'

// POST { pendingId } — support cancels a reseller's unclaimed invitation (a
// reseller who cannot reach their dashboard, or an invitation to a wrong
// address). The reserved stock returns to that reseller; their webhook endpoints
// hear about it like a self-service cancel (source "support").
export async function POST(req: Request) {
  try {
    const auth = await authorizeAdmin(req)
    if (!auth.ok) return auth.response
    const body = await readJson(req)
    if (!isUuid(body?.pendingId)) return badRequest('Invitation ID missing')

    const { data: inv } = await auth.supabase.from('reseller_pending_transfers')
      .select('reseller_id, recipient_email, gb_amount, status').eq('id', body!.pendingId).maybeSingle()
    if (!inv) return NextResponse.json({ error: 'Invitation not found.' }, { status: 404 })

    const { data: rp } = await auth.supabase.from('profiles').select('email, full_name').eq('id', inv.reseller_id).maybeSingle()
    const r = await cancelInvitation(auth.supabase, { id: inv.reseller_id, email: rp?.email, full_name: rp?.full_name }, body!.pendingId, 'support')
    if (!r.ok) return NextResponse.json({ error: r.message }, { status: r.status === 404 ? 409 : r.status })

    await logAdminAction(auth.supabase, {
      adminId: auth.adminId, action: 'reseller_invitation_cancelled', targetUserId: inv.reseller_id, targetRef: body!.pendingId,
      details: { recipient_email: inv.recipient_email, returned_gb: r.data.returned_gb },
    })
    return NextResponse.json({ success: true, returned_gb: r.data.returned_gb })
  } catch (err) {
    console.error('[admin/cancel-invitation] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 })
  }
}
