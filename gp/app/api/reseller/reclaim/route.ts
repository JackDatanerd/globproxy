import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { parseReclaimBody, reclaimAllocation } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// Take back the UNUSED part of a transfer (typo'd email, cancelled order…).
// Only bandwidth the client has not used or committed to a credential, and has
// not since topped up past, can move back — and only within RECLAIM_WINDOW_DAYS
// of the transfer. reclaim_reseller_allocation() enforces all of that under row
// locks.
// Logic shared with POST /api/v1/reseller/allocations/:id/reclaim
// (lib/resellerAllocation.ts).
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase.from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }
    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `reclaim:${user.id}`)
    if (limited) return limited

    let body: any
    try { body = await req.json() } catch { body = null }
    const input = parseReclaimBody(body)
    if (!input.ok) return NextResponse.json({ error: input.message }, { status: input.status })

    const result = await reclaimAllocation(await createAdminClient(), { id: user.id, email: profile?.email, full_name: profile?.full_name }, input.data)
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    return NextResponse.json({ success: true, reclaimed_gb: result.data.reclaimed_gb, remaining_gb: result.data.remaining_gb })
  } catch (err: any) {
    console.error('Reclaim error:', err)
    return NextResponse.json({ error: 'Could not reclaim this transfer.' }, { status: 500 })
  }
}
