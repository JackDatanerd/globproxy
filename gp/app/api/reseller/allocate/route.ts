import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireStepUp } from '@/lib/reauth'
import { rejectCrossSite } from '@/lib/apiAuth'
import { parseIdempotencyKey, claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '@/lib/idempotency'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { parseAllocationBody, allocateBandwidth } from '@/lib/resellerAllocation'
import { NextResponse } from 'next/server'

// Dashboard entry point (session auth + 2FA). The transfer itself — recipient
// lookup, atomic stock move, webhooks, notification e-mails — is
// lib/resellerAllocation.ts, shared with POST /api/v1/reseller/allocations.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross
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

    // Moving stock to another account is the reseller equivalent of changing a
    // payout destination: a stolen session on an account without 2FA must not be
    // able to empty it. Enrolled accounts need a verified 2FA session; the rest
    // confirm their password once (answered by the client's fetchWithReauth).
    const mfaCheck = await requireStepUp(req, user.id)
    if (mfaCheck) return mfaCheck

    const senderSuspended = await requireActiveUser(user.id)
    if (senderSuspended) return senderSuspended

    // Per-reseller throttle. Each call can email an arbitrary registered
    // address, so without this a reseller could use dust-sized allocations as
    // an unmetered email cannon, or probe which emails are registered.
    const limited = await rateLimited(req, 'RESELLER_RATE_LIMITER', `allocate:${user.id}`)
    if (limited) return limited
    const perUser = await rateLimitedUser('RESELLER_RATE_LIMITER', user.id, 'allocate')
    if (perUser) return perUser

    let body: any
    try { body = await req.json() } catch { body = null }
    const input = parseAllocationBody(body)
    if (!input.ok) return NextResponse.json({ error: input.message }, { status: input.status })

    // Optional Idempotency-Key (the bulk sender sends one per line): a retry
    // after a 429/timeout returns the first answer instead of moving the
    // bandwidth twice. If an earlier attempt's outcome is unknown the caller is
    // told to check Transfers rather than risk a duplicate.
    const idem = parseIdempotencyKey(req)
    if (!idem.ok) return NextResponse.json({ error: idem.error }, { status: 400 })
    const admin = await createAdminClient()
    if (idem.key) {
      const claim = await claimIdempotencyKey(admin, user.id, idem.key, JSON.stringify(input.data), 'POST /reseller/allocate', { allowStaleTakeover: false })
      if (claim.kind === 'replay') return NextResponse.json(claim.body, { status: claim.status, headers: { 'Idempotent-Replayed': 'true' } })
      if (claim.kind === 'mismatch') return NextResponse.json({ error: 'This request key was already used for a different transfer.' }, { status: 422 })
      if (claim.kind === 'in_flight') return NextResponse.json({ error: 'This transfer is still being processed. Check Transfers in a moment.' }, { status: 409, headers: { 'Retry-After': '2' } })
      if (claim.kind === 'unknown_outcome') return NextResponse.json({ error: 'An earlier attempt of this transfer did not finish. Check Transfers to see whether it went through before sending it again.' }, { status: 409 })
    }

    const result = await allocateBandwidth(
      admin,
      { id: user.id, email: profile?.email, full_name: profile?.full_name },
      input.data
    )
    if (!result.ok) {
      if (idem.key) await releaseIdempotencyKey(admin, user.id, idem.key)
      // The only 429 this path produces is the daily new-recipient cap — a "come back tomorrow"
      // refusal, not a throttle. The code lets the bulk sender report it as a definite failure
      // instead of waiting out a per-minute retry loop that can never succeed.
      if (result.status === 429) return NextResponse.json({ error: result.message, code: 'new_recipient_limit' }, { status: 429, headers: { 'Retry-After': '3600' } })
      return NextResponse.json({ error: result.message }, { status: result.status })
    }
    const responseBody = { success: true, transfer_id: result.data.transfer_id, status: result.data.status, pending_id: result.data.pending_id, message: result.data.message }
    if (idem.key) await completeIdempotencyKey(admin, user.id, idem.key, 200, responseBody)
    return NextResponse.json(responseBody)
  } catch (err: any) {
    console.error('Allocation error:', err)
    return NextResponse.json({ error: 'Failed to complete transfer.' }, { status: 500 })
  }
}
