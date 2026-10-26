import { createAdminClient } from '@/lib/supabase/server'
import { allowApiRequest, allowApiClient, RATE_LIMIT_WINDOW_SECONDS } from '@/lib/rateLimit'
import { ipAllowed, allocateAllowlistProblem } from '@/lib/ipAllowlist'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'
import { isCrossSiteRequest } from '@/lib/appUrl'

// Shared gate for every app/api/v1/* route.
//
// Bearer tokens are real API keys (api_keys table, migration 0005): the
// SHA-256 of the presented token is looked up there. Keys carry optional
// scopes ('read' = GET only, 'write' = create/modify sub-users, webhooks and
// the like — migration 0042; 'allocate' = move bandwidth between accounts —
// migration 0054), an
// optional expiry, and are rate limited per key.
export type ApiScope = 'read' | 'write' | 'allocate'

export type ApiKeyInfo = { id: string; scopes: string[] }

export type ApiAuthResult =
  | {
      ok: true
      user: { id: string; email?: string }
      supabase: Awaited<ReturnType<typeof createAdminClient>>
      key: ApiKeyInfo
    }
  | { ok: false; response: NextResponse }

// Machine-readable error codes. Every v1 error body is
// { error: <human message>, code: <one of these> }.
export type ApiErrorCode =
  | 'unauthorized'
  | 'account_suspended'
  | 'reseller_required'
  | 'api_access_disabled'
  | 'insufficient_scope'
  | 'ip_not_allowed'
  | 'rate_limited'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'insufficient_bandwidth'
  | 'forbidden'
  | 'upstream_unavailable'
  | 'service_unavailable'
  | 'idempotency_conflict'
  | 'payload_too_large'
  | 'internal_error'

// A Response body can only be consumed once, so this must build a fresh
// NextResponse per call — a module-level instance reused across requests in
// a long-lived Workers isolate comes back with an empty body after the first
// 401 is serialized.
export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: Record<string, string>
): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers })
}

