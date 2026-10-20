// Cloudflare Turnstile verification for the unauthenticated auth endpoints.
//
// Opt-in by configuration: with nothing set, verification is skipped (so
// deploying this code without the keys changes nothing). Two ways to turn it on:
//
//  A) Server-side siteverify (this file calls Cloudflare itself):
//       TURNSTILE_SECRET_KEY            server secret (Worker secret)
//       NEXT_PUBLIC_TURNSTILE_SITE_KEY  public; inlined into the bundle at BUILD time
//     BOTH are required, because they live in different places. The site key is
//     baked in at build (see .github/workflows/deploy.yml); the secret is set on
//     the Worker. If only the secret were present the browser would never render
//     the widget, so verification would reject every login, signup and reset for
//     every visitor. That lockout is worse than the missing bot check, so a lone
//     secret is logged loudly and Turnstile stays off until the site key is built in.
//
//  B) Supabase-native CAPTCHA (see supabaseCaptchaEnabled below).
export function turnstileEnabled(): boolean {
  if (supabaseCaptchaEnabled()) return true
  return !!process.env.TURNSTILE_SECRET_KEY && !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
}

// Supabase-native CAPTCHA ("Authentication → Attack Protection → CAPTCHA",
// provider Turnstile). Our API routes are NOT the only way into GoTrue — the
// anon key is public, so anyone can call /signup, /token and /recover
// directly and skip every check in this file. Turning on Supabase's own
// CAPTCHA closes that: GoTrue then verifies a token on those calls itself.
//
// A Turnstile token is single-use, so when this flag is on the routes do NOT
// call siteverify themselves (that would burn the token before GoTrue sees
// it); they forward the token to Supabase instead (captchaOptions below) and
// let GoTrue be the one verifier.
//
//   SUPABASE_CAPTCHA_ENABLED=true   (set together with the dashboard toggle)
export function supabaseCaptchaEnabled(): boolean {
  return process.env.SUPABASE_CAPTCHA_ENABLED === 'true'
}

/** Spread into the `options` of signUp / signInWithPassword / resetPasswordForEmail / resend. */
export function captchaOptions(token: unknown): { captchaToken?: string } {
  return supabaseCaptchaEnabled() && typeof token === 'string' && token ? { captchaToken: token } : {}
}

let warnedMissingSiteKey = false
function warnMissingSiteKey(mode: string) {
  if (warnedMissingSiteKey) return
  warnedMissingSiteKey = true
  console.error(
    `[turnstile] ${mode} is configured but NEXT_PUBLIC_TURNSTILE_SITE_KEY was not present at build time — ` +
      'the widget cannot render in the browser. Set NEXT_PUBLIC_TURNSTILE_SITE_KEY as a GitHub secret and redeploy.'
  )
}

export async function verifyTurnstile(req: Request, token: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (supabaseCaptchaEnabled()) {
    if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) warnMissingSiteKey('SUPABASE_CAPTCHA_ENABLED')
    // GoTrue verifies the token itself; we only insist that one was supplied.
    if (typeof token !== 'string' || !token) {
      return { ok: false, error: 'Please complete the human-verification check and try again.' }
    }
    return { ok: true }
  }
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return { ok: true }
  if (!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    // Verification is SKIPPED here, deliberately — see the header comment.
    warnMissingSiteKey('TURNSTILE_SECRET_KEY')
    return { ok: true }
  }
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: 'Please complete the human-verification check and try again.' }
  }
  try {
    const body = new URLSearchParams({ secret, response: token })
    const ip = req.headers.get('cf-connecting-ip')
    if (ip) body.set('remoteip', ip)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
      // Bounded: this sits on the login / signup / reset path, and an
      // unanswered siteverify call used to hang the request until the Worker
      // itself gave up.
      signal: AbortSignal.timeout(5000),
    })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean }
    if (!data.success) return { ok: false, error: 'Human-verification failed. Please try again.' }
    return { ok: true }
  } catch (e) {
    console.error('[turnstile] siteverify request failed', e)
    return { ok: false, error: 'Could not run the human-verification check. Please try again.' }
  }
}
