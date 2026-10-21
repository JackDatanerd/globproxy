import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { provisionPendingCredentials } from '@/lib/credentials'
import { rateLimited, rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// "Retry now" for a credential stuck in 'pending' (the proxy network was
// unreachable when it was created). The cron 'provision' task already
// retries on its own with backoff; this is the customer's on-demand button.
// It goes through the same atomic claim (claim_pending_credentials), so
// clicking twice — or racing the cron — can't create two upstream sub-users.
// ignoreBackoff only waits out the short claim window, not the retry backoff.
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

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', `proxy-retry:${user.id}`)
  if (limited) return limited
  const perUser = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-retry')
  if (perUser) return perUser

  const { id } = await context.params

  // Ownership check via the user's own session (RLS select policy) before
  // anything runs with service-role rights.
  const { data: owned } = await supabase
    .from('proxy_credentials').select('id, status').eq('id', id).eq('user_id', user.id).maybeSingle()
  if (!owned) return NextResponse.json({ error: 'Credential not found' }, { status: 404 })
  if (owned.status !== 'pending') {
    return NextResponse.json({ error: 'This session is not waiting to be provisioned.' }, { status: 409 })
  }

  // Scoped to this user's pending credentials; the claim is atomic.
  const result = await provisionPendingCredentials({ userId: user.id, limit: 5, ignoreBackoff: true })
  if (result.skipped) return NextResponse.json({ error: 'Provisioning is currently unavailable.' }, { status: 409 })
  if (result.activated > 0) return NextResponse.json({ success: true, status: 'active' })
  if (result.claimed === 0) {
    return NextResponse.json({ error: 'A provisioning attempt is already in progress — check back in a moment.' }, { status: 409 })
  }
  return NextResponse.json({ error: 'The proxy network is still unreachable. We’ll keep retrying automatically.' }, { status: 502 })
}
