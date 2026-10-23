import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { requireActiveUser } from '@/lib/apiAuth'
import { mfaGate } from '@/lib/mfa'
import { readCookie, verifySudoCookieValue, SUDO_COOKIE_NAME } from '@/lib/reauth'
import { verifyCurrentPassword, PASSWORD_THROTTLED_MSG } from '@/lib/passwordCheck'
import { appUrl } from '@/lib/appUrl'
import { logSecurityEvent, sendEmailChangeNotice, maskEmail } from '@/lib/securityEvents'

// Email change used to have no UI at all (the Settings field is read-only)
// even though /auth/callback already handles type=email_change. Changing the
// login email is an account-takeover primitive, so: current password +
// 2FA step-up (if enrolled), Supabase's own double-confirmation (both the
// old and the new address must click), and a notice to the OLD address.
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
  // Changing the sign-in email is an account-takeover primitive, so an account with
  // 2FA needs a FRESH authenticator/backup code (same step-up as payout, API keys,
  // webhooks and deletion), not just the 12 h / 30 d verified-browser cookie. Accounts
  // without 2FA already prove themselves with the current password in this request.
  const { response: mfa, enrolled } = await mfaGate(req, user.id)
  if (mfa) return mfa
  if (enrolled && !(await verifySudoCookieValue(readCookie(req, SUDO_COOKIE_NAME), user.id, 'totp'))) {
    return NextResponse.json(
      { error: 'Enter a fresh code from your authenticator app to continue.', code: 'reauth_required', method: 'totp' },
      { status: 403 }
    )
  }

  const { new_email, current_password } = await req.json().catch(() => ({}))
  if (typeof new_email !== 'string' || typeof current_password !== 'string' || !new_email || !current_password) {
    return NextResponse.json({ error: 'Enter the new email address and your current password.' }, { status: 400 })
  }
  const target = new_email.trim().toLowerCase()
  const { valid, error: emailError } = validateEmail(target)
  if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })
  if (target === user.email.toLowerCase()) {
    return NextResponse.json({ error: 'That is already your email address.' }, { status: 400 })
  }

  // Throwaway-client check, discarded with scope 'local' (see lib/passwordCheck.ts).
  const pw = await verifyCurrentPassword(user.id, user.email, current_password, req)
  if (pw === 'throttled') return NextResponse.json({ error: PASSWORD_THROTTLED_MSG }, { status: 429 })
  if (pw !== 'ok') return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 400 })

  const admin = await createAdminClient()
  const generic = NextResponse.json({
    success: true,
    message: `If ${target} can be used, we've sent confirmation links to it and to your current address. The change only applies once confirmed.`,
  })

  // Same enumeration discipline as signup: an address that is banned or
  // already registered gets the identical response and nothing happens.
  const { data: banned } = await admin.rpc('is_email_banned', { check_email: target })
  if (banned) return generic
  const { data: taken } = await admin.rpc('auth_email_exists', { check_email: target })
  if (taken) return generic

  const redirectTo = `${appUrl()}/auth/callback?type=email_change`

  const { error: updErr } = await supabase.auth.updateUser({ email: target }, { emailRedirectTo: redirectTo })
  if (updErr) {
    console.error('[auth/change-email] updateUser failed', updErr.message)
    return NextResponse.json({ error: 'Could not start the email change. Please try again.' }, { status: 400 })
  }

  await logSecurityEvent({ userId: user.id, event: 'email_change_requested', req, meta: { to: maskEmail(target) } })
  const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
  await sendEmailChangeNotice(user.email, profile?.full_name, maskEmail(target))
  return generic
}
