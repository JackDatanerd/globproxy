import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited, rateLimitedTarget } from '@/lib/rateLimit'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { holdUntil } from '@/lib/constantTime'
import { sameOriginUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'

// Until now a signup that never got its confirmation email (spam folder,
// typo'd inbox provider hiccup) had no way forward: the "Try again" link on
// /auth/verify went back to signup, which — to avoid leaking which emails are
// registered — answers "check your email" for an existing address WITHOUT
// sending anything. This is the real "resend" path.
//
// Same enumeration discipline as signup/reset: one fixed response whichever
// branch ran, with the slow (email-sending) branch capped at the same floor.
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

    const { email, emailRedirectTo, turnstileToken } = await req.json().catch(() => ({}))
    if (typeof email !== 'string' || !email) return NextResponse.json({ error: 'Email required' }, { status: 400 })
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    // Per target address, across every caller — counted only after the
    // human check so a bot that can't pass it can't burn a victim's budget.
    const targetLimited = await rateLimitedTarget('resend', email)
    if (targetLimited) return targetLimited

    const safeRedirect = sameOriginUrl(emailRedirectTo)

    const admin = await createAdminClient()
    const lower = email.trim().toLowerCase()

    const { data: banned } = await admin.rpc('is_email_banned', { check_email: lower })
    if (banned) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return respond() }

    const { data: unconfirmed } = await admin.rpc('auth_email_unconfirmed', { check_email: lower })
    if (!unconfirmed) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return respond() }

    const ssr = await createClient()
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
