import { NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { apiError, requireApiAccess, rateLimitHeaders, API_RATE_LIMIT_PER_MIN, API_WRITE_RATE_LIMIT_PER_MIN, type ApiAuthResult, type ApiErrorCode, type ApiScope } from '@/lib/apiAuth'
import { allowApiRequest } from '@/lib/rateLimit'
import { isoToUtcString } from '@/lib/cursor'

export type ApiAuthOk = Extract<ApiAuthResult, { ok: true }> & {
  requestId: string
  // Bulk endpoints do N operations for one HTTP request. They charge the other
  // N-1 against the per-key WRITE limiter so a single call can't sidestep it.
  // Returns false (and the handler should answer 429) when the budget is gone.
  consumeWrites: (n: number) => Promise<boolean>
}

function runInBackground(p: Promise<unknown>) {
  const safe = p.then(() => {}, () => {})
  try { getCloudflareContext({ async: false }).ctx.waitUntil(safe) } catch { /* not in Workers (local dev) — it just runs */ }
}

// Authenticates (key, scope, rate limit, account state) then runs the
// handler; any unexpected throw becomes a clean 500 instead of an
// unhandled-exception Worker crash, and never leaks the raw error text.
export async function withApiAuth(
  req: Request,
  tag: string,
  handler: (auth: ApiAuthOk) => Promise<Response>,
  opts: { scope?: ApiScope } = {}
): Promise<Response> {
  // Every v1 response (success or error) carries X-Request-Id, and the same
  // id is in the server logs for that request, so "request req_… failed" in a
  // support ticket is enough to find the cause. A caller-supplied
  // X-Request-Id (≤64 safe chars) is honoured so it can be correlated with
  // the caller's own logs.
  const supplied = req.headers.get('x-request-id')
  const requestId = supplied && /^[A-Za-z0-9_\-.:]{1,64}$/.test(supplied) ? supplied : `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
  const stamp = (res: Response) => {
    try {
      res.headers.set('X-Request-Id', requestId)
      // The limit that applies to THIS request: 30 for a change, 120 for a read. (It
      // used to say 120 on every response, including the writes that stop at 30.)
      if (!res.headers.has('X-RateLimit-Limit')) {
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        res.headers.set('X-RateLimit-Limit', String(mutating ? API_WRITE_RATE_LIMIT_PER_MIN : API_RATE_LIMIT_PER_MIN))
      }
    } catch { /* immutable response — leave as is */ }
    return res
  }

  const auth = await requireApiAccess(req, opts)
  if (!auth.ok) return stamp(auth.response)

  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  const logMutation = (status: number) => {
    // Mutating calls only (GETs would be ~all the volume and none of the risk):
    // the answer to "what did this key do?" after a leak. Best-effort, off the
    // response path, never allowed to fail the request.
    if (!isMutation) return
    let path = ''
    try { path = new URL(req.url).pathname.slice(0, 300) } catch { /* leave empty */ }
    runInBackground(
      Promise.resolve(auth.supabase.from('api_request_log').insert({
        user_id: auth.user.id, key_id: auth.key.id, method: req.method, path, status,
        ip: req.headers.get('cf-connecting-ip'), request_id: requestId,
      }))
    )
  }

  const consumeWrites = async (n: number) => {
    for (let i = 0; i < n; i++) {
      if (!(await allowApiRequest('API_WRITE_RATE_LIMITER', auth.key.id))) return false
    }
    return true
  }

  try {
    const res = await handler({ ...auth, requestId, consumeWrites })
    logMutation(res.status)
    return stamp(res)
  } catch (e) {
    console.error(`[v1 ${tag}] [${requestId}] unexpected error:`, e)
    logMutation(500)
    return stamp(apiError(500, 'internal_error', `Internal error. Please try again. (request id: ${requestId})`))
  }
}

// 429 for a bulk request whose items exceed the remaining write budget.
export function writeBudgetExceeded() {
  return apiError(429, 'rate_limited', `Write rate limit exceeded (${API_WRITE_RATE_LIMIT_PER_MIN} mutating operations/minute per key — each item in a bulk request counts). Retry after the Retry-After interval.`, rateLimitHeaders(API_WRITE_RATE_LIMIT_PER_MIN))
}

export async function readJsonBody(req: Request): Promise<{ ok: true; body: any } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await req.json() }
  } catch (e) {
    // A chunked body that crossed the size cap errors the stream (see
    // lib/edgeGuard.ts withBodyLimit); that is a 413, not "invalid JSON".
    if (e instanceof Error && /too large/i.test(e.message)) {
      return { ok: false, response: apiError(413, 'payload_too_large', 'Request body is too large (1 MiB maximum).') }
    }
    return { ok: false, response: apiError(400, 'invalid_request', 'Request body must be valid JSON.') }
  }
}

// For routes where the body is OPTIONAL (an empty body means "use the defaults")
// but a body that is present must be a valid JSON object. Treating "unreadable"
// as "empty" is how a typo'd `{"gb": 5` once became "reclaim everything" — so an
// absent body is the only thing that yields {}; anything malformed is a 400.
export async function readOptionalJsonObject(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  let raw: string
  try {
    raw = (await req.text()).trim()
  } catch {
    return { ok: false, response: apiError(400, 'invalid_request', 'Could not read the request body.') }
  }
  if (!raw) return { ok: true, body: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, response: apiError(400, 'invalid_request', 'Request body must be valid JSON.') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: apiError(400, 'invalid_request', 'Request body must be a JSON object.') }
  }
  return { ok: true, body: parsed as Record<string, unknown> }
}

// lib/rateLimit.ts helpers answer with a bare `{ error }` body (they serve the
// dashboard too). Every /api/v1 error must carry a machine-readable `code`, so a
// v1 route passes such a response through this to get the documented shape.
export function asApiRateLimited(res: Response) {
  const retry = res.headers.get('retry-after')
  return apiError(429, 'rate_limited', 'Too many requests. Retry after the Retry-After interval.', { 'Retry-After': retry && /^\d+$/.test(retry) ? retry : '60' })
}

export function failFrom(r: { status: number; code: string; message: string }) {
  return apiError(r.status, r.code as ApiErrorCode, r.message)
}

export function parsePage(url: URL, defaults = { limit: 100, max: 500 }) {
  const rawLimit = Number(url.searchParams.get('limit'))
  const rawOffset = Number(url.searchParams.get('offset'))
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, defaults.max) : defaults.limit
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? Math.min(rawOffset, 1_000_000) : 0
  return { limit, offset }
}

// ?created_after= / ?created_before= — ISO 8601, validated. Returns the ISO
// string, null when absent, or undefined when present but malformed.
export function parseDateParam(url: URL, name: string): string | null | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return null
  // Strict ISO 8601 only (see isoToUtcString): Date.parse accepted "1", "2026" and "2026-02-30" and
  // silently filtered on a date the caller never meant, instead of answering 400.
  return isoToUtcString(raw) ?? undefined
}

// Escapes LIKE wildcards so a user-supplied search string matches literally.
// PostgREST rewrites EVERY "*" in a like/ilike value to "%" before Postgres sees it (even one that
// is backslash-escaped, which would then match a literal "%"), so a literal asterisk cannot be
// expressed. It becomes the single-character wildcard "_" instead: a search for "a*b" still finds
// "a*b", rather than "a*b" turning into "a%b" and a lone "*" matching every label.
export const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '_')

// Runs an offset-paged, counted query. PostgREST answers an offset past the end of the result with
// 416 (PGRST103) instead of an empty page, which the list routes turned into a 500 for a request
// that is simply "the page after the last one". That case now returns an empty page and the real
// total (read with a one-row query), so `has_more` is false and clients can stop cleanly.
export async function pagedQuery(build: () => any, offset: number, limit: number): Promise<{ data: any[] | null; count: number | null; error: any }> {
  const r = await build().range(offset, offset + limit - 1)
  if (r.error && (r.error.code === 'PGRST103' || /range not satisfiable/i.test(r.error.message ?? ''))) {
    const c = await build().range(0, 0)
    if (c.error) return c
    return { data: [], count: c.count ?? 0, error: null }
  }
  return r
}
