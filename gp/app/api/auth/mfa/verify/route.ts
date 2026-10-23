import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { verifyFactor, publicMfaError, sessionIdFromJwt } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { withMfaCookie } from '../_cookie'
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

  const { code, remember } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your 6-digit code or a backup code.' }, { status: 400 })
  }

  const { data: { session } } = await supabase.auth.getSession()
  try {
    const { session_token, session_ttl_s, used_backup_code, backup_codes_remaining } =
      await verifyFactor(user.id, user.email, code, { remember: remember === true, req, authSessionId: sessionIdFromJwt(session?.access_token) })
    const res = NextResponse.json({ used_backup_code, backup_codes_remaining, remembered: session_ttl_s > 12 * 60 * 60 })
    return withMfaCookie(res, session_token, session_ttl_s)
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not verify code.') }, { status: 400 })
  }
}
