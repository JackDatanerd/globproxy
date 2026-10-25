import { rejectCrossSite, requireActiveUser } from '@/lib/apiAuth'
import { createClient } from '@/lib/supabase/server'
import { startRekey, confirmRekey, getMfaCookieFromRequest, publicMfaError } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { recordAndNotify } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

// "Change authenticator": move 2FA to a new phone / app WITHOUT turning it off first.
//   { action: 'start',   code }  code = a current authenticator code (or a backup code, when the old
//                                phone is gone) -> { secret, otpauth_uri, qr_svg } for the NEW seed
//   { action: 'confirm', code }  code = a 6-digit code from the NEW authenticator -> swaps it in
// The live secret keeps working until 'confirm' succeeds; an abandoned change costs nothing.
// See lib/mfa.ts (startRekey / confirmRekey) and migration 0082.
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

  const body = await req.json().catch(() => ({}))
  const action = body?.action
  const code = body?.code
  if (action !== 'start' && action !== 'confirm') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: action === 'start' ? 'Enter your current code to continue.' : 'Enter the 6-digit code from your new authenticator app.' }, { status: 400 })
  }

  try {
    if (action === 'start') {
      const start = await startRekey(user.id, user.email, code, req)
      return NextResponse.json(start)
    }
    await confirmRekey(user.id, user.email, code, req, getMfaCookieFromRequest(req))
    // The owner is told durably (stored, sent now, retried by the cron sweep): a swapped
    // authenticator is exactly what someone who has taken the account would do.
    await recordAndNotify({ userId: user.id, event: 'mfa_rekeyed', req })
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not change the authenticator.') }, { status: 400 })
  }
}
