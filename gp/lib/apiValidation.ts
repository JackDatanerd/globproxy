import { validateTargeting } from '@/lib/proxyEndpoint'

// Shared by POST /api/v1/sub-users and POST /api/dashboard/proxies so the
// two entry points can never drift apart on what they accept. Everything is
// checked BEFORE bandwidth is reserved or Geonode is touched: previously an
// unknown protocol / non-integer sticky_duration only failed at the DB CHECK
// or column type, after a reservation and a real Geonode sub-user already
// existed, and surfaced as a 500 carrying the raw Postgres message.

export const MAX_GB_PER_CREDENTIAL = 100_000
export const MIN_GB_PER_CREDENTIAL = 0.01
export const MAX_STICKY_MINUTES = 1440 // 24h — the longest lifetime Geonode's own dashboard produces
export const MAX_ENDPOINT_COUNT = 100
export const MAX_LABEL_LENGTH = 100

export type CreateCredentialInput = {
  label: string | null
  gb_allocated: number
  country: string | null
  state: string | null
  city: string | null
  asn: string | null
  session_type: 'rotating' | 'sticky'
  protocol: 'http' | 'socks5'
  sticky_duration: number | null
  endpoint_count: number
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

// Accepts a JSON number, or a plain decimal string ("5", "0.5") — never
// NaN/Infinity, hex, exponent forms, or other coercions Number() allows.
export function parseFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return null
}

function parseInteger(v: unknown): number | null {
  const n = parseFiniteNumber(v)
  return n !== null && Number.isInteger(n) ? n : null
}

function optionalString(v: unknown, field: string): Parsed<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: `${field} must be a string.` }
  return { ok: true, value: v.trim() || null }
}

function slugValue(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function parseLabel(v: unknown): Parsed<string | null> {
  if (v === undefined || v === null || v === '') return { ok: true, value: null }
  if (typeof v !== 'string') return { ok: false, error: 'label must be a string.' }
  // eslint-disable-next-line no-control-regex
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (cleaned.length > MAX_LABEL_LENGTH) return { ok: false, error: `label must be ${MAX_LABEL_LENGTH} characters or fewer.` }
  return { ok: true, value: cleaned || null }
}

export function parseTargeting(body: any): Parsed<Pick<CreateCredentialInput, 'country' | 'state' | 'city' | 'asn'>> {
  const country = optionalString(body?.country, 'country'); if (!country.ok) return country
  const state = optionalString(body?.state, 'state');       if (!state.ok) return state
  const city = optionalString(body?.city, 'city');           if (!city.ok) return city
  let asn: string | null = null
  if (body?.asn !== undefined && body?.asn !== null && body?.asn !== '') {
    if (typeof body.asn !== 'string' && typeof body.asn !== 'number') return { ok: false, error: 'asn must be a string or number.' }
    asn = String(body.asn).trim()
  }

  const err = validateTargeting({ country: country.value, state: state.value, city: city.value, asn })
  if (err) return { ok: false, error: err }

  return {
    ok: true,
    value: {
      country: country.value ? slugValue(country.value) : null,
      state: state.value ? slugValue(state.value) : null,
      city: city.value ? slugValue(city.value) : null,
      asn: asn || null,
    },
  }
}

export function parseSessionOptions(body: any, defaults?: { session_type?: string; protocol?: string }): Parsed<{
  session_type: 'rotating' | 'sticky'
  protocol: 'http' | 'socks5'
  sticky_duration: number | null
}> {
  const session_type = body?.session_type ?? defaults?.session_type ?? 'rotating'
  const protocol = body?.protocol ?? defaults?.protocol ?? 'http'
  if (session_type !== 'rotating' && session_type !== 'sticky') return { ok: false, error: 'session_type must be "rotating" or "sticky".' }
  if (protocol !== 'http' && protocol !== 'socks5') return { ok: false, error: 'protocol must be "http" or "socks5".' }

  let sticky_duration: number | null = null
  if (body?.sticky_duration !== undefined && body?.sticky_duration !== null && body?.sticky_duration !== '') {
    const n = parseInteger(body.sticky_duration)
    if (n === null || n < 1 || n > MAX_STICKY_MINUTES) {
      return { ok: false, error: `sticky_duration must be a whole number of minutes between 1 and ${MAX_STICKY_MINUTES}.` }
    }
    // Only meaningful for sticky sessions; a rotating credential never uses it.
    sticky_duration = session_type === 'sticky' ? n : null
  }
  return { ok: true, value: { session_type, protocol, sticky_duration } }
}

export function parseCreateCredential(body: unknown): Parsed<CreateCredentialInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const b = body as Record<string, unknown>

  const gb = parseFiniteNumber(b.gb_allocated)
  if (gb === null || gb <= 0) return { ok: false, error: 'gb_allocated is required and must be a number > 0.' }
  if (gb < MIN_GB_PER_CREDENTIAL) return { ok: false, error: `gb_allocated must be at least ${MIN_GB_PER_CREDENTIAL}.` }
  if (gb > MAX_GB_PER_CREDENTIAL) return { ok: false, error: `gb_allocated must be at most ${MAX_GB_PER_CREDENTIAL}.` }

  const label = parseLabel(b.label); if (!label.ok) return label
  const targeting = parseTargeting(b); if (!targeting.ok) return targeting
  const session = parseSessionOptions(b); if (!session.ok) return session

  let endpoint_count = 1
  if (b.endpoint_count !== undefined && b.endpoint_count !== null && b.endpoint_count !== '') {
    const n = parseInteger(b.endpoint_count)
    if (n === null || n < 1 || n > MAX_ENDPOINT_COUNT) {
      return { ok: false, error: `endpoint_count must be a whole number between 1 and ${MAX_ENDPOINT_COUNT}.` }
    }
    endpoint_count = n
  }

  return {
    ok: true,
    value: {
      label: label.value,
      gb_allocated: Math.round(gb * 10000) / 10000,
      ...targeting.value,
      ...session.value,
      endpoint_count,
    },
  }
}

export function parseGbAmount(v: unknown, field = 'gb_amount'): Parsed<number> {
  const n = parseFiniteNumber(v)
  if (n === null || n <= 0) return { ok: false, error: `${field} must be a number greater than 0.` }
  if (n > MAX_GB_PER_CREDENTIAL) return { ok: false, error: `${field} must be at most ${MAX_GB_PER_CREDENTIAL}.` }
  return { ok: true, value: Math.round(n * 10000) / 10000 }
}
