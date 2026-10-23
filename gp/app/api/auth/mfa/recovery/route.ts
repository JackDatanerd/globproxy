import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import {
  requestRecovery, recoveryStatus, confirmRecovery, cancelRecovery, completeRecovery, pendingRecoveryFor,
} from '@/lib/mfaRecovery'
import { sessionIdFromJwt } from '@/lib/sessionDevices'
import { requireMfaVerified, cancelOpenRecoveryRequests } from '@/lib/mfa'
import { clearMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

// Self-service "I lost my authenticator AND my backup codes" — the waiting-period
// flow described in lib/mfaRecovery.ts. One endpoint, four actions:
//   request   (signed in, password)        -> e-mails a confirmation link
//   status    (token only)                 -> what state is this request in
//   confirm   (signed in as owner, token)  -> starts the waiting period
//   cancel    (token only)                 -> the real owner stops it
//   complete  (signed in as owner, token)  -> after the wait: 2FA removed
//   pending / cancel_mine (signed in AND 2FA-verified) -> the owner, who still
//             has their authenticator, sees and stops a request in Settings
// None of the first five is gated by the 2FA step-up (that is the whole point).
export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const body = await req.json().catch(() => ({}))
  const action = typeof body.action === 'string' ? body.action : ''
  const token = typeof body.token === 'string' ? body.token : ''

  try {
    // Token-only actions: no sign-in required.
    if (action === 'status') return NextResponse.json(await recoveryStatus(token))
    if (action === 'cancel') {
      const cancelled = await cancelRecovery(token, req)
      return NextResponse.json({ cancelled })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user?.email) return NextResponse.json({ error: 'Please sign in first.', code: 'signin_required' }, { status: 401 })
    const inactive = await requireActiveUser(user.id)
    if (inactive) return inactive

    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle()

    if (action === 'pending' || action === 'cancel_mine') {
      // Here the 2FA gate DOES apply: only someone who still holds the
      // authenticator may see or stop a pending removal from Settings (a
      // locked-out owner uses the emailed link instead).
      const mfaBlock = await requireMfaVerified(req, user.id)
      if (mfaBlock) return mfaBlock
      if (action === 'pending') return NextResponse.json({ pending: await pendingRecoveryFor(user.id) })
      const n = await cancelOpenRecoveryRequests(admin, user.id, req, 'owner_from_settings')
      return NextResponse.json({ cancelled: n })
    }

    if (action === 'request') {
      if (typeof body.password !== 'string' || !body.password) {
        return NextResponse.json({ error: 'Enter your password to continue.' }, { status: 400 })
      }
      const pw = await verifyCurrentPassword(user.id, user.email, body.password, req)
      if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
      if (pw !== 'ok') return NextResponse.json({ error: 'That password is incorrect.' }, { status: 400 })
      await requestRecovery(user.id, user.email, profile?.full_name, req)
      return NextResponse.json({ success: true })
    }
    if (action === 'confirm') {
      return NextResponse.json(await confirmRecovery(user.id, user.email, profile?.full_name, token, req))
    }
    if (action === 'complete') {
      const { data: { session } } = await supabase.auth.getSession()
      await completeRecovery(user.id, user.email, profile?.full_name, token, req, sessionIdFromJwt(session?.access_token))
      return clearMfaCookie(NextResponse.json({ success: true }))
    }
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Something went wrong. Please try again.' }, { status: 400 })
  }
}
