// Per-API-key source-IP allowlist (api_keys.allowed_ips, migration 0042).
// Entries are exact IPv4/IPv6 addresses or IPv4 CIDR blocks ("203.0.113.0/24").
// An empty list means "any IP" — the default, and the behaviour of every key
// created before the feature existed.
import { isValidIp } from '@/lib/ipWhitelist'

export const MAX_ALLOWED_IPS = 20

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const p = m.slice(1).map(Number)
  if (p.some((n) => n > 255)) return null
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
}

// Lower-cases and strips an IPv6 zone/brackets so textual variants compare equal.
function norm(ip: string): string {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, '')
}

export function isValidAllowlistEntry(entry: string): boolean {
  const e = entry.trim()
  const cidr = e.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (cidr) return ipv4ToInt(cidr[1]) !== null && Number(cidr[2]) >= 8 && Number(cidr[2]) <= 32 // /0–/7 would be "everyone" in disguise
  return isValidIp(e)
}

// Returns a cleaned list, or an error message.
export function parseAllowedIps(input: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'allowed_ips must be an array of IP addresses or IPv4 CIDR blocks.' }
  const cleaned = [...new Set(input.map((x) => (typeof x === 'string' ? norm(x) : '')))].filter(Boolean)
  if (cleaned.length > MAX_ALLOWED_IPS) return { ok: false, error: `allowed_ips can hold at most ${MAX_ALLOWED_IPS} entries.` }
  const bad = input.find((x) => typeof x !== 'string' || !isValidAllowlistEntry(norm(x)))
  if (bad !== undefined) return { ok: false, error: `"${String(bad).slice(0, 60)}" is not a valid IPv4/IPv6 address or IPv4 CIDR block (prefix /8 or longer).` }
  return { ok: true, value: cleaned }
}

export function ipAllowed(allowed: string[] | null | undefined, clientIp: string | null): boolean {
  if (!allowed || allowed.length === 0) return true
  if (!clientIp) return false // can't prove where it came from → not allowed
  const ip = norm(clientIp)
  const ipInt = ipv4ToInt(ip)
  for (const raw of allowed) {
    const entry = norm(raw)
    const cidr = entry.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
    if (cidr) {
      const base = ipv4ToInt(cidr[1])
      const bits = Number(cidr[2])
      if (ipInt === null || base === null) continue
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      if ((ipInt & mask) === (base & mask)) return true
    } else if (entry === ip) {
      return true
    }
  }
  return false
}
