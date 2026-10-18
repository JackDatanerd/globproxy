// Cloudflare Turnstile verification for the unauthenticated auth endpoints.
//
// Opt-in by configuration: if TURNSTILE_SECRET_KEY is not set, verification
// is skipped (so deploying this code without the keys changes nothing). Once
// the secret IS set, a missing/invalid token is a hard failure.
//
// Setup: create a Turnstile widget in the Cloudflare dashboard, then set
//   TURNSTILE_SECRET_KEY            (server secret)
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY  (public; inlined at build time)
export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY
}

export async function verifyTurnstile(req: Request, token: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  if (!secret) return { ok: true }
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: 'Please complete the human-verification check and try again.' }
  }
  try {
    const body = new URLSearchParams({ secret, response: token })
    const ip = req.headers.get('cf-connecting-ip')
    if (ip) body.set('remoteip', ip)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean }
    if (!data.success) return { ok: false, error: 'Human-verification failed. Please try again.' }
    return { ok: true }
  } catch (e) {
    console.error('[turnstile] siteverify request failed', e)
    return { ok: false, error: 'Could not run the human-verification check. Please try again.' }
  }
}
