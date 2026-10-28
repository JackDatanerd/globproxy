import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { rateLimited } from '@/lib/rateLimit'
import { validatePasswordStrict } from '@/lib/passwordPolicy'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import { requireActiveUser } from '@/lib/apiAuth'
import {
  isMfaEnrolled, getMfaCookieFromRequest, checkVerifiedSession, issueVerifiedSession, sessionIdFromJwt,
} from '@/lib/mfa'
import { flushSecurityNotices } from '@/lib/securityEvents'
import { throttleClear } from '@/lib/authThrottle'
import { RECOVERY_COOKIE_NAME, verifyRecoveryCookieValue } from '@/lib/recoveryCookie'
import { withMfaCookie } from '../mfa/_cookie'
import { clearSudoCookie } from '@/lib/reauth'

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
  const cross = rejectCrossSite(req)
  if (cross) return cross

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
      return NextResponse.json({ error: 'Enter your current password.', code: 'current_password_required' }, { status: 400 })
    }
    if (enrolled) {
      try {
        verifiedBefore = await checkVerifiedSession(getMfaCookieFromRequest(req), user.id, { throwOnError: true })
      } catch {
        return NextResponse.json({ error: 'Could not verify your account right now. Please try again in a moment.' }, { status: 503 })
      }
      if (!verifiedBefore) {
        return NextResponse.json(
          { error: 'Two-factor verification required. Please verify your code, then retry.', code: 'mfa_required', redirect: '/auth/mfa-verify' },
          { status: 403 }
        )
      }
    }
    // Verified in SQL (lib/passwordCheck.ts) — no GoTrue sign-in involved.
    const pw = await verifyCurrentPassword(user.id, user.email, current_password, req)
    if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
    if (pw !== 'ok') return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 400 })
    if (current_password === password) {
      return NextResponse.json({ error: 'Choose a password different from your current one.' }, { status: 400 })
    }
  }

  // The caller's identity and (unless this is an e-mailed recovery) current
  // password were verified above, so the change is applied with the admin API.
  // supabase.auth.updateUser() would be refused for sessions older than 24 h
  // whenever Supabase's "Secure password change" is on (it then demands a
  // re-authentication nonce this app has no UI for), leaving long-lived
  // sessions unable to change their password at all.
  const admin = await createAdminClient()
  const { error: updErr } = await admin.auth.admin.updateUserById(user.id, { password })
  if (updErr) {
    console.error('[auth/password] update failed', user.id, updErr.status, updErr.message)
    const msg = /password/i.test(updErr.message) && updErr.status && updErr.status < 500
      ? 'That password was not accepted. Try a longer or less common one.'
      : 'Could not change your password right now. Please try again.'
    return NextResponse.json({ error: msg }, { status: updErr.status && updErr.status < 500 ? 400 : 503 })
  }

  // A password reset by e-mail proves mailbox control AND replaces the password
  // an attacker may have been using to hammer the 2FA prompt — so it also lifts
  // any lockout on the authenticator (otherwise the owner could be kept out of
  // their own account by someone who only knows the old password).
  // The same proof lifts the account-wide sign-in pause (lib/authThrottle.ts), so
  // someone hammering the login form can't keep the owner out of new locations.
  if (isRecovery) {
    await throttleClear('loginacct', user.email)
    await throttleClear('pwcheckacct', user.id)
  }
  if (isRecovery && enrolled) {
    const { error: unlockErr } = await admin.rpc('mfa_clear_failures', { p_user_id: user.id })
    if (unlockErr) console.error('[auth/password] could not lift mfa lock', user.id, unlockErr.message)
  }

  // Revoke every other login session for this account.
  const { error: outErr } = await supabase.auth.signOut({ scope: 'others' })
  if (outErr) console.error('[auth/password] signOut(others) failed', user.id, outErr.message)

  // The DB trigger already wiped every MFA verified-browser row. A caller who
  // was verified a moment ago and just proved their current password keeps
  // working; a recovery caller (email proof only) must pass 2FA again.
  let res = NextResponse.json({ ok: true, needs_mfa: enrolled && !verifiedBefore })
  if (enrolled && verifiedBefore) {
    // The password is already changed; failing here must not turn that into a
    // 500. Worst case the user is asked for their code once.
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const { token, ttlS } = await issueVerifiedSession(user.id, undefined, req, sessionIdFromJwt(session?.access_token))
      withMfaCookie(res, token, ttlS)
    } catch (e) {
      console.error('[auth/password] could not re-issue verified session', user.id, e)
      res = NextResponse.json({ ok: true, needs_mfa: true })
    }
  }
  clearSudoCookie(res)
  res.cookies.set(RECOVERY_COOKIE_NAME, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 })

  await flushSecurityNotices(user.id).catch(e => console.error('[auth/password] notice flush failed', e))
  return res
}
