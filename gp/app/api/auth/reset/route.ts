import { createAdminClient } from '@/lib/supabase/server'
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
    const { email, redirectTo } = await req.json()
    if (!email) return NextResponse.json({ error: 'Email required' }, { status: 400 })

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
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) console.error('[auth/reset] resetPasswordForEmail failed:', error.message)

    return genericResponse()
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}