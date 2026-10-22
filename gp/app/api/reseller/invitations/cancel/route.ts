import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser, rejectCrossSite } from '@/lib/apiAuth'
import { requireStepUp } from '@/lib/reauth'
import { rateLimited } from '@/lib/rateLimit'
import { cancelInvitation } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// Withdraw an invitation that hasn't been claimed yet: the reserved stock goes
// straight back to the reseller's available balance.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { data: profile } = await supabase.from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }
    const gate = await requireStepUp(req, user.id)
    if (gate) return gate
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `invite-cancel:${user.id}`)
    if (limited) return limited

    let body: any
    try { body = await req.json() } catch { body = null }
    const result = await cancelInvitation(await createAdminClient(), { id: user.id, email: profile?.email, full_name: profile?.full_name }, String(body?.pending_id ?? ''))
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    return NextResponse.json({ success: true, returned_gb: result.data.returned_gb })
  } catch (err) {
    console.error('[reseller/invitations/cancel] error', err)
    return NextResponse.json({ error: 'Could not cancel this invitation.' }, { status: 500 })
  }
}
