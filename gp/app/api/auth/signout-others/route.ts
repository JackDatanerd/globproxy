import { rejectCrossSite, requireActiveUser } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { rateLimited } from '@/lib/rateLimit'
import { revokeOtherVerifiedSessions, getMfaCookieFromRequest, requireMfaVerified } from '@/lib/mfa'
import { logSecurityEvent } from '@/lib/securityEvents'

// "Sign out of all other devices": revokes every other Supabase session for
// the account and every other MFA verified-browser, keeping this one.
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'password')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Without this a password-only session could sign the owner out everywhere
  // and wipe every trusted browser (revokeOtherVerifiedSessions keeps only the
  // caller's own cookie, which a not-yet-verified session doesn't have).
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive
  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock

  const { error } = await supabase.auth.signOut({ scope: 'others' })
  if (error) {
    console.error('[auth/signout-others] failed', user.id, error.message)
    return NextResponse.json({ error: 'Could not sign out other devices. Please try again.' }, { status: 500 })
  }
  await revokeOtherVerifiedSessions(user.id, getMfaCookieFromRequest(req))
  await logSecurityEvent({ userId: user.id, event: 'signout_others', req })
  return NextResponse.json({ success: true })
}
