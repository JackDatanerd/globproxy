import { createAdminClient } from '@/lib/supabase/server'
import { allowApiRequest } from '@/lib/rateLimit'
import { ipAllowed } from '@/lib/ipAllowlist'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { NextResponse } from 'next/server'
import { isCrossSiteRequest } from '@/lib/appUrl'

// Shared gate for every app/api/v1/* route.
//
// Bearer tokens are real API keys (api_keys table, migration 0005): the
// SHA-256 of the presented token is looked up there. Keys carry optional
// scopes ('read' = GET only, 'write' = everything, migration 0042), an
// optional expiry, and are rate limited per key.
export type ApiScope = 'read' | 'write'

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
  | 'idempotency_conflict'
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
const LAST_USED_WRITE_INTERVAL_MS = 60_000

function requiredScope(method: string): ApiScope {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'write'
}

function hasScope(scopes: string[], needed: ApiScope): boolean {
  // 'write' is a superset of 'read'.
  return needed === 'read' ? scopes.includes('read') || scopes.includes('write') : scopes.includes('write')
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
    if (!token || !token.startsWith('gp_live_')) {
      return { ok: false, response: unauthorized() }
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
    if (!apiKey || apiKey.revoked_at) {
      return { ok: false, response: unauthorized() }
    }
    // Same 401 as revoked/unknown on purpose: the body must not let a holder
    // of a leaked key probe the account's key history.
    if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
      return { ok: false, response: unauthorized() }
    }

    // Optional per-key source-IP allowlist (empty = any IP). Checked before
    // rate limiting / account lookups so a key used from the wrong place
    // costs nothing. Cloudflare sets cf-connecting-ip; it can't be spoofed
    // by the client at the edge.
    if (!ipAllowed(apiKey.allowed_ips as string[] | null, req.headers.get('cf-connecting-ip'))) {
      return { ok: false, response: apiError(403, 'ip_not_allowed', 'This API key is restricted to specific IP addresses and this request did not come from one of them.') }
    }

    const scopes: string[] = Array.isArray(apiKey.scopes) ? apiKey.scopes : ['read', 'write']
    const needed = opts.scope ?? requiredScope(req.method)
    if (!hasScope(scopes, needed)) {
      return {
        ok: false,
        response: apiError(403, 'insufficient_scope', `This API key is read-only. A key with the "write" scope is required for ${req.method} requests.`),
      }
    }

    // Per-key limits, checked after the key is known-valid (cheap, no profile
    // lookup wasted on a throttled caller) but before any real work.
    const retryHeaders = { 'Retry-After': '15' }
    if (!(await allowApiRequest('API_RATE_LIMITER', apiKey.id))) {
      return { ok: false, response: apiError(429, 'rate_limited', 'Rate limit exceeded (120 requests/minute per key). Retry after the Retry-After interval.', retryHeaders) }
    }
    if (needed === 'write' && !(await allowApiRequest('API_WRITE_RATE_LIMITER', apiKey.id))) {
      return { ok: false, response: apiError(429, 'rate_limited', 'Write rate limit exceeded (30 mutating requests/minute per key). Retry after the Retry-After interval.', retryHeaders) }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, role, api_access, is_suspended, is_deleted')
      .eq('id', apiKey.user_id)
      .single()

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
