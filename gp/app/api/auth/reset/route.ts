import { createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
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

export async function POST(req: Request) {
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER')
    if (limited) return limited

    const { email, redirectTo } = await req.json()
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })

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
      .single()

    if (banned) return genericResponse()

    // 2. No account — don't send, don't reveal.
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_suspended')
      .eq('email', email.toLowerCase())
      .single()

    if (!profile) return genericResponse()

    // 3. Suspended — don't send, don't reveal.
    if (profile.is_suspended) return genericResponse()

    // 4. All clear — send reset email. Log failures server-side only; the
    // response to the client stays generic either way.
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: safeRedirectTo })
    if (error) console.error('[auth/reset] resetPasswordForEmail failed:', error.message)

    return genericResponse()
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}