import { createClient, createAdminClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { rateLimited } from '@/lib/rateLimit'
import { validatePasswordStrict } from '@/lib/passwordPolicy'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import { requireActiveUser } from '@/lib/apiAuth'
import {
  isMfaEnrolled, getMfaCookieFromRequest, checkVerifiedSession, issueVerifiedSession,
} from '@/lib/mfa'
import { flushSecurityNotices } from '@/lib/securityEvents'
import { RECOVERY_COOKIE_NAME, verifyRecoveryCookieValue } from '@/lib/recoveryCookie'
import { withMfaCookie } from '../mfa/_cookie'

// One server-side path for BOTH "forgot my password" (recovery link) and
// "change my password" (Settings). Previously both called
// supabase.auth.updateUser({ password }) straight from the browser, which
// meant: no current-password check (a stolen session token could set a new
// password), no server-side password policy, no revocation of other
// sessions, and the "password changed" email depended on the browser
// remembering to call a second endpoint.
//
//   recovery session  (arrived via a password-reset email link) → no current password needed
//   normal session                                              → current password required,
//                                                                 plus the 2FA step-up if enrolled
//
// After the change: every OTHER Supabase session is revoked, every MFA
// "verified browser" is revoked (the DB trigger from migration 0039 does the
// latter even for direct API calls), and the notice email goes out.
export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'password')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  const { password, current_password } = await req.json().catch(() => ({}))

  const policy = await validatePasswordStrict(password, user.email)
  if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: 400 })

  // "Arrived through an e-mailed recovery link" is decided ONLY by the signed
  // cookie /auth/callback sets after a real code exchange. The old fallback
  // that trusted the access token's `amr` claim also accepted `otp` and
  // `magiclink` — so merely confirming a signup or an e-mail change within the
  // last 30 minutes counted as "recovery" and skipped the current-password
  // check and the 2FA step-up.
  const cookieStore = await cookies()
  const isRecovery = await verifyRecoveryCookieValue(cookieStore.get(RECOVERY_COOKIE_NAME)?.value, user.id)

  const enrolled = await isMfaEnrolled(user.id).catch(() => null)
  if (enrolled === null) {
    return NextResponse.json({ error: 'Could not verify your account right now. Please try again in a moment.' }, { status: 503 })
  }

  let verifiedBefore = false
  if (!isRecovery) {
    if (typeof current_password !== 'string' || !current_password) {
      return NextResponse.json({ error: 'Enter your current password.' }, { status: 400 })
    }
    if (enrolled) {
      verifiedBefore = await checkVerifiedSession(getMfaCookieFromRequest(req), user.id)
      if (!verifiedBefore) {
        return NextResponse.json(
          { error: 'Two-factor verification required. Please verify your code, then retry.', code: 'mfa_required', redirect: '/auth/mfa-verify' },
          { status: 403 }
        )
      }
    }
    // Verify the current password on a throwaway client (no cookies, no
    // persisted session). See lib/passwordCheck.ts: the throwaway session is
    // discarded with scope 'local' — the default 'global' scope would end
    // EVERY session of this account, the caller's own included.
    const pw = await verifyCurrentPassword(user.id, user.email, current_password)
    if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
    if (pw !== 'ok') return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 400 })
    if (current_password === password) {
      return NextResponse.json({ error: 'Choose a password different from your current one.' }, { status: 400 })
    }
  }

  const { error: updErr } = await supabase.auth.updateUser({ password })
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 400 })

  // Revoke every other login session for this account.
  const { error: outErr } = await supabase.auth.signOut({ scope: 'others' })
  if (outErr) console.error('[auth/password] signOut(others) failed', user.id, outErr.message)

  // The DB trigger already wiped every MFA verified-browser row. A caller who
  // was verified a moment ago and just proved their current password keeps
  // working; a recovery caller (email proof only) must pass 2FA again.
  const res = NextResponse.json({ ok: true, needs_mfa: enrolled && !verifiedBefore })
  if (enrolled && verifiedBefore) {
    const { token, ttlS } = await issueVerifiedSession(user.id)
    withMfaCookie(res, token, ttlS)
  }
  res.cookies.set(RECOVERY_COOKIE_NAME, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 })

  await flushSecurityNotices(user.id).catch(e => console.error('[auth/password] notice flush failed', e))
  return res
}
