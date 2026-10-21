import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireMfaVerified } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { parseAllocationBody, allocateBandwidth } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// Dashboard entry point (session auth + 2FA). The transfer itself — recipient
// lookup, atomic stock move, webhooks, notification e-mails — is
// lib/resellerAllocation.ts, shared with POST /api/v1/reseller/allocations.
export async function POST(req: Request) {
  try {
    // ── Auth: reseller or admin only ────────────────────────────────────────
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('profiles').select('role, email, full_name').eq('id', user.id).single()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) {
      return NextResponse.json({ error: 'Reseller access required' }, { status: 403 })
    }

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    const senderSuspended = await requireActiveUser(user.id)
    if (senderSuspended) return senderSuspended

    // Per-reseller throttle. Each call can email an arbitrary registered
    // address, so without this a reseller could use dust-sized allocations as
    // an unmetered email cannon, or probe which emails are registered.
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `allocate:${user.id}`)
    if (limited) return limited

    let body: any
    try { body = await req.json() } catch { body = null }
    const input = parseAllocationBody(body)
    if (!input.ok) return NextResponse.json({ error: input.message }, { status: input.status })

    const result = await allocateBandwidth(
      await createAdminClient(),
      { id: user.id, email: profile?.email, full_name: profile?.full_name },
      input.data
    )
    if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status })
    return NextResponse.json({ success: true, transfer_id: result.data.transfer_id, message: result.data.message })
  } catch (err: any) {
    console.error('Allocation error:', err)
    return NextResponse.json({ error: 'Failed to complete transfer.' }, { status: 500 })
  }
}
