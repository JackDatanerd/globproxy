// Guards for the Supabase session cookie (`sb-<project ref>-auth-token`, optionally chunked
// as `.0`, `.1`, ...), shared by middleware.ts and lib/supabase/server.ts.
//
// WHY. @supabase/ssr stores the session as `base64-<base64url of the JSON>`. When that value
// does not decode (bad characters, or bytes that are not valid UTF-8 once the chunks are
// joined) the client does NOT treat the session as missing: auth.getUser() REJECTS. Every
// caller then failed for that browser until the cookie was replaced: middleware answered
// every protected page with the 503 "temporarily unavailable" page (and never cleared the
// cookie), the homepage threw, and every API route that reads the session answered 500.
// Plain junk, a truncated JSON value or a JSON value that is not a session are handled
// properly by the library (signed out, cookie cleared) — only the decode failure escapes.
//
// A cookie like that can come from a truncated or mismatched set of chunks, a proxy or
// extension rewriting cookies, or another subdomain setting a cookie of that name. The fix
// is to treat it as what it is — no session — and to expire it.
//
// This mirrors what the library does, using the library's own helpers, so the two cannot
// disagree about what is decodable (tests/edge-pipeline.test.mjs checks it against the real
// client).
import { stringFromBase64URL } from '@supabase/ssr'

export type CookieLike = { name: string; value: string }

const BASE64_PREFIX = 'base64-'
// `sb-<ref>-auth-token` or one of its `.N` chunks. Not `...-auth-token-code-verifier`.
const SESSION_COOKIE = /^(sb-.+-auth-token)(?:\.(?:0|[1-9][0-9]*))?$/

/**
 * Names of the session cookies (base and chunks) whose value the Supabase client would throw
 * on. Empty when every session cookie is fine or absent.
 */
export function brokenSessionCookieNames(cookies: ReadonlyArray<CookieLike>): string[] {
  // Same duplicate rule as the request cookie jar: the last one wins.
  const byName = new Map<string, string>()
  const bases = new Set<string>()
  for (const { name, value } of cookies) {
    const m = SESSION_COOKIE.exec(name)
    if (!m) continue
    byName.set(name, value)
    bases.add(m[1])
  }

  const broken: string[] = []
  for (const base of bases) {
    // @supabase/ssr combineChunks: a non-empty exact cookie wins, otherwise the chunks .0, .1,
    // ... up to the first missing or empty one.
    let value = byName.get(base) || ''
    if (!value) {
      for (let i = 0; ; i++) {
        const chunk = byName.get(`${base}.${i}`)
        if (!chunk) break
        value += chunk
      }
    }
    if (!value.startsWith(BASE64_PREFIX)) continue
    try {
      stringFromBase64URL(value.slice(BASE64_PREFIX.length))
    } catch {
      for (const name of byName.keys()) {
        if (name === base || name.startsWith(`${base}.`)) broken.push(name)
      }
    }
  }
  return broken
}

/** `cookies` without any session cookie the Supabase client cannot decode. */
export function withoutBrokenSessionCookies<T extends CookieLike>(cookies: T[]): T[] {
  const broken = brokenSessionCookieNames(cookies)
  if (!broken.length) return cookies
  const drop = new Set(broken)
  return cookies.filter((c) => !drop.has(c.name))
}

/**
 * Cookie options for a Supabase session cookie written by the server. The library's defaults
 * carry no `Secure` attribute, so without this the session (access + refresh token) would also
 * be sent on any plain-http request to the site, unlike every other cookie this app sets.
 */
export function sessionCookieOptions(options: Record<string, any> | undefined, secure: boolean): Record<string, any> {
  return { ...options, secure: options?.secure ?? secure }
}
