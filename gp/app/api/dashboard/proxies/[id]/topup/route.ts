import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { topupCredential } from '@/lib/credentials'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { parseIdempotencyKey, claimIdempotencyKey, completeIdempotencyKey, releaseIdempotencyKey } from '@/lib/idempotency'
import { NextResponse } from 'next/server'

// Adds GB to a credential the user already owns, instead of requiring a
// brand-new credential every time they run out. Deliberately additive —
// "create a new one" stays available; some customers want a disposable,
// capped credential and shouldn't have it silently made extendable.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', `proxy-topup:${user.id}`)
  if (limited) return limited
  const perUser = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-topup')
  if (perUser) return perUser

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const gb = parseGbAmount(body?.gb_amount)
  if (!gb.ok) return NextResponse.json({ error: gb.error }, { status: 400 })

  const admin = await createAdminClient()

  // Optional Idempotency-Key (the dashboard sends one that stays the same until the top-up is known to
  // have landed): a retry after a timeout returns the original answer instead of moving the GB twice.
  // No stale takeover — a top-up whose outcome is unknown is never re-run blindly.
  const idem = parseIdempotencyKey(req)
  if (!idem.ok) return NextResponse.json({ error: idem.error }, { status: 400 })
  if (idem.key) {
    const claim = await claimIdempotencyKey(admin, user.id, idem.key, JSON.stringify({ id, gb: gb.value }), 'POST /dashboard/proxies/topup', { allowStaleTakeover: false })
    if (claim.kind === 'replay') return NextResponse.json(claim.body, { status: claim.status, headers: { 'Idempotent-Replayed': 'true' } })
    if (claim.kind === 'mismatch') return NextResponse.json({ error: 'This request was already submitted with a different amount. Reload the page and try again.' }, { status: 422 })
    if (claim.kind === 'in_flight') return NextResponse.json({ error: 'This top-up is still being applied — give it a few seconds, then check the session\u2019s allocation.' }, { status: 409, headers: { 'Retry-After': '2' } })
    if (claim.kind === 'unknown_outcome') return NextResponse.json({ error: 'An earlier attempt did not finish. Check this session\u2019s allocation before topping up again.' }, { status: 409 })
  }

  const result = await topupCredential(admin, user.id, id, gb.value, 'dashboard')
  if (!result.ok) {
    if (idem.key) await releaseIdempotencyKey(admin, user.id, idem.key)
    return NextResponse.json({ error: result.message }, { status: result.status })
  }

  const out = { success: true, gb_allocated: result.data.gb_allocated, warning: result.data.warning }
  if (idem.key) await completeIdempotencyKey(admin, user.id, idem.key, 200, out)
  return NextResponse.json(out)
}
