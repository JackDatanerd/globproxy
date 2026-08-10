// Validates a user-supplied outbound webhook URL before we let our own
// server fetch() it. Same bug class Passthrough's SSRF guard was built to
// catch (see that codebase's fix for the IPv6-mapped bypass) — a naive
// "reject 127.0.0.1 / localhost" string check misses hostnames that
// resolve or literally spell out a loopback/private address in a form
// that check doesn't recognize, e.g. the IPv6-mapped-IPv4 hex form
// `::ffff:7f00:1` instead of the dotted `::ffff:127.0.0.1`. This guard is
// intentionally the same shape as that one, ported fresh here since
// GlobProxy didn't have this class of problem before webhooks introduced
// the first user-controlled outbound URL in this codebase.
//
// This is a defense-in-depth literal-address check, not DNS-rebinding
// protection — it can't resolve hostnames itself without an extra round
// trip. Combined with the https-only requirement below, it closes the
// easy/obvious version of "point our server at my own internal network."

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1, 5).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

const PRIVATE_IPV4_RANGES: [string, number][] = [
  ['0.0.0.0', 8],      // "this network"
  ['10.0.0.0', 8],     // RFC1918
  ['100.64.0.0', 10],  // CGNAT
  ['127.0.0.0', 8],    // loopback
  ['169.254.0.0', 16], // link-local
  ['172.16.0.0', 12],  // RFC1918
  ['192.0.0.0', 24],   // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15],  // benchmarking
  ['224.0.0.0', 4],    // multicast
]

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => {
    const baseInt = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (baseInt & mask)
  })
}

// Pulls an embedded IPv4 out of an IPv6-mapped address in either the
// dotted form (::ffff:127.0.0.1) or the pure-hex form (::ffff:7f00:1) —
// the second is the exact form that slipped past Passthrough's original
// check, so it gets handled explicitly here rather than assumed away.
function extractEmbeddedIpv4(hostname: string): string | null {
  const h = hostname.toLowerCase()
  let m = h.match(/^\[?::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\]?$/)
  if (m) return m[1]
  m = h.match(/^\[?::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]?$/)
  if (m) {
    const hi = parseInt(m[1], 16)
    const lo = parseInt(m[2], 16)
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 link-local + unique-local
  const embedded = extractEmbeddedIpv4(h)
  if (embedded) return isPrivateIpv4(embedded)
  return isPrivateIpv4(h)
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
  if (isPrivateOrLoopbackHost(u.hostname)) {
    return 'Webhook URL cannot point to a private, loopback, or link-local address'
  }
  return null
}
