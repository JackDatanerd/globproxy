import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited, rateLimitedTarget } from '@/lib/rateLimit'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { holdUntil } from '@/lib/constantTime'
import { sameOriginUrl } from '@/lib/appUrl'
import { validatePasswordStrict } from '@/lib/passwordPolicy'
import { recordReferralSignup, recordSignupIp } from '@/lib/referrals'
import { REF_COOKIE, REF_SUB_COOKIE, readCookie, hashIp } from '@/lib/referralAttribution'
import { NextResponse } from 'next/server'

// Until now a signup that never got its confirmation email (spam folder,
// typo'd inbox provider hiccup) had no way forward: the "Try again" link on
// /auth/verify went back to signup, which — to avoid leaking which emails are
// registered — answers "check your email" for an existing address WITHOUT
// sending anything. This is the real "resend" path.
//
// Same enumeration discipline as signup/reset: one fixed response whichever
// branch ran, with the slow (email-sending) branch capped at the same floor.
//
// TWO MODES.
//  - With `password`: the same flow as submitting the signup form again. signUp()
//    on an unconfirmed address re-sends the link AND starts a PKCE flow, so the
//    link can sign the visitor in from this browser and /auth/callback hands the
//    quarantined password back (migration 0060). The password is replaced with the
//    one typed now ("newest signup wins"), only after the mail provider accepted
//    the new link.
//  - Without it: resend() — a link with no PKCE challenge. It still confirms the
//    address, but the account's password stays quarantined, so the first sign-in
//    needs "Forgot password". The verify page says so.

const RESPONSE_FLOOR_MS = 1800

function respond() {
  return NextResponse.json({ success: true, message: "If that address is waiting for confirmation, we've sent a new link." })
}

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const startedAt = Date.now()
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'resend')
    if (limited) return limited

    const { email, emailRedirectTo, turnstileToken, password } = await req.json().catch(() => ({}))
    if (typeof email !== 'string' || !email) return NextResponse.json({ error: 'Email required' }, { status: 400 })
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    // Per target address AND calling address (plus an hourly all-callers ceiling) —
    // counted only after the human check so a bot that can't pass it can't burn a
    // victim's budget. See lib/targetThrottle.ts.
    const targetLimited = await rateLimitedTarget('resend', email, req)
    if (targetLimited) return targetLimited

    const safeRedirect = sameOriginUrl(emailRedirectTo)

    // Only judged on the password itself, so a rejection says nothing about the address.
    const withPassword = typeof password === 'string' && password.length > 0
    if (withPassword) {
      const policy = await validatePasswordStrict(password, email)
      if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: 400 })
    }

    const admin = await createAdminClient()
    const lower = email.trim().toLowerCase()

    const { data: banned } = await admin.rpc('is_email_banned', { check_email: lower })
    if (banned) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return respond() }

    const { data: unconfirmed } = await admin.rpc('auth_email_unconfirmed', { check_email: lower })
    if (!unconfirmed) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return respond() }

    const ssr = await createClient()

    if (withPassword) {
      const { data: unconfirmedId } = await admin.rpc('auth_unconfirmed_user_id', { check_email: lower })
      if (!unconfirmedId) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return respond() }
      const work = (async () => {
        // signUp() would otherwise overwrite the metadata with nothing: carry over
        // what the first signup stored.
        let meta: Record<string, unknown> = {}
        try {
          const { data: u } = await admin.auth.admin.getUserById(unconfirmedId as string)
          const m = (u?.user?.user_metadata ?? {}) as Record<string, unknown>
          meta = { full_name: m.full_name, intended_role: m.intended_role }
        } catch { /* fall through with no metadata */ }
        const { error: signErr } = await ssr.auth.signUp({
          email: lower, password,
          options: { data: meta, emailRedirectTo: safeRedirect, ...captchaOptions(turnstileToken) },
        })
        if (signErr) { console.error('[auth/resend-confirmation] re-signup failed:', signErr.status, signErr.message); return }
        const { data: replaced, error: pwErr } = await admin.rpc('auth_replace_unconfirmed_password', { p_user_id: unconfirmedId as string, p_password: password })
        if (pwErr) { console.error('[auth/resend-confirmation] could not replace unconfirmed password:', pwErr.message); return }
        if (!replaced) return
        // "Newest signup wins" applies to the referral too, exactly as in /api/auth/signup:
        // whoever typed this address first (not necessarily its owner) may have attached
        // their own referral code to it, and the person now setting the password must not
        // inherit that. Re-attributed from THIS browser's own referral cookie, so a code
        // only survives if this visitor really arrived through it. Only while unconfirmed
        // and before any reward (the RPC enforces both).
        try {
          const { error: resetErr } = await admin.rpc('reset_unconfirmed_referral', { p_user_id: unconfirmedId as string })
          if (resetErr) { console.error('[auth/resend-confirmation] reset_unconfirmed_referral failed:', resetErr.message); return }
          const ipHash = hashIp(req.headers.get('cf-connecting-ip'))
          await recordSignupIp(admin, unconfirmedId as string, ipHash)
          const cookieHeader = req.headers.get('cookie')
          await recordReferralSignup(
            admin,
            readCookie(cookieHeader, REF_COOKIE),
            unconfirmedId as string,
            { subId: readCookie(cookieHeader, REF_SUB_COOKIE), ipHash },
          )
        } catch (e) {
          console.error('[auth/resend-confirmation] re-attribution failed (non-fatal):', e)
        }
      })().catch(e => console.error('[auth/resend-confirmation] re-signup threw', e))
      await holdUntil(startedAt, RESPONSE_FLOOR_MS, work)
      return respond()
    }
    const work = ssr.auth
      .resend({ type: 'signup', email: lower, options: { emailRedirectTo: safeRedirect, ...captchaOptions(turnstileToken) } })
      .then(({ error }) => { if (error) console.error('[auth/resend-confirmation] resend failed:', error.message) })
    await holdUntil(startedAt, RESPONSE_FLOOR_MS, work)
    return respond()
  } catch (err) {
    console.error('[auth/resend-confirmation] unexpected error', err)
    await holdUntil(startedAt, RESPONSE_FLOOR_MS)
    return respond()
  }
}
