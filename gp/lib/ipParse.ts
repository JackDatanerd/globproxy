// IP-address parsing and grouping, import-free so the Worker entry, the rate limiter, the
// SSRF guard and the unit tests can all load it. (It used to live inside lib/ssrfGuard.ts,
// which made the rate limiter and the Worker depend on the webhook guard for it.)

// ── IPv4 ──────────────────────────────────────────────────────────────
export function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

// ── IPv6 ──────────────────────────────────────────────────────────────
// Parses any textual IPv6 form (compressed, expanded, with an embedded
// dotted-quad tail) into 8 16-bit groups. Returns null if it isn't IPv6.
// Exported so lib/rateLimit.ts can collapse a client address to its /64.
export function parseIpv6(raw: string): number[] | null {
  let h = raw.toLowerCase()
  if (!h.includes(':')) return null
  const zone = h.indexOf('%')
  if (zone !== -1) h = h.slice(0, zone)

  // Embedded IPv4 tail (a.b.c.d) -> two hex groups
  const tail = h.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (tail) {
    const n = ipv4ToInt(tail[2])
    if (n === null) return null
    h = `${tail[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`
  }

  const halves = h.split('::')
  if (halves.length > 2) return null
  const toGroups = (part: string) => (part === '' ? [] : part.split(':'))
  const head = toGroups(halves[0])
  const rest = halves.length === 2 ? toGroups(halves[1]) : []
  if (halves.length === 1 && head.length !== 8) return null
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 && missing < 1) return null

  const groups = halves.length === 2
    ? [...head, ...Array(missing).fill('0'), ...rest]
    : head
  if (groups.length !== 8) return null

  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

// ── Client-address grouping (rate limits) ─────────────────────────────
/**
 * The grouping every per-address limit uses, for a bare address string:
 *  - IPv6 collapses to its /64. A single subscriber is handed an entire /64 (2^64
 *    addresses), so keying on the full address would give an attacker a fresh bucket
 *    per request.
 *  - IPv4-mapped IPv6 collapses to the IPv4.
 */
export function normalizeClientIp(raw: string): string {
  if (!raw.includes(':')) return raw
  const g = parseIpv6(raw)
  if (!g) return raw
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/** The caller's address as a rate-limit key from the cf-connecting-ip header value, or null when absent. */
export function clientKeyFromHeader(raw: string | null | undefined): string | null {
  const v = raw?.trim()
  return v ? normalizeClientIp(v) : null
}
