import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseGbAmount } from '@/lib/apiValidation'
import { releaseCredentialBandwidth } from '@/lib/credentials'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Hands unused GB on this session back to the account balance without
// deleting the session. All the safety (live-usage floor, upstream cap lowered
// first, restored on refusal) lives in releaseCredentialBandwidth — shared
// with POST /api/v1/sub-users/:id/release.
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
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-release')
  if (throttled) return throttled

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  const gb = parseGbAmount(body?.gb_amount)
  if (!gb.ok) return NextResponse.json({ error: gb.error }, { status: 400 })

  const admin = await createAdminClient()
  const result = await releaseCredentialBandwidth(admin, user.id, id, gb.value, 'dashboard')
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Credential not found' : result.message },
      { status: result.status }
    )
  }
  return NextResponse.json({
    success: true,
    gb_allocated: result.data.gb_allocated,
    gb_released: result.data.gb_released,
    max_releasable_gb: result.data.max_releasable_gb,
    warning: result.data.warning,
  })
}
