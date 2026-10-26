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
const SESSION_BASE = /^sb-.+-auth-token$/
const CHUNK_NAME = /^(.*)\.(0|[1-9][0-9]*)$/

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// THE PROBE MUST SEE EXACTLY WHAT THE SERVER SEES. Every rule below mirrors the code that
// actually runs on the request, because any difference is a way to send a cookie the probe
// reads as "fresh" / "unreadable" while the server still calls Supabase Auth to refresh it:
//  - Next's cookie parser (@edge-runtime/cookies parseCookie): pairs split on `; *`, names
//    NOT trimmed, a value that fails decodeURIComponent is skipped, and when a name repeats
//    the LAST one wins (an earlier version took the first).
//  - @supabase/ssr combineChunks: the exact `sb-<ref>-auth-token` cookie wins when it is
//    non-empty; only otherwise are `.0`, `.1`, ... read, stopping at the first missing or
//    empty index (later chunks are ignored). They are never mixed.
//  - auth-js __loadSession: a stored value is a session only if it is an object holding the
//    keys access_token, refresh_token and expires_at; it is expired when
//    `expires_at ? expires_at * 1000 - now < 90s : false`, evaluated with JavaScript's own
//    coercion (a string "1" counts as expired; null / 0 count as NOT expired). There is no
//    fallback to the JWT's `exp`: a session without the keys is dropped without a network call.
function parseCookieJar(header: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const pair of header.split(/; */)) {
    if (!pair) continue
    const eq = pair.indexOf('=')
    if (eq === -1) { out.set(pair, 'true'); continue }
    try {
      out.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)))
    } catch { /* Next skips a value it cannot decode */ }
  }
  return out
}

/** The storage key @supabase/supabase-js derives from a project URL, or null if it cannot be derived. */
export function sessionKeyFromUrl(supabaseUrl: string | null | undefined): string | null {
  if (!supabaseUrl) return null
  try {
    const host = new URL(supabaseUrl).hostname.split('.')[0]
    return host ? `sb-${host}-auth-token` : null
  } catch {
    return null
  }
}

/**
 * `onlyKey`: the one cookie key the server's Supabase client reads (sessionKeyFromUrl). When
 * given, other `sb-*-auth-token` cookies are ignored, exactly as the server ignores them; when
 * absent every such key is checked, which can only over-brake the sender of an odd cookie.
 */
export function classifySession(cookieHeader: string | null | undefined, nowMs: number, onlyKey?: string | null): SessionState {
  if (!cookieHeader) return 'none'
  const jar = parseCookieJar(cookieHeader)

  const bases = new Set<string>()
  for (const name of jar.keys()) {
    if (SESSION_BASE.test(name)) bases.add(name)
    else {
      const m = CHUNK_NAME.exec(name)
      if (m && SESSION_BASE.test(m[1])) bases.add(m[1])
    }
  }
  if (onlyKey) {
    if (!bases.has(onlyKey)) return 'none'
    bases.clear()
    bases.add(onlyKey)
  }
  if (bases.size === 0) return 'none'

  let sawReadable = false
  for (const base of bases) {
    let raw = jar.get(base) || ''
    if (!raw) {
      for (let i = 0; ; i++) {
        const chunk = jar.get(`${base}.${i}`)
        if (!chunk) break
        raw += chunk
      }
    }
    if (!raw) continue
    try {
      if (raw.startsWith('base64-')) raw = b64urlDecode(raw.slice('base64-'.length))
      const session = JSON.parse(raw)
      if (typeof session !== 'object' || session === null || !('access_token' in session) || !('refresh_token' in session) || !('expires_at' in session)) continue
      sawReadable = true
      const ea = (session as { expires_at: any }).expires_at
      if (ea ? ea * 1000 - nowMs < REFRESH_MARGIN_S * 1000 : false) return 'refresh'
    } catch {
      continue
    }
  }
  return sawReadable ? 'fresh' : 'unreadable'
}

/**
 * The Cookie header with every Supabase session cookie (sb-<ref>-auth-token and its .N
 * chunks) removed, or null when nothing else is left. The PKCE verifier cookie and every
 * other cookie stay. Used by the Worker's refresh brake to carry on as an anonymous visitor
 * instead of answering 429: a signed-out view of a page, or the login form, is a better
 * outcome than a wall for someone whose only problem is an expired cookie on a busy network.
 */
export function stripSessionCookies(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null
  const kept: string[] = []
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (SESSION_COOKIE.test(name)) continue
    kept.push(trimmed)
  }
  return kept.length ? kept.join('; ') : null
}
