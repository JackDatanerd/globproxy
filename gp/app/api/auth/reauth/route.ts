import { createClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { isCrossSiteRequest } from '@/lib/appUrl'
import { isMfaEnrolled } from '@/lib/mfa'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import { makeSudoCookieValue, SUDO_COOKIE_NAME, SUDO_TTL_S } from '@/lib/reauth'
import { NextResponse } from 'next/server'

// "Sudo mode" for accounts WITHOUT two-factor authentication (lib/reauth.ts).
// Sensitive routes answer 403 { code: 'reauth_required' }; the browser dialog
// (lib/reauthPrompt.ts) posts the password here, gets a 10-minute signed
// cookie, and retries the original request.
//
// Accounts that have 2FA never need this: they use the TOTP step-up, and a
// password alone must not be enough for them. They get a clear 409 instead of
// a cookie nobody would honour.
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
  if (typeof body.password !== 'string' || !body.password) {
    return NextResponse.json({ error: 'Enter your password to continue.' }, { status: 400 })
  }

  if (await isMfaEnrolled(user.id)) {
    return NextResponse.json(
      { error: 'This account uses two-factor authentication. Verify with your authenticator code instead.', code: 'mfa_required' },
      { status: 409 }
    )
  }

  const pw = await verifyCurrentPassword(user.id, user.email, body.password)
  if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
  if (pw !== 'ok') return NextResponse.json({ error: 'That password is incorrect.' }, { status: 400 })

  const res = NextResponse.json({ success: true, expires_in: SUDO_TTL_S })
  res.cookies.set(SUDO_COOKIE_NAME, await makeSudoCookieValue(user.id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SUDO_TTL_S,
  })
  return res
}
