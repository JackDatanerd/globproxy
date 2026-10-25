import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { disableMfa, publicMfaError } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { clearMfaCookie } from '../_cookie'
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
    return NextResponse.json({ error: 'Enter your current code to confirm.' }, { status: 400 })
  }

  try {
    await disableMfa(user.id, user.email, code, req)
    // The exact move an attacker with password access makes right before locking the real owner out — the trip-wire e-mail is durable (see recordAndNotify).
    await recordAndNotify({ userId: user.id, event: 'mfa_disabled', req })
    const res = NextResponse.json({ success: true })
    return clearMfaCookie(res)
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not disable MFA.') }, { status: 400 })
  }
}
