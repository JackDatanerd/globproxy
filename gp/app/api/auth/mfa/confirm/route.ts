import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { confirmEnrollment, publicMfaError, sessionIdFromJwt } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { withMfaCookie } from '../_cookie'
import { recordAndNotify } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
  }

  const { data: { session } } = await supabase.auth.getSession()
  try {
    const { backup_codes, session_token, session_ttl_s } = await confirmEnrollment(user.id, user.email, code, req, sessionIdFromJwt(session?.access_token))

    // Security-relevant account change: the owner is told durably (stored, sent now, retried by the cron sweep if the provider is down) — if this wasn't the owner, someone else now controls the second factor.
    await recordAndNotify({ userId: user.id, event: 'mfa_enabled', req })
    const res = NextResponse.json({ backup_codes })
    // session_token is empty only if the verified-browser row couldn't be
    // written after enrollment committed — the codes are still returned and
    // the user simply verifies once on their next page.
    return session_token ? withMfaCookie(res, session_token, session_ttl_s) : res
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not confirm code.') }, { status: 400 })
  }
}
