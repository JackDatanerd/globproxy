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
//     counting stream that errors once the limit is crossed.
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
const ORIGIN_EXEMPT_PREFIXES = ['/api/webhooks/', '/api/cron/', '/api/v1/', '/api/csp-report']

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

  if (ORIGIN_EXEMPT_PREFIXES.some((p) => url.pathname.startsWith(p))) return null

  const origin = request.headers.get('origin')
  if (origin !== null) {
    // 'null' is what browsers send from sandboxed frames and some redirects: never a legitimate caller of these routes.
    if (!originAllowed(origin, url, appOrigin)) return { status: 403, error: 'Forbidden' }
    return null
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return { status: 403, error: 'Forbidden' }
  return null
}

// For a body that did not announce its size: pass it through, but error the
// stream once more than `max` bytes have been read.
export function withBodyLimit(request: Request, max: number = MAX_API_BODY_BYTES): Request {
  if (!request.body || request.headers.has('content-length')) return request
  let seen = 0
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > max) controller.error(new Error('Request body too large'))
      else controller.enqueue(chunk)
    },
  })
  // `duplex` is required by the fetch spec (and Node) whenever a Request is built from a stream; Workers ignore it.
  return new Request(request, { body: request.body.pipeThrough(limiter), duplex: 'half' } as RequestInit)
}

// Carries the same machine-readable `code` every /api/v1 error has, so a client
// that switches on `code` is not surprised by a bare `{ error }` from the edge.
export function guardResponse(verdict: { status: number; error: string }): Response {
  const code = verdict.status === 413 ? 'payload_too_large' : verdict.status === 400 ? 'invalid_request' : 'forbidden'
  return new Response(JSON.stringify({ error: verdict.error, code }), {
    status: verdict.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
