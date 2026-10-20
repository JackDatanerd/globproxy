import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'
import { parseIpv6 } from '@/lib/ssrfGuard'

// Cloudflare's native Rate Limiting bindings — declared directly in
// wrangler.jsonc (unsafe.bindings, type "ratelimit") and auto-provisioned
// by Cloudflare on deploy. Deliberately NOT a KV-based implementation: this
// app has no KV namespace, and the native binding needs no out-of-band
// setup — it is live as soon as it is deployed.
//
// What each binding protects (limits live in wrangler.jsonc, change both
// places together and keep /docs/api in step for the API ones):
//
//   AUTH_RATE_LIMITER         per client address, per route group — the
//                             unauthenticated and credential-handling auth
//                             endpoints (login, signup, reset, MFA, …).
//   AUTH_TARGET_RATE_LIMITER  per TARGET EMAIL, across every address — stops
//                             a distributed attacker from using signup /
//                             reset / resend to flood one victim's inbox.
//                             Deliberately NOT applied to login: a per-account
//                             login cap lets anyone lock a victim out.
//   RESELLER_RATE_LIMITER     per reseller — allocate / reclaim
//                             (app/api/reseller/*); sized so a legitimate bulk
//                             allocation isn't throttled but the endpoint can't
//                             be used as an email cannon.
//   PAYMENT_RATE_LIMITER      /api/checkout (per user) and the public
//                             /api/verify-payment (per address) — every call
//                             that reaches a real reference spends Paystack API
//                             quota shared with the reconcile cron.
//   USER_ACTION_RATE_LIMITER  per signed-in user — session-authenticated
//                             routes that spend money, create upstream
//                             resources or make our server call out.
//   USER_EMAIL_RATE_LIMITER   per signed-in user — routes that send an email
//                             to staff on every call.
//   API_RATE_LIMITER / API_WRITE_RATE_LIMITER / API_HISTORY_RATE_LIMITER
//                             per API key (public v1 API, lib/apiAuth.ts).
//   API_IP_RATE_LIMITER       per client address, applied BEFORE the key
//                             lookup so unauthenticated traffic with made-up
//                             keys cannot hammer the database for free.
//
// Fails open, not closed: if a binding isn't present (local dev outside
// wrangler, or the binding name changes) the helpers allow the request
// rather than 500ing every request in that environment.
//
// verify-payment is intentionally unthrottled: it is idempotent and
// re-verifies everything server-side (see app/api/verify-payment/route.ts).
export type RateLimiterBinding =
  | 'AUTH_RATE_LIMITER'
  | 'AUTH_TARGET_RATE_LIMITER'
  | 'RESELLER_RATE_LIMITER'
  | 'PAYMENT_RATE_LIMITER'
  | 'API_RATE_LIMITER'
  | 'API_WRITE_RATE_LIMITER'
  | 'API_HISTORY_RATE_LIMITER'
  | 'API_IP_RATE_LIMITER'
  | 'USER_ACTION_RATE_LIMITER'
  | 'USER_EMAIL_RATE_LIMITER'

type Limiter = { limit: (opts: { key: string }) => Promise<{ success: boolean }> }

// Every binding uses a 60-second period (wrangler.jsonc). The binding does
// not report when a blocked caller may retry, so Retry-After is the full
// window: telling a client to come back sooner than that just earns it
// another 429.
export const RATE_LIMIT_WINDOW_SECONDS = 60
const RETRY_AFTER = String(RATE_LIMIT_WINDOW_SECONDS)

function getLimiter(binding: RateLimiterBinding): Limiter | null {
  const { env } = getCloudflareContext({ async: false }) as unknown as {
    env: Record<string, Limiter | undefined>
  }
  return env?.[binding] ?? null
}

