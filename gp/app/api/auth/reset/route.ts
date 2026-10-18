import { createClient, createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { verifyTurnstile } from '@/lib/turnstile'
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

// Identical response shape isn't the whole fix — wall-clock time still
// leaks which branch ran. Banned / no-account / suspended all return
// after one or two fast SELECTs; the "all clear" branch additionally
// waits on supabase.auth.resetPasswordForEmail(), a real network call
// that dispatches an email. That latency gap is itself a timing oracle
// for "does this email have an active account," same class of leak as
// auth/signup/route.ts had. Padding every exit to a shared floor
// collapses the gap from trivially measurable to buried in jitter —
// not a cryptographic guarantee, since real network latency varies, but
// the realistic bar for this mitigation.
const RESPONSE_FLOOR_MS = 1000

async function respondGeneric(startedAt: number) {
  const elapsed = Date.now() - startedAt
  if (elapsed < RESPONSE_FLOOR_MS) {
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_FLOOR_MS - elapsed))
  }
  return genericResponse()
}

export async function POST(req: Request) {
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

    // redirectTo is client-supplied. Supabase enforces its own project-level
    // redirect URL allow-list, but that's an external config, not something
    // this code can verify — pin it to our own origin here too so this
    // endpoint doesn't rely entirely on that allow-list being correctly
    // locked down. An unrecognized redirectTo is just dropped, not rejected,
    // so the response shape doesn't change either way.
    let safeRedirectTo: string | undefined
    if (redirectTo) {
      try {
        const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin
        if (new URL(redirectTo).origin === appOrigin) {
          safeRedirectTo = redirectTo
        } else {
          console.error('[auth/reset] rejected redirectTo outside app origin:', redirectTo)
        }
      } catch {
        console.error('[auth/reset] malformed redirectTo:', redirectTo)
      }
    }

    const supabase = await createAdminClient()

    // 1. Banned — don't send, don't reveal.
    const { data: banned } = await supabase
      .from('banned_emails')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle()

    if (banned) return respondGeneric(startedAt)

    // 2. No account — don't send, don't reveal.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_suspended')
      .eq('email', email.toLowerCase())
      .maybeSingle()

    if (!profile) return respondGeneric(startedAt)

    // 3. Suspended — don't send, don't reveal.
    if (profile.is_suspended) return respondGeneric(startedAt)

    // 4. All clear — send reset email. Log failures server-side only; the
    // response to the client stays generic either way.
    //
    // This MUST go through the cookie-aware ssr client, not `supabase`
    // (the service-role admin client used for the lookups above). With
    // PKCE flowType, resetPasswordForEmail() generates a code_challenge
    // and needs to persist the matching code_verifier back to *this
    // visitor's own browser* as a cookie, so it's available later when
    // they click the link and /auth/callback exchanges the code for a
    // session. The admin client is a plain @supabase/supabase-js instance
    // with no cookies to write to — server-side, its storage falls back to
    // an in-memory object that dies with this request, so no verifier ever
    // reaches the browser. Supabase then has no choice but to fall back to
    // an implicit-style link (#access_token=... in the hash), which this
    // app's client is configured to reject (flowType: 'pkce'), so the
    // update-password page saw "Auth session missing or expired" on every
    // reset, even with a fresh, unexpired link.
    const ssrClient = await createClient()
    const { error } = await ssrClient.auth.resetPasswordForEmail(email, { redirectTo: safeRedirectTo })
    if (error) console.error('[auth/reset] resetPasswordForEmail failed:', error.message)

    return respondGeneric(startedAt)
  } catch (err: any) {
    console.error('[auth/reset] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}