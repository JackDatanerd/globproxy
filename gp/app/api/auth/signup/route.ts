import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { recordReferralSignup } from '@/lib/referrals'
import { validatePassword } from '@/lib/passwordPolicy'
import { verifyTurnstile } from '@/lib/turnstile'
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
// Raised from 700: a real signUp() (which dispatches an email) routinely
// takes longer than 700ms, so the old floor sat BELOW the slow branch and
// the timing oracle survived.
const RESPONSE_FLOOR_MS = 1500

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
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'signup')
    if (limited) return limited

    const body = await req.json().catch(() => ({}))
    const { email, password, emailRedirectTo, referral_code, turnstileToken } = body
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    // Server-side password policy — the form's minLength is only a hint.
    const policy = validatePassword(password, email)
    if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: 400 })

    // Free-text / enum metadata gets normalised instead of stored as sent.
    const full_name = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 100) : ''
    const intended_role = body.intended_role === 'reseller' ? 'reseller' : undefined

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
      .eq('email', email.trim().toLowerCase())
      .maybeSingle()

    if (banned) return respondGeneric(startedAt)

    // 2. Already registered — don't attempt signup again (Supabase would
    // just error), don't reveal that an account exists either. Whether
    // suspended, active, OR PREVIOUSLY DELETED, the response is identical.
    //
    // Checks auth.users (via auth_email_exists, migration 0029) rather
    // than profiles.email. Deletion (app/api/user/delete-account,
    // app/api/admin/delete-user) overwrites profiles.email with the
    // literal '[deleted]' placeholder but leaves the real auth.users row
    // in place (banned, not hard-deleted — see delete-account/route.ts).
    // A profiles.email-only check stops matching the real address the
    // moment an account is deleted, silently falling through to branch 3
    // below and re-invoking supabase.auth.signUp() against a dormant
    // identity that was never meant to be reachable again.
    const { data: emailExists } = await supabase.rpc('auth_email_exists', {
      check_email: email.trim().toLowerCase(),
    })

    if (emailExists) {
      // An address that signed up but never confirmed (email in spam, link
      // lost) used to be a dead end: this branch answered "check your
      // email" and sent nothing, so the visitor waited forever. Quietly
      // re-send the confirmation in that case. The response is identical
      // either way, so nothing about the account's state leaks.
      const { data: unconfirmed } = await supabase.rpc('auth_email_unconfirmed', {
        check_email: email.trim().toLowerCase(),
      })
      if (unconfirmed) {
        const ssr = await createClient()
        const { error: resendErr } = await ssr.auth.resend({
          type: 'signup',
          email: email.trim().toLowerCase(),
          options: { emailRedirectTo: safeEmailRedirectTo },
        })
        if (resendErr) console.error('[auth/signup] resend for unconfirmed account failed:', resendErr.message)
      }
      return respondGeneric(startedAt)
    }

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
    const { data, error } = await ssrClient.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name, intended_role },
        emailRedirectTo: safeEmailRedirectTo,
      }
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    // Best-effort referral attribution — signUp() already returns the new
    // user's id even though email confirmation is still pending, so this
    // doesn't need to wait for /auth/callback. Never allowed to affect
    // this response either way: see recordReferralSignup's doc comment.
    if (data.user?.id) {
      await recordReferralSignup(supabase, referral_code, data.user.id)
    }

    return respondGeneric(startedAt)
  } catch (err: any) {
    console.error('[auth/signup] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}