// Validates a user-supplied outbound webhook URL before our own server
// fetch()es it.
//
// Two layers:
//   1. validateWebhookUrl()   — synchronous, literal-address/hostname rules.
//   2. checkHostnameResolution() — asynchronous DNS-over-HTTPS lookup so a
//      public-looking hostname that RESOLVES to a private/loopback/
//      link-local address is caught too (a plain literal check can't see
//      that). Run at create/update time and again at every delivery.
//
// What this still is not: airtight DNS-rebinding protection (the name can
// resolve differently between our check and fetch()'s own lookup). It
// narrows that window to a single request and, together with
// redirect:'manual' in lib/webhooks.ts and https-only, closes the practical
// attack surface.

import { ipv4ToInt, parseIpv6 } from './ipParse'

const MAX_URL_LENGTH = 2048

// ── IPv4 ──────────────────────────────────────────────────────────────
const BLOCKED_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + 255.255.255.255 broadcast
]

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (baseInt & mask)
  })
}

// ── IPv6 ──────────────────────────────────────────────────────────────
// (the textual-address parsers live in lib/ipParse.ts)

const v4From = (hi: number, lo: number) =>
  `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`

function isBlockedIpv6(g: number[]): boolean {
  const allZero = (n: number) => g.slice(0, n).every((x) => x === 0)

  if (allZero(8)) return true                       // ::
  if (allZero(7) && g[7] === 1) return true         // ::1
  if (allZero(5) && g[5] === 0xffff) return isBlockedIpv4(v4From(g[6], g[7])) // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZero(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIpv4(v4From(g[6], g[7])) // ::ffff:0:a.b.c.d (IPv4-translated, SIIT)
  if (allZero(6)) return true                       // ::a.b.c.d (IPv4-compatible, deprecated) — never legitimate
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true                     // 64:ff9b:1::/48 local-use NAT64
    if (g.slice(2, 6).every((x) => x === 0)) return isBlockedIpv4(v4From(g[6], g[7])) // 64:ff9b::/96
  }
  if (g[0] === 0x2002) return true                       // 6to4 (2002::/16) embeds an IPv4 address; never a real webhook receiver
  if (g[0] === 0x2001 && g[1] === 0) return true    // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true // 3fff::/20 documentation (RFC 9637)
  if (g[0] === 0x2001 && g[1] < 0x0200) return true // IETF protocol assignments
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true // discard-only
  if ((g[0] & 0xfe00) === 0xfc00) return true       // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true       // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true       // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true       // multicast
  return false
}

// ── Hostnames ─────────────────────────────────────────────────────────
const BLOCKED_SUFFIXES = [
  '.localhost', '.local', '.localdomain', '.internal', '.intranet',
  '.corp', '.lan', '.home', '.private', '.home.arpa', '.test', '.invalid', '.example',
]

export function isBlockedHostLiteral(hostname: string): boolean {
  // URL.hostname keeps IPv6 brackets and a trailing root dot — normalise both.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h) return true

  const v6 = parseIpv6(h)
  if (v6) return isBlockedIpv6(v6)

  if (/^\d+(\.\d+){3}$/.test(h)) return isBlockedIpv4(h) || ipv4ToInt(h) === null

  if (h === 'localhost') return true
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true
  // Single-label names ("intranet", "metadata") only ever resolve inside a
  // private search domain — never a legitimate public webhook receiver.
  if (!h.includes('.')) return true
  return false
}

// ── Our own infrastructure ────────────────────────────────────────────
// A webhook that targets this very platform (or any *.workers.dev Worker)
// would make our delivery code POST signed payloads back into our own
// routes, or into other Workers on the account, over the public network.
// Never a legitimate receiver, so it is refused outright.
const OWN_HOST_BASES = ['globproxy.com', 'workers.dev']

export function isOwnHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h) return false
  const bases = [...OWN_HOST_BASES]
  try {
    const app = process.env.NEXT_PUBLIC_APP_URL
    if (app) bases.push(new URL(app).hostname.toLowerCase())
  } catch {
    /* malformed env value — the static list above still applies */
  }
  return bases.some((b) => h === b || h.endsWith('.' + b))
}

// Standard HTTPS plus the one common alternative. Anything else (22, 25,
// 6379, 9200 …) would turn "webhook delivery" into a port scanner pointed at
// third-party hosts from our egress addresses. Enforced when an endpoint is
// created or edited (validateWebhookUrlFull) AND at every delivery
// (lib/webhooks.ts), so an endpoint saved before this rule existed is disabled
// on its next delivery instead of being scanned from.
const ALLOWED_WEBHOOK_PORTS = new Set(['', '443', '8443'])

export function validateWebhookPort(u: URL): string | null {
  // URL.port is '' for the default port, including an explicit ":443".
  if (!ALLOWED_WEBHOOK_PORTS.has(u.port)) {
    return 'Webhook URL must use the default HTTPS port (443) or 8443'
  }
  return null
}

