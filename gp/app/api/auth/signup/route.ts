import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Always the same response shape for "banned", "already registered", and
// "brand new" — matching the pattern in app/api/auth/reset/route.ts.
// Previously this endpoint returned a distinct 409 { existing: true } for
// already-registered emails, which let anyone enumerate which emails have
// GlobProxy accounts just by posting to this endpoint. An attacker
// scripting requests against this endpoint now gets the identical
// response body every time, whichever branch actually ran.
function genericResponse() {
  return NextResponse.json({
    success: true,
    message: 'Check your email to confirm your account.',
  })
}

// Response *shape* being identical isn't the whole fix — wall-clock time
// still leaks which branch ran. The banned/already-registered branches
// return after one or two fast SELECTs; the brand-new-signup branch
// additionally waits on supabase.auth.signUp(), which dispatches a real
// email over the network and is meaningfully slower. That latency gap is
// itself an enumeration oracle, just a timing one instead of a
// status-code one. RESPONSE_FLOOR_MS pads every exit out to a shared
// minimum so total request time doesn't reveal which path was taken.
// It's an approximation (real network latency for signUp varies), not a
// cryptographic guarantee — but it collapses the gap from "trivially
// measurable" to "buried in normal jitter," which is what this class of
// mitigation can realistically promise.
const RESPONSE_FLOOR_MS = 700

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

    if (banned) return respondGeneric(startedAt)

    // 2. Already registered — don't attempt signup again (Supabase would
    // just error), don't reveal that an account exists either. Whether
    // suspended or active, the response is identical.
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email.toLowerCase())
      .single()

    if (profile) return respondGeneric(startedAt)

    // 3. All clear — sign up via Supabase. Errors here (weak password,
    // provider-side validation) are still surfaced directly since they're
    // about the input just submitted, not about whether this email has an
    // account — same distinction auth/reset draws for its own failures.
    //
    // This MUST go through the cookie-aware ssr client (`ssrClient` below),
    // not `supabase` (the service-role admin client used for the lookups
    // above). The confirmation email's link uses PKCE (this app's default
    // flowType everywhere else), which requires a code_verifier to be
    // generated and handed back to *this visitor's own browser* as a
    // cookie at signUp() time, so it's still there when they later click
    // the link and /auth/callback exchanges the code for a session.
    // The admin client has no `window`/cookies to write to — it's a plain
    // @supabase/supabase-js instance running server-side with an in-memory
    // storage fallback, so any code_verifier it generates dies with this
    // request and is never sent to the browser. Confirmation links signed
    // that way permanently fail exchangeCodeForSession() at
    // /auth/callback, which was landing everyone back on
    // /auth/login?error=link_expired instead of /dashboard.
    const ssrClient = await createClient()
    const { error } = await ssrClient.auth.signUp({
      email,
      password,
      options: {
        data: { full_name, intended_role },
        emailRedirectTo: safeEmailRedirectTo,
      }
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return respondGeneric(startedAt)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}