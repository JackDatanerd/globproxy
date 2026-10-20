import { logSecurityEvent } from '@/lib/securityEvents'
import { rejectCrossSite } from '@/lib/apiAuth'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited, rateLimitedTarget } from '@/lib/rateLimit'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { holdUntil } from '@/lib/constantTime'
import { sameOriginUrl } from '@/lib/appUrl'
import { NextResponse } from 'next/server'

// Always the exact same response, whatever happened internally. Previously
// this endpoint returned distinct responses for "no account" (404),
// "suspended" (403), and success (200) — letting anyone enumerate which
// emails are registered GlobProxy accounts (and which ones are suspended)
// just by probing this endpoint. The email itself still only goes out when
// it's actually warranted; the HTTP response no longer reveals which case it was.
//
// This must be a fresh NextResponse per call, not a shared module-level
// instance — a Response body is a single-use stream, and this app runs on
// Cloudflare Workers (via OpenNext) where module scope can persist across
// invocations in the same isolate, so a cached instance would fail on the
// second request that tries to use it.
function genericResponse() {
  return NextResponse.json({
    success: true,
    message: "If an account exists for that email, we've sent a password reset link.",
  })
}

// Identical response shape isn't the whole fix — wall-clock time still leaks
// which branch ran (the "all clear" branch waits on resetPasswordForEmail(), a
// real network call that dispatches an email). holdUntil() pads fast branches
// to the floor AND caps the slow one at the same floor (the send keeps running
// via waitUntil), so every branch answers in about the same time.
const RESPONSE_FLOOR_MS = 1800

export async function POST(req: Request) {
  const cross = rejectCrossSite(req)
  if (cross) return cross

  const startedAt = Date.now()
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'reset')
    if (limited) return limited

    const { email: rawEmail, redirectTo, turnstileToken } = await req.json().catch(() => ({}))
    if (typeof rawEmail !== 'string' || !rawEmail.trim() || rawEmail.length > 320) {
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }
    const email = rawEmail.trim()

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    // Per target address, across every caller — counted only after the
    // human check so a bot that can't pass it can't burn a victim's budget.
    const targetLimited = await rateLimitedTarget('reset', email)
    if (targetLimited) return targetLimited

    // redirectTo is client-supplied. Supabase enforces its own project-level
    // redirect URL allow-list, but that's an external config, not something
    // this code can verify — pin it to our own origin here too so this
    // endpoint doesn't rely entirely on that allow-list being correctly
    // locked down. An unrecognized redirectTo is just dropped, not rejected,
    // so the response shape doesn't change either way.
    const safeRedirectTo = sameOriginUrl(redirectTo)
    if (redirectTo && !safeRedirectTo) console.error('[auth/reset] rejected redirectTo outside app origin:', redirectTo)

    const supabase = await createAdminClient()

    // 1. Banned (plus-address aware) — don't send, don't reveal.
    const { data: banned } = await supabase.rpc('is_email_banned', { check_email: email.toLowerCase() })
    if (banned) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return genericResponse() }

    // 2. No account — don't send, don't reveal.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, is_suspended')
      .eq('email', email.toLowerCase())
      .maybeSingle()
    if (!profile) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return genericResponse() }

    // 3. Suspended — don't send, don't reveal.
    if (profile.is_suspended) { await holdUntil(startedAt, RESPONSE_FLOOR_MS); return genericResponse() }

    // 4. All clear — send the reset email. Failures are logged server-side
    // only. This MUST go through the cookie-aware ssr client: with PKCE,
    // resetPasswordForEmail() writes the code_verifier cookie (before it
    // contacts GoTrue) so /auth/callback can exchange the code later.
    // Audit trail for the owner (Settings → Recent activity): a reset request
    // is the first step of most account takeovers. Logged only for real,
    // active accounts, so the response (identical either way) leaks nothing.
    await logSecurityEvent({ userId: profile.id, event: 'password_reset_requested', req, admin: supabase })
      .catch(e => console.error('[auth/reset] event log failed', e))

    const ssrClient = await createClient()
    const work = ssrClient.auth
      .resetPasswordForEmail(email, { redirectTo: safeRedirectTo, ...captchaOptions(turnstileToken) })
      .then(({ error }) => { if (error) console.error('[auth/reset] resetPasswordForEmail failed:', error.message) })
    await holdUntil(startedAt, RESPONSE_FLOOR_MS, work)
    return genericResponse()
  } catch (err: any) {
    console.error('[auth/reset] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
