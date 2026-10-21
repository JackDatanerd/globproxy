import { createClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { isMfaEnrolled, verifyFreshCode, publicMfaError } from '@/lib/mfa'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import { makeSudoCookieValue, SUDO_COOKIE_NAME, SUDO_TTL_S } from '@/lib/reauth'
import { NextResponse } from 'next/server'

// "Sudo mode" for accounts WITHOUT two-factor authentication (lib/reauth.ts).
// Sensitive routes answer 403 { code: 'reauth_required' }; the browser dialog
// (lib/reauthPrompt.ts) posts the password here, gets a 10-minute signed
// cookie, and retries the original request.
//
// Accounts that have 2FA prove themselves with a FRESH authenticator (or backup)
// code instead — { code } — and a password alone must not be enough for them.
// Their cookie is tagged 'totp' so only a code earns it (lib/reauth.ts).
export async function POST(req: Request) {
  if (isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'password')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Please sign in first.' }, { status: 401 })
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const body = await req.json().catch(() => ({}))

  let enrolled: boolean
  try {
    enrolled = await isMfaEnrolled(user.id)
  } catch {
    return NextResponse.json({ error: 'Could not verify your account right now. Please try again in a moment.' }, { status: 503 })
  }

  let kind: 'pw' | 'totp'
  if (enrolled) {
    if (typeof body.code !== 'string' || !body.code.trim()) {
      return NextResponse.json({ error: 'Enter the code from your authenticator app.', code: 'mfa_required', method: 'totp' }, { status: 400 })
    }
    try {
      await verifyFreshCode(user.id, user.email, body.code, req)
    } catch (e) {
      return NextResponse.json({ error: publicMfaError(e, 'Could not verify code.') }, { status: 400 })
    }
    kind = 'totp'
  } else {
    if (typeof body.password !== 'string' || !body.password) {
      return NextResponse.json({ error: 'Enter your password to continue.' }, { status: 400 })
    }
    const pw = await verifyCurrentPassword(user.id, user.email, body.password)
    if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
    if (pw !== 'ok') return NextResponse.json({ error: 'That password is incorrect.' }, { status: 400 })
    kind = 'pw'
  }

  const res = NextResponse.json({ success: true, expires_in: SUDO_TTL_S })
  res.cookies.set(SUDO_COOKIE_NAME, await makeSudoCookieValue(user.id, kind), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SUDO_TTL_S,
  })
  return res
}