function unauthorized() {
  return apiError(401, 'unauthorized', 'Unauthorized')
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Rejects deleted/suspended accounts on any route that writes on a
// logged-in user's behalf. middleware.ts only signs a suspended user out on
// page navigation and excludes /api, so an unexpired session token for a
// suspended or since-deleted account would otherwise keep working.
export async function requireActiveUser(userId: string): Promise<NextResponse | null> {
  const supabase = await createAdminClient()
  const { data, error } = await supabase.from('profiles').select('is_suspended, is_deleted').eq('id', userId).maybeSingle()
  // Fail CLOSED: a failed or empty lookup used to read as "active" (every
  // check below is `data?.x`), so a transient DB error let suspended and
  // deleted accounts straight through on the routes that rely on this.
  if (error || !data) {
    console.error('[requireActiveUser] profile lookup failed — failing closed', userId, error?.message)
    return NextResponse.json({ error: 'Could not verify your account right now. Please try again.' }, { status: 503 })
  }
  if (data?.is_deleted) {
    return NextResponse.json({ error: 'This account no longer exists.' }, { status: 403 })
  }
  if (data?.is_suspended) {
    return NextResponse.json(
      { error: 'This account has been suspended. Contact support@globproxy.com.' },
      { status: 403 }
    )
  }
  return null
}

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i
// Cheap shape check run before any database work: right prefix, then at
// least 16 and at most 128 non-space characters. Deliberately much looser than
// the format keys are minted in (gp_live_ + 48 hex) — it only turns away
// obviously malformed values without any risk of rejecting a real key. The
// per-address limiter (allowApiClient) is what actually bounds invalid-key
// traffic.
const TOKEN_SHAPE_RE = /^gp_live_\S{16,128}$/
const LAST_USED_WRITE_INTERVAL_MS = 60_000

function requiredScope(method: string): ApiScope {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write'
}

function hasScope(scopes: string[], needed: ApiScope): boolean {
  // 'write' is a superset of 'read'.
  // 'allocate' is deliberately NOT implied by 'write' (and implies nothing):
  // moving stock between accounts is its own grant.
  if (needed === 'read') return scopes.includes('read') || scopes.includes('write')
  return scopes.includes(needed)
}

// The per-key limits (wrangler.jsonc). Exported so the 429 bodies, the
// X-RateLimit-Limit header and the docs cannot disagree with each other.
export const API_RATE_LIMIT_PER_MIN = 120
export const API_WRITE_RATE_LIMIT_PER_MIN = 30

// The limiter works in fixed windows and cannot say how much of the current one
// is left, so the honest Retry-After is the whole window.
export function rateLimitHeaders(limit: number): Record<string, string> {
  return { 'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS), 'X-RateLimit-Limit': String(limit) }
}

// Refusals of a key that DID match a real row (revoked, expired, wrong IP, wrong scope)
// used to leave no trace at all: api_request_log only held calls that were let through,
// so a leaked key being probed from elsewhere was invisible to its owner. They are now
// recorded (status 401/403) in the same log the dashboard's "Activity" and
// GET /api/v1/account/activity read. Best-effort, off the response path, and capped at
// one row per key per minute per Worker isolate so a flood of refusals can't flood the
// table. Unknown keys are never logged — there is no account to attribute them to.
const DENIED_LOG_INTERVAL_MS = 60_000
const deniedLoggedAt = new Map<string, number>()

function logDeniedKeyUse(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  key: { id: string; user_id: string }, req: Request, status: number
) {
  const now = Date.now()
  const last = deniedLoggedAt.get(key.id) ?? 0
  if (now - last < DENIED_LOG_INTERVAL_MS) return
  if (deniedLoggedAt.size > 2000) deniedLoggedAt.clear()
  deniedLoggedAt.set(key.id, now)
  let path = ''
  try { path = new URL(req.url).pathname.slice(0, 300) } catch { /* leave empty */ }
  const write = Promise.resolve(
    supabase.from('api_request_log').insert({
      user_id: key.user_id, key_id: key.id, method: req.method, path, status,
      ip: req.headers.get('cf-connecting-ip'), request_id: null,
    })
  ).then(() => {}, () => {})
  try { getCloudflareContext({ async: false }).ctx.waitUntil(write) } catch { /* not in Workers — it just runs */ }
}

// `opts.scope` overrides the default (GET/HEAD → read, everything else →
// write) for the rare route where the HTTP method doesn't say it.
export async function requireApiAccess(req: Request, opts: { scope?: ApiScope } = {}): Promise<ApiAuthResult> {
  // Everything is wrapped: this is the choke point for every v1 route, and
  // an unhandled exception here used to crash the Worker (Cloudflare 1101)
  // for every endpoint at once.
  try {
    const match = req.headers.get('authorization')?.match(BEARER_RE)
    const token = match?.[1]
    if (!token || !TOKEN_SHAPE_RE.test(token)) {
      return { ok: false, response: unauthorized() }
    }

    // Per-address ceiling BEFORE the key lookup. Every lookup below is a
    // service-role database query, and the per-key limiters further down only
    // apply once a key is known to be valid — so without this, a caller
    // sending made-up keys could drive unlimited queries.
    if (!(await allowApiClient(req))) {
      return {
        ok: false,
        response: apiError(429, 'rate_limited', 'Too many requests from this address. Retry after the Retry-After interval.', {
          'Retry-After': String(RATE_LIMIT_WINDOW_SECONDS),
        }),
      }
    }

    const supabase = await createAdminClient()
    const key_hash = await sha256Hex(token)
    const { data: apiKey, error: keyErr } = await supabase
      .from('api_keys')
      .select('id, user_id, revoked_at, expires_at, scopes, allowed_ips, last_used_at')
      .eq('key_hash', key_hash)
      .single()

    // .single() reports "no rows" as an error object (PGRST116), not a throw.
    // Anything else is unexpected → falls to the catch's 500 instead of being
    // silently treated as "no such key".
    if (keyErr && keyErr.code !== 'PGRST116') throw keyErr
    if (!apiKey) {
      return { ok: false, response: unauthorized() }
    }
    if (apiKey.revoked_at) {
      logDeniedKeyUse(supabase, apiKey, req, 401)
      return { ok: false, response: unauthorized() }
    }
    // Same 401 as revoked/unknown on purpose: the body must not let a holder
    // of a leaked key probe the account's key history.
    if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
      logDeniedKeyUse(supabase, apiKey, req, 401)
      return { ok: false, response: unauthorized() }
    }

    // Optional per-key source-IP allowlist (empty = any IP). Checked before
    // rate limiting / account lookups so a key used from the wrong place
    // costs nothing. Cloudflare sets cf-connecting-ip; it can't be spoofed
    // by the client at the edge.
    if (!ipAllowed(apiKey.allowed_ips as string[] | null, req.headers.get('cf-connecting-ip'))) {
      logDeniedKeyUse(supabase, apiKey, req, 403)
      return { ok: false, response: apiError(403, 'ip_not_allowed', 'This API key is restricted to specific IP addresses and this request did not come from one of them.') }
    }

    const scopes: string[] = Array.isArray(apiKey.scopes) ? apiKey.scopes : ['read', 'write']
    const needed = opts.scope ?? requiredScope(req.method)
    if (!hasScope(scopes, needed)) {
      logDeniedKeyUse(supabase, apiKey, req, 403)
      return {
        ok: false,
        response: apiError(
          403, 'insufficient_scope',
          needed === 'allocate'
            ? 'This endpoint requires an API key with the "allocate" scope.'
            : `This API key is read-only. A key with the "write" scope is required for ${req.method} requests.`
        ),
      }
    }
    // Allocation keys can move bandwidth between accounts, and API keys skip
    // the 2FA step-up the dashboard enforces — so they must be pinned to the
    // caller's own servers.
    // ...and the pin must actually be narrow (no /8 "restrictions"): this is also
    // checked when a key is created or edited, but keys made before that rule
    // existed are held to it here.
    const keyIps = apiKey.allowed_ips as string[] | null
    if (needed === 'allocate') {
      const problem = allocateAllowlistProblem(keyIps)
      if (problem) return { ok: false, response: apiError(403, 'insufficient_scope', problem) }
    }

    // Per-key limits, checked after the key is known-valid (cheap, no profile
    // lookup wasted on a throttled caller) but before any real work.
    if (!(await allowApiRequest('API_RATE_LIMITER', apiKey.id))) {
      return { ok: false, response: apiError(429, 'rate_limited', `Rate limit exceeded (${API_RATE_LIMIT_PER_MIN} requests/minute per key). Retry after the Retry-After interval.`, rateLimitHeaders(API_RATE_LIMIT_PER_MIN)) }
    }
    if (needed !== 'read' && !(await allowApiRequest('API_WRITE_RATE_LIMITER', apiKey.id))) {
      return { ok: false, response: apiError(429, 'rate_limited', `Write rate limit exceeded (${API_WRITE_RATE_LIMIT_PER_MIN} mutating requests/minute per key). Retry after the Retry-After interval.`, rateLimitHeaders(API_WRITE_RATE_LIMIT_PER_MIN)) }
    }

    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('id, email, role, api_access, is_suspended, is_deleted')
      .eq('id', apiKey.user_id)
      .single()

    // A transient database error is NOT "this key is bad". It used to fall
    // through to a 401, which sends well-behaved clients off to delete or
    // re-issue a perfectly good key. Only a genuinely missing profile row
    // (PGRST116) means unauthorized.
    if (profileErr && profileErr.code !== 'PGRST116') {
      console.error('[requireApiAccess] profile lookup failed', profileErr.code, profileErr.message)
      return { ok: false, response: apiError(503, 'service_unavailable', 'Could not verify your account right now. Please retry shortly.', { 'Retry-After': '5' }) }
    }
    if (!profile) {
      return { ok: false, response: unauthorized() }
    }

    // Deleted accounts: treated as unauthorized, not 403 — there's no account
    // left to be "forbidden" for. Deletion also revokes the account's keys
    // (migration 0030 + delete routes); this is the backstop.
    if (profile.is_deleted) {
      return { ok: false, response: unauthorized() }
    }

    if (profile.is_suspended) {
      return { ok: false, response: apiError(403, 'account_suspended', 'This account has been suspended. Contact support@globproxy.com.') }
    }

    if (profile.role === 'user') {
      return {
        ok: false,
        response: apiError(403, 'reseller_required', 'API access is available to resellers. See globproxy.com/#reseller to apply.'),
      }
    }

    if (!profile.api_access && profile.role !== 'admin') {
      return {
        ok: false,
        response: apiError(403, 'api_access_disabled', 'API access is not enabled for your account. Apply from API Keys in your dashboard.'),
      }
    }

    // last_used_at/ip bookkeeping: throttled to one write a minute per key
    // (it used to be a write on every single request), and attached to the
    // invocation with waitUntil() so Workers doesn't cancel it when the
    // response returns.
    const lastUsedMs = apiKey.last_used_at ? new Date(apiKey.last_used_at).getTime() : 0
    if (Date.now() - lastUsedMs > LAST_USED_WRITE_INTERVAL_MS) {
      const ip = req.headers.get('cf-connecting-ip') ?? null
      const touch = supabase
        .from('api_keys')
        .update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
        .eq('id', apiKey.id)
        .then(() => {}, () => {})
      try {
        getCloudflareContext({ async: false }).ctx.waitUntil(touch)
      } catch {
        // Not in a Workers context (local dev) — the promise just runs.
      }
    }

    return {
      ok: true,
      user: { id: profile.id, email: profile.email },
      supabase,
      key: { id: apiKey.id, scopes },
    }
  } catch (e) {
    console.error('[requireApiAccess] unexpected error:', e)
    return { ok: false, response: apiError(500, 'internal_error', 'Internal error validating API key. Please try again.') }
  }
}

/**
 * CSRF / login-CSRF guard for the cookie-authenticated and sign-in routes
 * under app/api/auth/*. Those routes parse JSON whatever the Content-Type is,
 * so a cross-site <form enctype="text/plain"> can post a JSON-looking body;
 * SameSite=Lax cookies stop that for signed-in actions, but NOT for sign-in
 * itself (a victim's browser can be made to sign in as the attacker).
 * Browsers always send Origin on cross-site POST/DELETE; requests without one
 * (curl, server-to-server) are not browser CSRF and pass.
 */
export function rejectCrossSite(req: Request): NextResponse | null {
  return isCrossSiteRequest(req) ? NextResponse.json({ error: 'Forbidden' }, { status: 403 }) : null
}
