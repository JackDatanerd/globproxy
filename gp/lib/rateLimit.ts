import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'

// Cloudflare's native Rate Limiting binding — declared directly in
// wrangler.jsonc (unsafe.bindings, type "ratelimit") and auto-provisioned
// by Cloudflare on deploy. Deliberately NOT a KV-based implementation:
// this app has no KV namespace today, and standing one up requires a
// manual `wrangler kv namespace create` step outside this codebase before
// a KV binding would even work. The native ratelimit binding needs no such
// out-of-band setup — it's live as soon as this is deployed.
//
// Scoped to the two unauthenticated, cheap-to-spam auth endpoints (signup,
// password reset) rather than rolled out everywhere. Every other write
// route in this app either requires an authenticated session (so abuse is
// tied to one account, which suspend-user already handles) or, like
// checkout/verify-payment, is documented as safe without it (see
// app/api/verify-payment/route.ts) because the operation is idempotent and
// re-verifies everything server-side regardless of call frequency.
//
// Fails open, not closed: if the binding isn't present (local dev outside
// wrangler, or the binding name changes) this returns null and the request
// proceeds normally rather than 500ing every request in that environment.
export type RateLimiterBinding = 'AUTH_RATE_LIMITER' | 'RESELLER_RATE_LIMITER' | 'API_RATE_LIMITER' | 'API_WRITE_RATE_LIMITER' | 'API_HISTORY_RATE_LIMITER'

export async function rateLimited(
  req: Request,
  binding: RateLimiterBinding,
  extraKey = ''
): Promise<NextResponse | null> {
  try {
    const { env } = getCloudflareContext({ async: false }) as unknown as {
      env: Record<string, { limit: (opts: { key: string }) => Promise<{ success: boolean }> } | undefined>
    }
    const limiter = env?.[binding]
    if (!limiter) return null // not running under Workers — skip rather than block

    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
    const { success } = await limiter.limit({ key: `${binding}:${ip}${extraKey ? ':' + extraKey : ''}` })

    if (!success) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again in a minute.' },
        { status: 429 }
      )
    }
    return null
  } catch (e) {
    // Never let the rate limiter itself become an outage vector.
    console.error('[rateLimit] check failed, allowing request through', e)
    return null
  }
}

// Per-API-key limiter for the public v1 API (lib/apiAuth.ts). Keyed on the
// api_keys row id rather than the caller's IP — resellers often call from
// shared egress addresses, and one noisy key shouldn't throttle another.
// Same fail-open posture as rateLimited(): a missing binding or a limiter
// error never blocks a request. Returns true when the request is allowed.
export async function allowApiRequest(
  binding: 'API_RATE_LIMITER' | 'API_WRITE_RATE_LIMITER' | 'API_HISTORY_RATE_LIMITER',
  keyId: string
): Promise<boolean> {
  try {
    const { env } = getCloudflareContext({ async: false }) as unknown as {
      env: Record<string, { limit: (opts: { key: string }) => Promise<{ success: boolean }> } | undefined>
    }
    const limiter = env?.[binding]
    if (!limiter) return true
    const { success } = await limiter.limit({ key: `${binding}:${keyId}` })
    return success
  } catch (e) {
    console.error('[rateLimit] api limiter check failed, allowing request through', e)
    return true
  }
}
