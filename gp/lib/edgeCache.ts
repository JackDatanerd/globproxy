// Pure (import-free) decisions for the anonymous-page edge cache in custom-worker.ts, so
// they can be unit-tested without the Workers runtime.

// Cookies that never change what an anonymous public page renders, so a visitor who
// carries only these still gets the shared cached copy:
//  - gp_ref / gp_sub: written client-side by components/RefCapture.tsx when someone lands
//    from a referral link, and kept for 60 days. They are read only in the browser (the
//    signup form). Treating them as "has a cookie" sent every referred visitor — the
//    people the referral programme exists to bring in — past the cache on every page for
//    two months.
//  - Cloudflare's own bot / session-affinity cookies.
// An ALLOW-list on purpose: a cookie that is not listed (the Supabase session, anything a
// future feature adds) keeps the request out of the cache, which is the safe direction.
const BENIGN_COOKIE = /^(gp_ref|gp_sub|__cf_bm|_cfuvid|cf_clearance|__cflb)$/

/** True when the Cookie header is absent/empty or holds only cookies that cannot personalise a public page. */
export function cookiesAreBenign(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader || !cookieHeader.trim()) return true
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = eq === -1 ? trimmed : trimmed.slice(0, eq).trim()
    if (!BENIGN_COOKIE.test(name)) return false
  }
  return true
}

export type CacheAge = 'fresh' | 'stale' | 'expired'

/**
 * Where a stored copy stands. `storedAtMs` comes from the x-edge-stored-at header the
 * Worker stamps on what it stores; missing or unreadable counts as expired.
 *  fresh   — younger than ttlS: serve as is
 *  stale   — older than ttlS but inside the stale window: serve it AND refresh in the background
 *  expired — anything else: treat as a miss
 */
export function cacheAge(storedAtMs: number | null, nowMs: number, ttlS: number, staleS: number): CacheAge {
  if (storedAtMs === null || !Number.isFinite(storedAtMs) || storedAtMs > nowMs + 60_000) return 'expired'
  const ageS = (nowMs - storedAtMs) / 1000
  if (ageS <= ttlS) return 'fresh'
  if (staleS > 0 && ageS <= ttlS + staleS) return 'stale'
  return 'expired'
}
