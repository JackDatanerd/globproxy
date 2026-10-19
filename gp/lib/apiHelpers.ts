import { NextResponse } from 'next/server'
import { apiError, requireApiAccess, type ApiAuthResult, type ApiErrorCode, type ApiScope } from '@/lib/apiAuth'

export type ApiAuthOk = Extract<ApiAuthResult, { ok: true }>

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
    try { res.headers.set('X-Request-Id', requestId) } catch { /* immutable response — leave as is */ }
    return res
  }

  const auth = await requireApiAccess(req, opts)
  if (!auth.ok) return stamp(auth.response)
  try {
    return stamp(await handler(auth))
  } catch (e) {
    console.error(`[v1 ${tag}] [${requestId}] unexpected error:`, e)
    return stamp(apiError(500, 'internal_error', `Internal error. Please try again. (request id: ${requestId})`))
  }
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