// Returns an error message if the URL isn't acceptable, or null if it's fine.
export function validateWebhookUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return 'Enter a valid URL (max 2048 characters)'
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Enter a valid URL'
  }
  if (u.protocol !== 'https:') return 'Webhook URL must use https://'
  if (u.username || u.password) return 'Webhook URL must not contain embedded credentials'
  if (isBlockedHostLiteral(u.hostname)) {
    return 'Webhook URL cannot point to a private, loopback, or link-local address'
  }
  // A customer's own Worker lives on workers.dev too, so "GlobProxy itself" was the wrong thing to
  // tell them. The whole suffix stays refused (we cannot tell our Workers from theirs by name), but
  // the message now says what to do about it.
  const h = u.hostname.toLowerCase().replace(/\.+$/, '')
  if (h === 'workers.dev' || h.endsWith('.workers.dev')) {
    return 'Webhook URL cannot use a workers.dev address — attach your own domain to the Worker and use that instead'
  }
  if (isOwnHost(u.hostname)) {
    return 'Webhook URL cannot point to GlobProxy itself'
  }
  return null
}

// ── DNS-over-HTTPS resolution check ───────────────────────────────────
type DohAnswer = { type: number; data: string }
type DohResponse = { Status?: number; Answer?: DohAnswer[] }
type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json: () => Promise<any> }>

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query'
const DOH_TIMEOUT_MS = 3000
const DOH_CACHE_TTL_MS = 60_000
export const DNS_UNAVAILABLE_MESSAGE = 'We could not verify that hostname right now. Please try again in a moment.'
const dohCache = new Map<string, { at: number; result: string | null }>()

async function dohQuery(fetchImpl: FetchLike, name: string, type: 'A' | 'AAAA'): Promise<DohResponse> {
  const res = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`DoH ${type} lookup failed`)
  return (await res.json()) as DohResponse
}

// Returns an error message if `hostname` resolves to a blocked address (or,
// with requireResolvable, doesn't resolve at all), else null. IP literals are
// skipped (already covered by validateWebhookUrl). FAILS OPEN at DELIVERY time if
// the DNS lookup itself is unavailable — a resolver outage must not stop every
// webhook delivery platform-wide; the literal check above still ran. With
// `failClosed` (used when an endpoint is CREATED or EDITED, where one retry costs
// the user nothing) an unusable lookup is refused instead, so a resolver blip
// can't be used to register a hostname that was never actually checked.
export async function checkHostnameResolution(
  hostname: string,
  opts: { requireResolvable?: boolean; fetchImpl?: FetchLike; failClosed?: boolean } = {}
): Promise<string | null> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!h || h.includes(':') || /^\d+(\.\d+){3}$/.test(h)) return null

  const cacheKey = `${h}|${opts.requireResolvable ? 1 : 0}`
  const cached = dohCache.get(cacheKey)
  if (cached && Date.now() - cached.at < DOH_CACHE_TTL_MS) return cached.result

  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike)
  let result: string | null = null
  try {
    const [a, aaaa] = await Promise.all([dohQuery(fetchImpl, h, 'A'), dohQuery(fetchImpl, h, 'AAAA')])
    const answers = [...(a.Answer ?? []), ...(aaaa.Answer ?? [])].filter((x) => x.type === 1 || x.type === 28)
    // CNAME records are filtered out of `answers` (they carry names, not
    // addresses), but a hostname aliased to our own domain would otherwise get
    // past the name-based isOwnHost() check in validateWebhookUrl().
    const cnames = [...(a.Answer ?? []), ...(aaaa.Answer ?? [])].filter((x) => x.type === 5)
    // DNS response codes: 0 NOERROR, 3 NXDOMAIN. Anything else (2 SERVFAIL, 5
    // REFUSED, …) means the lookup itself did not work — not that the name is fine.
    const lookupFailed = (r: DohResponse) => (r.Status ?? 0) !== 0 && (r.Status ?? 0) !== 3
    if (answers.some((x) => isBlockedHostLiteral(x.data))) {
      result = 'Webhook hostname resolves to a private, loopback, or link-local address'
    } else if (cnames.some((x) => isOwnHost(x.data))) {
      result = 'Webhook hostname points at GlobProxy itself'
    } else if (lookupFailed(a) || lookupFailed(aaaa)) {
      // Treated like the resolver being down (fail open, as documented above), but
      // NOT cached: a SERVFAIL "pass" used to be remembered for a minute, so the
      // name could be checked as clean once and then re-resolved to something
      // private inside that window with no second look.
      console.error('[ssrfGuard] DNS lookup returned', a.Status, aaaa.Status, 'for', h, '— not cached,', opts.failClosed ? 'refusing' : 'failing open')
      return opts.failClosed ? DNS_UNAVAILABLE_MESSAGE : null
    } else if (opts.requireResolvable && answers.length === 0) {
      // NXDOMAIN, or NOERROR with no A/AAAA records at all (a name that exists but
      // has no address — deliveries to it could never connect). Only NXDOMAIN used
      // to be caught here.
      result = 'That hostname does not resolve'
    }
  } catch (e) {
    console.error('[ssrfGuard] DNS resolution check unavailable,', opts.failClosed ? 'refusing' : 'failing open', 'for', h, e)
    return opts.failClosed ? DNS_UNAVAILABLE_MESSAGE : null // deliberately not cached
  }
  dohCache.set(cacheKey, { at: Date.now(), result })
  if (dohCache.size > 500) dohCache.clear()
  return result
}

// Convenience for create/update routes: literal rules, then DNS.
export async function validateWebhookUrlFull(raw: string): Promise<string | null> {
  const literal = validateWebhookUrl(raw)
  if (literal) return literal
  const u = new URL(raw)
  const port = validateWebhookPort(u)
  if (port) return port
  return checkHostnameResolution(u.hostname, { requireResolvable: true, failClosed: true })
}
