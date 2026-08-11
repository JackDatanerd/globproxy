import { createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Always the same response shape for "banned", "already registered", and
// "brand new" — matching the pattern in app/api/auth/reset/route.ts.
// Previously this endpoint returned a distinct 409 { existing: true } for
// already-registered emails, which let anyone enumerate which emails have
// GlobProxy accounts just by posting to this endpoint. The frontend still
// gets a real "already registered" hint (see below) but only for genuine
// registered-and-confirmed accounts trying to sign up while logged out
// through the normal flow — an attacker scripting requests against this
// endpoint gets the identical generic response every time.
function genericResponse() {
  return NextResponse.json({
    success: true,
    message: 'Check your email to confirm your account.',
  })
}

export async function POST(req: Request) {
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER')
    if (limited) return limited

    const { email, password, full_name, intended_role, emailRedirectTo } = await req.json()
    if (!email || !password) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

    // emailRedirectTo is client-supplied. Supabase enforces its own
    // project-level redirect URL allow-list, but mirror the same
    // origin-pinning defense-in-depth used in app/api/auth/reset/route.ts
    // rather than relying on that external config alone.
    let safeEmailRedirectTo: string | undefined
    if (emailRedirectTo) {
      try {
        const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin
        if (new URL(emailRedirectTo).origin === appOrigin) {
          safeEmailRedirectTo = emailRedirectTo
        } else {
          console.error('[auth/signup] rejected emailRedirectTo outside app origin:', emailRedirectTo)
        }
      } catch {
        console.error('[auth/signup] malformed emailRedirectTo:', emailRedirectTo)
      }
    }

    // Was previously only enforced client-side in app/auth/signup/page.tsx,
    // which anyone posting to this endpoint directly could skip entirely.
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const supabase = await createAdminClient()

    // 1. Banned — don't create an account, don't reveal the email is banned.
    const { data: banned } = await supabase
      .from('banned_emails')
      .select('id')
      .eq('email', email.toLowerCase())
      .single()

    if (banned) return genericResponse()

    // 2. Already registered — don't attempt signup again (Supabase would
    // just error), don't reveal that an account exists either. Whether
    // suspended or active, the response is identical.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email.toLowerCase())
      .single()

    if (profile) return genericResponse()

    // 3. All clear — sign up via Supabase. Errors here (weak password,
    // provider-side validation) are still surfaced directly since they're
    // about the input just submitted, not about whether this email has an
    // account — same distinction auth/reset draws for its own failures.
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name, intended_role },
        emailRedirectTo: safeEmailRedirectTo,
      }
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return genericResponse()
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}