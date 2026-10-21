import { GeonodeApiError } from '@/lib/geonode'
import { NextResponse } from 'next/server'

// Validates the IP formats Geonode's Whitelisted IPs endpoints accept —
// individual IPv4 or IPv6 addresses only, no CIDR ranges (confirmed
// against the live OpenAPI spec: the schema is `format: "ip"`, not
// "cidr"/"ipv4net"/"ipv6net"). Validated here before ever reaching
// Geonode, since their error for a malformed IP is just a generic 400
// with no field-level detail to relay back to the user — this lets the
// UI point at the actual bad value instead.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// Deliberately permissive full-form/compressed IPv6 matcher (not a strict
// RFC 4291 parser) — good enough to catch obvious garbage, CIDR suffixes,
// and non-IP strings; Geonode's own API remains the final authority on
// validity.
const IPV6_RE =
  /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,7}:$|^([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}$|^([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}$|^([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}$|^([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})$|^:((:[0-9a-fA-F]{1,4}){1,7}|:)$/

// IPv4-mapped IPv6 (::ffff:1.2.3.4) — what dual-stack stacks report for a v4
// client. The base matcher above rejected it.
const IPV4_MAPPED_RE = new RegExp('^::ffff:' + IPV4_RE.source.slice(1), 'i')

export function isValidIp(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  return IPV4_RE.test(v) || IPV6_RE.test(v) || IPV4_MAPPED_RE.test(v)
}

// ── Non-routable addresses ────────────────────────────────────────────
// A whitelist entry only helps if it is the address the proxy provider will
// actually SEE the connection come from — i.e. a public one. The most common
// mistake (people behind a router typing the 192.168.x / 10.x address their
// OS shows) is syntactically valid but can never match, so the customer
// believes they're whitelisted while every connection is refused. Applied to
// ADDING only; removal accepts any valid IP so a bad legacy entry can still
// be deleted.
function v4NonPublic(o: number[]): boolean {
  const [a, b, c] = o
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||            // carrier-grade NAT
    (a === 169 && b === 254) ||                       // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||  // IETF / TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||          // benchmarking
    (a === 198 && b === 51 && c === 100) ||           // TEST-NET-2
    (a === 203 && b === 0 && c === 113) ||            // TEST-NET-3
    a >= 224                                          // multicast + reserved
  )
}

function expandV6(v: string): number[] | null {
  const halves = v.split('::')
  if (halves.length > 2) return null
  const parse = (s: string) => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)))
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null
  const out = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...tail]
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : null
}

function v6NonPublic(h: number[]): boolean {
  if (h.every((n) => n === 0)) return true                       // ::
  if (h.slice(0, 7).every((n) => n === 0) && h[7] === 1) return true // ::1
  if ((h[0] & 0xffc0) === 0xfe80) return true                     // fe80::/10
  if ((h[0] & 0xfe00) === 0xfc00) return true                     // fc00::/7
  if ((h[0] >> 8) === 0xff) return true                           // ff00::/8
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true             // documentation
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {   // v4-mapped
    return v4NonPublic([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255])
  }
  return false
}

export function isNonPublicIp(value: string): boolean {
  const v = value.trim()
  if (IPV4_RE.test(v)) return v4NonPublic(v.split('.').map(Number))
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return v4NonPublic(mapped[1].split('.').map(Number))
  const h = expandV6(v)
  return h ? v6NonPublic(h) : false
}

// Full add-time check: well-formed AND publicly routable. Returns the message
// to show, or null when fine.
export function validateIpForAdd(value: string): string | null {
  if (!isValidIp(value)) return 'Enter a valid IPv4 or IPv6 address (no ranges).'
  if (isNonPublicIp(value)) {
    return 'That is a private or reserved address, so it can never match a real connection. Use the PUBLIC IP of the machine that will connect (the “Use my IP” button fills it in).'
  }
  return null
}

// Mirrors the spec's `description` schema (minLength 1, maxLength 100) —
// required on every write, not optional client-side sugar.
export function validateDescription(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'A description is required (e.g. "Office IP").'
  }
  if (value.trim().length > 100) {
    return 'Description must be 100 characters or fewer.'
  }
  return null
}

export const MAX_BULK_ITEMS = 150

// Central place both whitelist routes funnel a thrown GeonodeApiError (or
// anything else) through, so status handling doesn't drift between the
// single-IP route and the bulk route.
export function whitelistErrorResponse(e: unknown): NextResponse {
  if (e instanceof GeonodeApiError) {
    // A 401/403 here means OUR reseller API key was rejected by Geonode,
    // not anything the end user did — surfacing Geonode's raw status as
    // the user's own response would read as "your session/permissions are
    // wrong," which is false. Collapse both to a generic upstream error
    // and log the real cause for us to look at.
    if (e.status === 401 || e.status === 403) {
      console.error('Geonode rejected reseller API credentials on whitelist call:', e.status, e.body)
      return NextResponse.json({ error: 'IP whitelist service is temporarily unavailable. Please try again shortly.', code: 'upstream_unavailable' }, { status: 502 })
    }
    // The provider's own `message` text is NEVER relayed: it is supplier-
    // authored copy that can name the supplier and carry account/sub-user
    // identifiers, and customers must never see either. Fixed wording only;
    // the real cause is logged.
    if (e.status === 404) {
      console.error('Whitelist upstream 404:', e.body)
      return NextResponse.json({ error: 'That whitelist entry could not be found.', code: 'not_found' }, { status: 404 })
    }
    if (e.status === 409) {
      console.error('Whitelist upstream 409:', e.body)
      return NextResponse.json({ error: 'That IP is already whitelisted, or the whitelist limit has been reached.', code: 'conflict' }, { status: 409 })
    }
    if (e.status === 400) {
      console.error('Whitelist upstream 400:', e.body)
      return NextResponse.json({ error: 'That request was rejected. Check the IP address and description and try again.', code: 'invalid_request' }, { status: 400 })
    }
    console.error('Unexpected Geonode whitelist error:', e.status, e.body)
    return NextResponse.json({ error: 'IP whitelist service is temporarily unavailable.', code: 'upstream_unavailable' }, { status: 502 })
  }
  console.error('Unexpected whitelist error:', e)
  return NextResponse.json({ error: 'Something went wrong. Please try again.', code: 'internal_error' }, { status: 500 })
}
