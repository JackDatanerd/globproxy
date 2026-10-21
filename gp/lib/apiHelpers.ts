import { NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import { apiError, requireApiAccess, rateLimitHeaders, API_RATE_LIMIT_PER_MIN, API_WRITE_RATE_LIMIT_PER_MIN, type ApiAuthResult, type ApiErrorCode, type ApiScope } from '@/lib/apiAuth'
import { allowApiRequest } from '@/lib/rateLimit'

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
      if (!res.headers.has('X-RateLimit-Limit')) res.headers.set('X-RateLimit-Limit', String(API_RATE_LIMIT_PER_MIN))
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
  } catch {
    return { ok: false, response: apiError(400, 'invalid_request', 'Request body must be valid JSON.') }
  }
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
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : new Date(t).toISOString()
}

// Escapes LIKE wildcards so a user-supplied search string matches literally.
export const likeEscape = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`)
