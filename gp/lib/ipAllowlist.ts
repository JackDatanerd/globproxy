// Per-API-key source-IP allowlist (api_keys.allowed_ips, migrations 0042/0054).
// Entries are exact IPv4/IPv6 addresses or CIDR blocks ("203.0.113.0/24",
// "2001:db8:1234::/48"). An empty list means "any IP" — the default, and the
// behaviour of every key created before the feature existed.
//
// Addresses are compared as NUMBERS, never as text. IPv6 has many spellings of
// one address ("2001:0DB8::1", "2001:db8:0:0:0:0:0:1", "[2001:db8::1]"); the
// old string comparison locked a key out whenever the entry wasn't typed in
// exactly the compressed form Cloudflare reports. Entries are stored in a
// canonical form, and entries saved before this change are re-parsed at match
// time, so no data migration is needed.

export const MAX_ALLOWED_IPS = 20

// /0–/7 (v4) and /0–/31 (v6) would be "everyone" in disguise.
const MIN_V4_PREFIX = 8
const MIN_V6_PREFIX = 32

// An address is a list of 16-bit groups: 2 for IPv4, 8 for IPv6. (No BigInt:
// the project targets below ES2020.)
interface Ip { v: 4 | 6; g: number[] }

function parseV4(s: string): number[] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o: number[] = []
  for (const part of m.slice(1)) {
    // Leading zeros are ambiguous (octal in some parsers) — refuse them.
    if (part.length > 1 && part.startsWith('0')) return null
    const n = Number(part)
    if (n > 255) return null
    o.push(n)
  }
  return [(o[0] << 8) | o[1], (o[2] << 8) | o[3]]
}

