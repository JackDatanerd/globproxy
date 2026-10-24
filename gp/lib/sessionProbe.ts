// Looks at a request's Cookie header — WITHOUT calling anything — and says whether the
// Supabase session in it is one that will make the server call Supabase Auth to REFRESH
// it. Pure and import-free so the Worker entry (custom-worker.ts) can use it and the
// unit tests can load it.
//
// WHY. Every page request carrying a session cookie runs through middleware.ts, whose
// supabase.auth.getUser() refreshes an expired access token by calling Supabase Auth's
// token endpoint from the Worker. Supabase rate-limits token refreshes per source address
// (a configurable Auth rate limit; the default has been 150 per 5 minutes — check the
// project's Auth → Rate Limits page), and the Worker's address is shared
// by everyone served from that Cloudflare location. Anyone can send a cookie whose JSON
// says "expired" together with a made-up refresh token, so a trickle of such requests
// could use up that budget and make REAL users' refreshes fail with a 429, which
// middleware (correctly) reports as an outage: a 503 on every signed-in page.
// A legitimate browser refreshes about once an hour, so a tight per-address brake on
// exactly this kind of request costs real users nothing.
//
// What it does NOT cover: a cookie that LOOKS fresh but carries a made-up access token
// costs one /user call per request. That cannot be told apart from a valid one without
// the project's JWT key, and that call is not subject to the refresh budget.

export type SessionState =
  | 'none'       // no Supabase session cookie at all
  | 'fresh'      // readable and not near expiry: no refresh call will be made
  | 'refresh'    // readable and expired / about to expire: the server will try to refresh it
  | 'unreadable' // a session cookie we cannot parse: the client library drops it without a network call

// supabase-js refreshes a token that expires within this margin.
export const REFRESH_MARGIN_S = 90

// `sb-<project ref>-auth-token`, optionally chunked as `.0`, `.1`, ... Deliberately does
// not match `...-auth-token-code-verifier` (the PKCE verifier cookie).
const SESSION_COOKIE = /^sb-.+-auth-token(?:\.(\d+))?$/

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function parseCookieHeader(header: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name || out.has(name)) continue
    out.set(name, part.slice(eq + 1).trim())
  }
  return out
}

/** Expiry (epoch seconds) from a parsed session object, falling back to the access token's own `exp`. */
function expiryOf(session: any): number | null {
  if (typeof session?.expires_at === 'number' && Number.isFinite(session.expires_at)) return session.expires_at
  const jwt = session?.access_token
  if (typeof jwt === 'string') {
    const payload = jwt.split('.')[1]
    if (payload) {
      try {
        const exp = JSON.parse(b64urlDecode(payload))?.exp
        if (typeof exp === 'number' && Number.isFinite(exp)) return exp
      } catch { /* fall through */ }
    }
  }
  return null
}

export function classifySession(cookieHeader: string | null | undefined, nowMs: number): SessionState {
  if (!cookieHeader) return 'none'
  const jar = parseCookieHeader(cookieHeader)

  // Group chunks by cookie base name, in index order.
  const groups = new Map<string, { idx: number; value: string }[]>()
  for (const [name, value] of jar) {
    const m = SESSION_COOKIE.exec(name)
    if (!m) continue
    const base = m[1] === undefined ? name : name.slice(0, name.lastIndexOf('.'))
    const list = groups.get(base) ?? []
    list.push({ idx: m[1] === undefined ? 0 : Number(m[1]), value })
    groups.set(base, list)
  }
  if (groups.size === 0) return 'none'

  let sawReadable = false
  for (const list of groups.values()) {
    list.sort((a, b) => a.idx - b.idx)
    let raw = list.map((c) => c.value).join('')
    try {
      if (raw.startsWith('base64-')) raw = b64urlDecode(raw.slice('base64-'.length))
      else raw = decodeURIComponent(raw)
      const exp = expiryOf(JSON.parse(raw))
      if (exp === null) continue
      sawReadable = true
      if (exp * 1000 <= nowMs + REFRESH_MARGIN_S * 1000) return 'refresh'
    } catch {
      continue
    }
  }
  return sawReadable ? 'fresh' : 'unreadable'
}
