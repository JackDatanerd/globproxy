import { createClient, createAdminClient } from '@/lib/supabase/server'
import { validateEmail } from '@/lib/email-validation'
import { rateLimited } from '@/lib/rateLimit'
import { recordReferralSignup } from '@/lib/referrals'
import { REF_COOKIE, REF_SUB_COOKIE, readCookie, hashIp } from '@/lib/referralAttribution'
import { validatePasswordStrict } from '@/lib/passwordPolicy'
import { verifyTurnstile, captchaOptions } from '@/lib/turnstile'
import { holdUntil } from '@/lib/constantTime'
import { sameOriginUrl } from '@/lib/appUrl'
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
// still leaks which branch ran (the brand-new branch waits on signUp(), a real
// network call that dispatches an email). Padding fast branches to a fixed
// floor only works while the floor sits ABOVE the slow branch, which no
// constant can promise. holdUntil() also CAPS the slow branch at the same
// floor (the work keeps running via waitUntil), so every branch answers after
// about RESPONSE_FLOOR_MS whether or not the email call has finished.
const RESPONSE_FLOOR_MS = 1800

export async function POST(req: Request) {
  const startedAt = Date.now()
  try {
    const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'signup')
    if (limited) return limited

    const body = await req.json().catch(() => ({}))
    const { email, password, emailRedirectTo, referral_code, sub_id, turnstileToken } = body
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
    }

    const human = await verifyTurnstile(req, turnstileToken)
    if (!human.ok) return NextResponse.json({ error: human.error }, { status: 400 })

    // Server-side password policy — the form's minLength is only a hint.
    const policy = await validatePasswordStrict(password, email)
    if (!policy.ok) return NextResponse.json({ error: policy.error }, { status: 400 })

    // Free-text / enum metadata gets normalised instead of stored as sent.
    const full_name = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 100) : ''
    const intended_role = body.intended_role === 'reseller' ? 'reseller' : undefined

    // emailRedirectTo is client-supplied. Supabase enforces its own
    // project-level redirect URL allow-list, but mirror the same
    // origin-pinning defense-in-depth used in app/api/auth/reset/route.ts
    // rather than relying on that external config alone.
    const safeEmailRedirectTo = sameOriginUrl(emailRedirectTo)
    if (emailRedirectTo && !safeEmailRedirectTo) console.error('[auth/signup] rejected emailRedirectTo outside app origin:', emailRedirectTo)

    // Was previously only enforced client-side in app/auth/signup/page.tsx,
    // which anyone posting to this endpoint directly could skip entirely.
    const { valid, error: emailError } = validateEmail(email)
    if (!valid) return NextResponse.json({ error: emailError }, { status: 400 })

    const supabase = await createAdminClient()

    // 1. Banned (plus-address aware: bad+1@x.com matches a ban on bad@x.com).
    // The same rule is enforced by a BEFORE INSERT trigger on auth.users
    // (migration 0043), so a signup that skips this route is refused too.
    const normalized = email.trim().toLowerCase()
    const { data: banned } = await supabase.rpc('is_email_banned', { check_email: normalized })
    if (banned) {
      await holdUntil(startedAt, RESPONSE_FLOOR_MS)
      return genericResponse()
    }

    // 2. Already registered — don't attempt signup again, don't reveal that
    // an account exists either. Whether suspended, active, OR PREVIOUSLY
    // DELETED, the response is identical. Checks auth.users (via
    // auth_email_exists, migration 0029) rather than profiles.email, because
    // deletion overwrites profiles.email with '[deleted]' but leaves the real
    // auth.users row (banned, not hard-deleted).
    const { data: emailExists } = await supabase.rpc('auth_email_exists', { check_email: normalized })

    if (emailExists) {
      // An address that signed up but never confirmed (email in spam, link
      // lost) used to be a dead end, so the confirmation is re-sent. But the
      // password on that unconfirmed account was chosen by WHOEVER FIRST
      // typed this address — possibly someone who isn't its owner
      // (pre-hijacking: register the victim's address with a password you
      // know, wait for them to click the link). So the newest signup wins:
      // the stored password and metadata are replaced with what was just
      // submitted before the link goes out. An unconfirmed account can't be
      // used to sign in, so nothing is lost by replacing it.
      const { data: unconfirmedId } = await supabase.rpc('auth_unconfirmed_user_id', { check_email: normalized })
      if (unconfirmedId) {
        const { error: updErr } = await supabase.auth.admin.updateUserById(unconfirmedId as string, {
          password,
          user_metadata: { full_name, intended_role },
        })
        if (updErr) {
          // Never send a confirmation for an account whose password we couldn't take over.
          console.error('[auth/signup] could not refresh unconfirmed account — not re-sending', updErr.message)
        } else {
          const ssr = await createClient()
          const work = (async () => {
            // signUp() on an unconfirmed address re-sends the confirmation AND
            // (unlike resend()) starts a PKCE flow, so the link can sign the
            // visitor straight in from this same browser.
            const { error: signErr } = await ssr.auth.signUp({
              email: normalized, password,
              options: { data: { full_name, intended_role }, emailRedirectTo: safeEmailRedirectTo, ...captchaOptions(turnstileToken) },
            })
            if (signErr) {
              console.error('[auth/signup] re-signup for unconfirmed account failed, falling back to resend:', signErr.message)
              const { error: resendErr } = await ssr.auth.resend({ type: 'signup', email: normalized, options: { emailRedirectTo: safeEmailRedirectTo } })
              if (resendErr) console.error('[auth/signup] resend for unconfirmed account failed:', resendErr.message)
            }
          })()
          await holdUntil(startedAt, RESPONSE_FLOOR_MS, work)
          return genericResponse()
        }
      }
      await holdUntil(startedAt, RESPONSE_FLOOR_MS)
      return genericResponse()
    }

    // 3. All clear — sign up via Supabase.
    //
    // This MUST go through the cookie-aware ssr client, not `supabase` (the
    // service-role admin client used for the lookups above): the PKCE
    // code_verifier has to be handed back to THIS visitor's browser as a
    // cookie at signUp() time so /auth/callback can exchange the code later.
    //
    // Errors are NOT echoed to the visitor any more: with the database-level
    // signup policy (ban list, disposable domains) a rejected insert comes
    // back from GoTrue as an error, and echoing it would reveal which
    // addresses are banned. Input problems (password policy, email format)
    // were already rejected with specific messages above. The one failure a
    // visitor can act on — the email provider's own rate limit — is surfaced.
    const ssrClient = await createClient()
    const work = (async () => {
      const { data, error } = await ssrClient.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { full_name, intended_role },
          emailRedirectTo: safeEmailRedirectTo,
          ...captchaOptions(turnstileToken),
        },
      })
      if (error) {
        console.error('[auth/signup] signUp failed:', error.status, error.message)
        return { rateLimited: error.status === 429 }
      }
      // Best-effort referral attribution — never allowed to affect the response.
      if (data.user?.id) {
        // Body value wins (the explicit code shown/typed on the form); the
        // first-party cookie set by /r/[code] and <RefCapture/> covers visitors
        // who browsed around before signing up. A non-string is rejected inside
        // the helper instead of throwing after the account already exists.
        const cookieHeader = req.headers.get('cookie')
        await recordReferralSignup(
          supabase,
          referral_code ?? readCookie(cookieHeader, REF_COOKIE),
          data.user.id,
          {
            subId: sub_id ?? readCookie(cookieHeader, REF_SUB_COOKIE),
            ipHash: hashIp(req.headers.get('cf-connecting-ip')),
          }
        )
      }
      return { rateLimited: false }
    })()

    const result = await holdUntil(startedAt, RESPONSE_FLOOR_MS, work)
    if (result?.rateLimited) {
      return NextResponse.json({ error: 'We are sending a lot of emails right now. Please try again in a few minutes.' }, { status: 429 })
    }
    return genericResponse()
  } catch (err: any) {
    console.error('[auth/signup] unexpected error', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
