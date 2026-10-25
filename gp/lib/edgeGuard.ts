// Request guard that runs in the Worker (custom-worker.ts) in front of the
// whole app, for /api/* only. Pure functions, no imports, so it can be loaded
// by the Worker bundle and unit-tested on its own.
//
// Two things the app could not do per-route:
//
//  1. BODY SIZE. Nothing capped request bodies, and every public route
//     (login, signup, reset, csp-report, the Paystack webhook) reads the whole
//     body before looking at it. A multi-megabyte POST costs memory and CPU
//     inside a Worker isolate that other requests share. Bodies over
//     MAX_API_BODY_BYTES are refused with 413 up front (Content-Length), and
//     bodies that arrive without a Content-Length (chunked) are wrapped in a
//     read (bounded by that same limit) before the app runs and answered with a
//     413 if they cross it — see limitBody().
//
//  2. SAME-ORIGIN ENFORCEMENT. Only 21 routes called rejectCrossSite(); the
//     other cookie-authenticated mutating routes under /api/dashboard relied on
//     SameSite=Lax alone. Browsers always send Origin (and Sec-Fetch-Site) on a
//     cross-site POST/PUT/PATCH/DELETE, so one rule here covers every route,
//     including ones added later. Requests with no Origin and no cross-site
//     Sec-Fetch-Site (curl, server-to-server) are not browser CSRF and pass.
//
// Exempt from the origin rule, because they are not cookie-authenticated:
// /api/webhooks/* (signed by the sender), /api/cron/* (secret header),
// /api/v1/* (bearer API keys) and /api/csp-report (posted by the browser's
// reporting machinery).

export const MAX_API_BODY_BYTES = 1024 * 1024 // 1 MiB — the largest legitimate JSON body here is a few KB

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// A trailing slash means "everything under this folder"; without one the entry
// is that exact route only. (`/api/csp-report` used to be a bare prefix, so any
// future `/api/csp-report-*` route would have inherited the exemption.)
const ORIGIN_EXEMPT = ['/api/webhooks/', '/api/cron/', '/api/v1/', '/api/csp-report']

function originExempt(pathname: string): boolean {
  return ORIGIN_EXEMPT.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname === p + '/'))
}

export type GuardVerdict = { status: number; error: string } | null

function originAllowed(origin: string, url: URL, appOrigin?: string): boolean {
  let o: URL
  try {
    o = new URL(origin)
  } catch {
    return false
  }
  const allowed = new Set<string>([url.origin])
  if (appOrigin) allowed.add(appOrigin)
  // apex <-> www of the host being served count as the same site.
  const host = url.hostname
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`
  allowed.add(`${url.protocol}//${twin}${url.port ? ':' + url.port : ''}`)
  return allowed.has(o.origin)
}

export function guardApiRequest(request: Request, url: URL, appOrigin?: string): GuardVerdict {
  if (!url.pathname.startsWith('/api/')) return null
  const method = request.method.toUpperCase()
  if (!UNSAFE_METHODS.has(method)) return null

  const len = request.headers.get('content-length')
  if (len !== null) {
    const n = Number(len)
    if (!Number.isFinite(n) || n < 0) return { status: 400, error: 'Invalid Content-Length' }
    if (n > MAX_API_BODY_BYTES) return { status: 413, error: 'Request body too large' }
  }

  if (originExempt(url.pathname)) return null

  const origin = request.headers.get('origin')
  if (origin !== null) {
    // 'null' is what browsers send from sandboxed frames and some redirects: never a legitimate caller of these routes.
    if (!originAllowed(origin, url, appOrigin)) return { status: 403, error: 'Forbidden' }
    return null
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return { status: 403, error: 'Forbidden' }
  return null
}

export type LimitedBody = { ok: true; request: Request } | { ok: false; verdict: { status: number; error: string } }

// For a body that did not announce its size (chunked): read it here, up to
// `max` bytes, and hand the route a Request whose body is the buffered bytes.
// Over the cap the caller gets a verdict to answer with a clean 413 BEFORE the
// app runs. It used to wrap the stream and error it mid-read, which surfaced as
// whatever the route's body parser made of a failed read — a 500, a dropped
// connection, or (for routes that swallow parse errors) an "empty body" — never
// a 413. Buffering is bounded by `max` (1 MiB), the same ceiling the
// Content-Length rule enforces.
export async function limitBody(request: Request, max: number = MAX_API_BODY_BYTES): Promise<LimitedBody> {
  if (!request.body || request.headers.has('content-length')) return { ok: true, request }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      if (seen > max) {
        await reader.cancel().catch(() => {})
        return { ok: false, verdict: { status: 413, error: 'Request body too large' } }
      }
      chunks.push(value)
    }
  } catch {
    // The client hung up mid-body: nothing sensible to run the app with.
    return { ok: false, verdict: { status: 400, error: 'Invalid request body' } }
  }
  const body = new Uint8Array(seen)
  let at = 0
  for (const c of chunks) { body.set(c, at); at += c.byteLength }
  return { ok: true, request: new Request(request, { body }) }
}

// Same rule the v1 routes use (lib/apiHelpers.ts withApiAuth): a caller-supplied X-Request-Id
// of up to 64 safe characters is honoured, anything else is replaced.
export function edgeRequestId(supplied: string | null | undefined): string {
  if (supplied && /^[A-Za-z0-9_\-.:]{1,64}$/.test(supplied)) return supplied
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

// Carries the same machine-readable `code` every /api/v1 error has, so a client
// that switches on `code` is not surprised by a bare `{ error }` from the edge, and the
// X-Request-Id the docs promise on EVERY response.
export function guardResponse(verdict: { status: number; error: string }, requestId?: string): Response {
  const code = verdict.status === 413 ? 'payload_too_large' : verdict.status === 400 ? 'invalid_request' : 'forbidden'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // These answers are produced in the Worker, ahead of Next, so the headers
    // next.config.ts adds to every app response are not applied to them.
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  }
  if (requestId) headers['X-Request-Id'] = requestId
  return new Response(JSON.stringify({ error: verdict.error, code }), { status: verdict.status, headers })
}