function tooMany(message = 'Too many requests. Please try again in a minute.'): NextResponse {
  return NextResponse.json({ error: message }, { status: 429, headers: { 'Retry-After': RETRY_AFTER } })
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The caller's address as a rate-limit key, or null when Cloudflare did not
// supply one. Two deliberate choices:
//  - IPv6 collapses to its /64. A single subscriber is handed an entire /64
//    (2^64 addresses), so keying on the full address would give an attacker
//    a fresh bucket per request. IPv4-mapped IPv6 collapses to the IPv4.
//  - A missing header returns null instead of a shared 'unknown' key. One
//    shared key would let any header-less request (or a misrouted
//    environment) spend the budget of everyone else. cf-connecting-ip is
//    always present on real traffic, so skipping is the safe direction.
export function clientKey(req: Request): string | null {
  const raw = req.headers.get('cf-connecting-ip')?.trim()
  if (!raw) return null
  if (!raw.includes(':')) return raw
  const g = parseIpv6(raw)
  if (!g) return raw
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

let warnedNoClientKey = false
function warnNoClientKey() {
  if (warnedNoClientKey) return
  warnedNoClientKey = true
  console.warn('[rateLimit] request has no cf-connecting-ip — per-address limits are being skipped for it')
}

// Per client address (+ an optional route-group discriminator). Returns the
// 429 response to send, or null when the request may proceed.
export async function rateLimited(
  req: Request,
  binding: RateLimiterBinding,
  extraKey = ''
): Promise<NextResponse | null> {
  try {
    const limiter = getLimiter(binding)
    if (!limiter) return null // not running under Workers — skip rather than block

    const ip = clientKey(req)
    if (!ip) {
      warnNoClientKey()
      return null
    }
    const { success } = await limiter.limit({ key: `${binding}:${ip}${extraKey ? ':' + extraKey : ''}` })
    return success ? null : tooMany()
  } catch (e) {
    // Never let the rate limiter itself become an outage vector.
    console.error('[rateLimit] check failed, allowing request through', e)
    return null
  }
}

// Per target email, across all callers. Call it once the email is known
// (after the body is parsed). The response is identical whether or not an
// account exists for that address, so it cannot be used to probe for one.
export async function rateLimitedTarget(scope: string, email: unknown): Promise<NextResponse | null> {
  try {
    if (typeof email !== 'string') return null
    const target = email.trim().toLowerCase()
    if (!target) return null
    const limiter = getLimiter('AUTH_TARGET_RATE_LIMITER')
    if (!limiter) return null
    const { success } = await limiter.limit({ key: `AUTH_TARGET_RATE_LIMITER:${scope}:${(await sha256Hex(target)).slice(0, 32)}` })
    return success ? null : tooMany('Too many requests for this email address. Please try again in a minute.')
  } catch (e) {
    console.error('[rateLimit] target check failed, allowing request through', e)
    return null
  }
}

// Per signed-in user, independent of address (a user hopping between
// addresses is still one user). `scope` names the route so unrelated routes
// do not drain each other's budget.
export async function rateLimitedUser(
  binding: 'USER_ACTION_RATE_LIMITER' | 'USER_EMAIL_RATE_LIMITER',
  userId: string,
  scope: string
): Promise<NextResponse | null> {
  try {
    const limiter = getLimiter(binding)
    if (!limiter) return null
    const { success } = await limiter.limit({ key: `${binding}:${scope}:${userId}` })
    return success ? null : tooMany()
  } catch (e) {
    console.error('[rateLimit] user check failed, allowing request through', e)
    return null
  }
}

// Per-API-key limiter for the public v1 API (lib/apiAuth.ts). Keyed on the
// api_keys row id rather than the caller's IP — resellers often call from
// shared egress addresses, and one noisy key shouldn't throttle another.
// Returns true when the request is allowed.
export async function allowApiRequest(
  binding: 'API_RATE_LIMITER' | 'API_WRITE_RATE_LIMITER' | 'API_HISTORY_RATE_LIMITER',
  keyId: string
): Promise<boolean> {
  try {
    const limiter = getLimiter(binding)
    if (!limiter) return true
    const { success } = await limiter.limit({ key: `${binding}:${keyId}` })
    return success
  } catch (e) {
    console.error('[rateLimit] api limiter check failed, allowing request through', e)
    return true
  }
}

// Pre-authentication ceiling per client address for the v1 API. The budget
// (6000/min, see wrangler.jsonc) is far above anything a legitimate
// integration sends — resellers share egress addresses across many keys, each
// allowed 120/min — so it must stay generous; it only exists to bound how many
// database lookups a caller can cause with invalid keys.
export async function allowApiClient(req: Request): Promise<boolean> {
  try {
    const limiter = getLimiter('API_IP_RATE_LIMITER')
    if (!limiter) return true
    const ip = clientKey(req)
    if (!ip) {
      warnNoClientKey()
      return true
    }
    const { success } = await limiter.limit({ key: `API_IP_RATE_LIMITER:${ip}` })
    return success
  } catch (e) {
    console.error('[rateLimit] api client check failed, allowing request through', e)
    return true
  }
}
