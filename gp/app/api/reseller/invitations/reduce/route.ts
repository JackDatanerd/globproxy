import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser, rejectCrossSite } from '@/lib/apiAuth'
import { requireStepUp } from '@/lib/reauth'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { reduceInvitation } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// Lower the amount reserved on an open invitation (typo'd figure) without cancelling it.
// Logic shared with PATCH /api/v1/reseller/invitations/:id (lib/resellerAllocation.ts).
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
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `invite-reduce:${user.id}`)
    if (limited) return limited
    const perUser = await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'invite-reduce')
    if (perUser) return perUser

    let body: any
    try { body = await req.json() } catch { body = null }
    const result = await reduceInvitation(await createAdminClient(), { id: user.id, email: profile?.email, full_name: profile?.full_name }, String(body?.pending_id ?? ''), body?.gb)
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    return NextResponse.json({ success: true, gb: result.data.gb, returned_gb: result.data.returned_gb })
  } catch (err) {
    console.error('[reseller/invitations/reduce] error', err)
    return NextResponse.json({ error: 'Could not change this invitation.' }, { status: 500 })
  }
}