function parseV6(raw: string): number[] | null {
  let s = raw
  if (s.includes('%')) return null // zone ids are never valid for a remote peer
  // Embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) → two hex groups.
  const tail = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (tail) {
    const v4 = parseV4(tail[2])
    if (v4 === null) return null
    s = `${tail[1]}${v4[0].toString(16)}:${v4[1].toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parseGroups(halves[0])
  const rest = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!head || !rest) return null
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null // '::' must stand for at least one group
    return [...head, ...new Array(fill).fill(0), ...rest]
  }
  return head.length === 8 ? head : null
}

function parseIp(input: string): Ip | null {
  const s = input.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!s) return null
  if (s.includes(':')) {
    const g = parseV6(s)
    if (g === null) return null
    // ::ffff:a.b.c.d IS the IPv4 address a.b.c.d — compare it as such.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { v: 4, g: [g[6], g[7]] }
    return { v: 6, g }
  }
  const g = parseV4(s)
  return g === null ? null : { v: 4, g }
}

function v4String(g: number[]): string {
  return [g[0] >> 8, g[0] & 0xff, g[1] >> 8, g[1] & 0xff].join('.')
}

function v6String(g: number[]): string {
  // Longest run of zero groups (length ≥ 2) becomes '::'.
  let bestStart = -1, bestLen = 0
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue }
    let j = i
    while (j < 8 && g[j] === 0) j++
    if (j - i > bestLen) { bestStart = i; bestLen = j - i }
    i = j
  }
  if (bestLen < 2) return g.map((x) => x.toString(16)).join(':')
  const left = g.slice(0, bestStart).map((x) => x.toString(16)).join(':')
  const right = g.slice(bestStart + bestLen).map((x) => x.toString(16)).join(':')
  return `${left}::${right}`
}

function ipString(ip: Ip): string {
  return ip.v === 4 ? v4String(ip.g) : v6String(ip.g)
}

/** Canonical text for one address, or null if it isn't an IP. */
export function canonicalIp(input: string): string | null {
  const ip = parseIp(input)
  return ip ? ipString(ip) : null
}

interface Entry { ip: Ip; bits: number; cidr: boolean }

function parseEntry(input: string): Entry | null {
  const t = input.trim()
  const slash = t.indexOf('/')
  if (slash === -1) {
    const ip = parseIp(t)
    return ip ? { ip, bits: ip.v === 4 ? 32 : 128, cidr: false } : null
  }
  const base = parseIp(t.slice(0, slash))
  const bitsStr = t.slice(slash + 1)
  if (!base || !/^\d{1,3}$/.test(bitsStr)) return null
  const bits = Number(bitsStr)
  const max = base.v === 4 ? 32 : 128
  const min = base.v === 4 ? MIN_V4_PREFIX : MIN_V6_PREFIX
  if (bits < min || bits > max) return null
  return { ip: base, bits, cidr: true }
}

export function isValidAllowlistEntry(entry: string): boolean {
  return parseEntry(entry) !== null
}

function canonicalEntry(input: string): string | null {
  const e = parseEntry(input)
  if (!e) return null
  const base = ipString(e.ip)
  // "1.2.3.4/32" and "2001:db8::1/128" are just that one host — stored as the bare
  // address so the same host cannot sit in the list twice under two spellings.
  const single = e.bits === (e.ip.v === 4 ? 32 : 128)
  return e.cidr && !single ? `${base}/${e.bits}` : base
}

// Keys that can MOVE BANDWIDTH ('allocate' scope) skip the dashboard's 2FA step-up,
// so their IP pin is the only thing standing between a leaked key and a transfer.
// A pin of 8.0.0.0/8 (16.7 million addresses) is a pin in name only: allocate keys
// must be tied to a block no wider than a /24 (256 addresses) or an IPv6 /48.
export const ALLOCATE_MAX_V4_BLOCK_PREFIX = 24
export const ALLOCATE_MAX_V6_BLOCK_PREFIX = 48

/** null when every entry is narrow enough for an allocate key, else a message saying which is too wide. */
export function allocateAllowlistProblem(allowed: string[] | null | undefined): string | null {
  if (!allowed || allowed.length === 0) {
    return 'Keys with the "allocate" scope must be restricted to specific IP addresses (allowed_ips).'
  }
  for (const raw of allowed) {
    const e = parseEntry(raw)
    if (!e) continue // unparseable entries never match anything; they cannot widen the key
    const min = e.ip.v === 4 ? ALLOCATE_MAX_V4_BLOCK_PREFIX : ALLOCATE_MAX_V6_BLOCK_PREFIX
    if (e.bits < min) {
      return `"${raw.slice(0, 60)}" is too broad for an "allocate" key: use single addresses or blocks no wider than /${ALLOCATE_MAX_V4_BLOCK_PREFIX} (IPv4) / /${ALLOCATE_MAX_V6_BLOCK_PREFIX} (IPv6).`
    }
  }
  return null
}

// Returns a cleaned (canonical, de-duplicated) list, or an error message.
export function parseAllowedIps(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'allowed_ips must be an array of IP addresses or CIDR blocks.' }
  const out: string[] = []
  for (const x of input) {
    const c = typeof x === 'string' ? canonicalEntry(x) : null
    if (c === null) {
      return {
        ok: false,
        error: `"${String(x).slice(0, 60)}" is not a valid IPv4/IPv6 address or CIDR block (IPv4 prefix /${MIN_V4_PREFIX} or longer, IPv6 prefix /${MIN_V6_PREFIX} or longer).`,
      }
    }
    if (!out.includes(c)) out.push(c)
  }
  if (out.length > MAX_ALLOWED_IPS) return { ok: false, error: `allowed_ips can hold at most ${MAX_ALLOWED_IPS} entries.` }
  return { ok: true, value: out }
}

// Do the first `bits` bits of a and b agree?
function prefixMatches(a: number[], b: number[], bits: number): boolean {
  for (let i = 0; i < a.length && bits > 0; i++, bits -= 16) {
    if (bits >= 16) { if (a[i] !== b[i]) return false; continue }
    const mask = (0xffff << (16 - bits)) & 0xffff
    return (a[i] & mask) === (b[i] & mask)
  }
  return true
}

export function ipAllowed(allowed: string[] | null | undefined, clientIp: string | null): boolean {
  if (!allowed || allowed.length === 0) return true
  if (!clientIp) return false // can't prove where it came from → not allowed
  const ip = parseIp(clientIp)
  if (!ip) return false
  for (const raw of allowed) {
    const entry = parseEntry(raw)
    if (!entry || entry.ip.v !== ip.v) continue
    if (prefixMatches(entry.ip.g, ip.g, entry.bits)) return true
  }
  return false
}
