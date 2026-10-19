// Validates a user-supplied outbound webhook URL before we let our own
// server fetch() it.
//
// This is a literal-address check, not DNS-rebinding protection: it cannot
// resolve hostnames, so a public name that *resolves* to a private address
// (e.g. 127.0.0.1.nip.io) still passes. Mitigations that already exist:
// https-only, redirects are never followed (lib/webhooks.ts uses
// redirect: 'manual'), and the Workers runtime itself cannot reach private
// ranges. What this closes is every way of *spelling* a private/loopback/
// reserved address in the URL.
//
// History: the original version matched IPv6 prefixes by string (blocking
// real hosts like fcm.googleapis.com and fdic.gov because they start with
// "fc"/"fd") and only recognised two embedded-IPv4 spellings, missing
// ::127.0.0.1, ::7f00:1, ::ffff:0:7f00:1, 2002:7f00:1::, febf::, fec0::,
// "localhost." and *.localhost. IPv6 is now parsed into 8 numeric groups
// and classified by range, and the URL parser's own canonical hostname
// (which already normalises 0x7f.1 / 2130706433 style IPv4) is what we test.

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

const BLOCKED_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],    // RFC1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // deprecated 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + 255.255.255.255 broadcast
]

function isBlockedIpv4Int(n: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (baseInt & mask)
  })
}

// Parses an IPv6 literal (no brackets) into 8 16-bit groups, or null if it
// isn't a valid IPv6 address. Handles "::" compression and a trailing
// dotted-quad (::ffff:1.2.3.4).
function parseIpv6(addr: string): number[] | null {
  let a = addr.toLowerCase()
  const zone = a.indexOf('%')
  if (zone !== -1) a = a.slice(0, zone)
  if (!/^[0-9a-f:.]+$/.test(a) || !a.includes(':')) return null

  // Convert a trailing dotted-quad into two hex groups.
  const lastColon = a.lastIndexOf(':')
  const tail = a.slice(lastColon + 1)
  if (tail.includes('.')) {
    const n = ipv4ToInt(tail)
    if (n === null) return null
    a = a.slice(0, lastColon + 1) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16)
  }

  const halves = a.split('::')
  if (halves.length > 2) return null
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'))
  const head = toGroups(halves[0])
  const rest = halves.length === 2 ? toGroups(halves[1]) : []
  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

function embeddedV4(hi: number, lo: number): number {
  return (((hi & 0xffff) << 16) | (lo & 0xffff)) >>> 0
}

function isBlockedIpv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0

  // :: and ::1
  if (firstFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true
  // ::/96 IPv4-compatible (deprecated) — ::127.0.0.1, ::7f00:1 …
  if (firstFiveZero && g5 === 0) return true
  // ::ffff:0:0/96 IPv4-mapped — ::ffff:127.0.0.1, ::ffff:7f00:1
  if (firstFiveZero && g5 === 0xffff) return isBlockedIpv4Int(embeddedV4(g6, g7))
  // ::ffff:0:0:0/96 IPv4-translated (SIIT) — ::ffff:0:7f00:1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isBlockedIpv4Int(embeddedV4(g6, g7))
  }
  // 64:ff9b::/96 NAT64 well-known prefix
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4Int(embeddedV4(g6, g7))
  }
  // 64:ff9b:1::/48 local-use NAT64 — never a public destination
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true
  // 2002::/16 6to4 — IPv4 sits in groups 1–2
  if (g0 === 0x2002) return isBlockedIpv4Int(embeddedV4(g1, g2))
  // 2001::/32 Teredo — tunnelled, never a legitimate webhook host
  if (g0 === 0x2001 && g1 === 0) return true
  // 2001:db8::/32 documentation, 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0xdb8) return true
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true
  // fc00::/7 unique-local
  if ((g0 & 0xfe00) === 0xfc00) return true
  // fe80::/10 link-local and fec0::/10 deprecated site-local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true
  return false
}

// Names that are loopback / internal by convention, not by address.
function isInternalHostname(h: string): boolean {
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.localdomain') ||
    h.endsWith('.internal') ||
    h.endsWith('.home.arpa')
  )
}

function isPrivateOrReservedHost(hostname: string): boolean {
  let h = hostname.toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  // A trailing root dot ("localhost.") names the same host.
  while (h.endsWith('.')) h = h.slice(0, -1)
  if (h === '') return true

  if (h.includes(':')) {
    const groups = parseIpv6(h)
    return groups === null ? true : isBlockedIpv6(groups) // unparseable IPv6 -> refuse
  }

  const n = ipv4ToInt(h)
  if (n !== null) return isBlockedIpv4Int(n)

  return isInternalHostname(h)
}

// Returns an error message if the URL isn't acceptable, or null if it's fine.
export function validateWebhookUrl(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'Enter a valid URL'
  }
  if (u.protocol !== 'https:') return 'Webhook URL must use https://'
  if (u.username || u.password) return 'Webhook URL cannot contain a username or password'
  if (isPrivateOrReservedHost(u.hostname)) {
    return 'Webhook URL cannot point to a private, loopback, or link-local address'
  }
  return null
}
