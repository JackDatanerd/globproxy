// Geonode encodes geo-targeting and sticky-session info directly in the
// username field — it is NOT accepted by the reseller API's sub-user
// creation endpoint (confirmed against the live OpenAPI spec: that endpoint
// only takes username/password/trafficLimitMB/activeUntil/email). Targeting
// only takes effect when the *connection* username includes these suffixes.
// This file is the one place that builds that suffixed username, so the
// create form, ProxyCard, and the API routes can't drift out of sync again.
//
// Format, in order: <base>-type-residential-country-<cc>[-state-<state>][-city-<city>][-asn-<n>][-lifetime-<min>-session-<id>]
// Source: confirmed directly from live credential strings shared during
// this project (Manchester, Anchorage, Crystal City, Fountain Inn) — state
// and city are BOTH included together, not mutually exclusive as generic
// third-party docs claimed. That wrong assumption previously caused city to
// be silently dropped whenever state was also set.
// - country: lowercase 2-letter ISO code
// - state / city: lowercase, no spaces
// - session id: 8-char mixed-case alphanumeric; lifetime: raw minutes

export interface TargetingOptions {
  country?: string | null
  state?: string | null
  city?: string | null
  asn?: string | number | null
  protocol?: string | null
  session_type?: string | null
  sticky_duration?: number | null // minutes — sent as-is, Geonode's lifetime is in minutes, not seconds
}

const PORTS = {
  http:   { rotating: 9000,  sticky: 10000 },
  socks5: { rotating: 11000, sticky: 12000 },
} as const

// Ports are keyed on BOTH protocol and session type — this was previously
// keyed on protocol alone (with an unverified 7000 for socks5), which was
// wrong for every sticky session regardless of protocol.
export function getProxyPort(protocol?: string | null, sessionType?: string | null): number {
  const proto = protocol === 'socks5' ? 'socks5' : 'http'
  const session = sessionType === 'sticky' ? 'sticky' : 'rotating'
  return PORTS[proto][session]
}

// Strips everything except a-z0-9 (after lowercasing) — not just whitespace.
// country/state/city/asn are never validated against a whitelist before
// reaching here, so without stripping hyphens specifically, a caller could
// inject extra "-segment-value" pairs into their own connection username
// (e.g. a fake "-asn-" or "-session-" override). Self-scoped only — it
// can't touch another tenant's credential — but there's no reason to allow
// the delimiter character through at all.
function slug(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Geonode's own dashboard generates mixed-case alphanumeric session IDs
// (e.g. "mBXMRo") — likely just an opaque token, but matching their own
// pattern rather than the lowercase-only guess from generic docs.
export function genSessionId(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join('')
}

// sessionId is optional so callers generating multiple endpoints can pass a
// distinct id per endpoint (each gets its own stable peer IP under sticky).
//
// NOTE: this silently drops state/city below if country isn't set — that's
// intentional here since this function also renders already-stored
// credentials (ProxyCard, SessionManager), where throwing would crash the
// UI for any legacy row with that data shape. The actual validation lives
// at the write path — see validateTargeting() below — so a caller can never
// get this combination persisted in the first place.
export function buildProxyUsername(baseUsername: string, opts: TargetingOptions, sessionId?: string): string {
  // Confirmed from a live Geonode dashboard export (2026-07):
  // geonode_xxx-type-residential-country-us-state-southcarolina-city-fountaininn-asn-13868-lifetime-1440-session-mBXMRo
  // Order: type, country, state|city, asn, then (sticky only) lifetime, session.
  let u = `${baseUsername}-type-residential`

  if (opts.country) {
    u += `-country-${slug(opts.country)}`
    // Confirmed from real examples: state and city are BOTH included when
    // both are set (not mutually exclusive — that was the bug).
    if (opts.state) u += `-state-${slug(opts.state)}`
    if (opts.city)  u += `-city-${slug(opts.city)}`
  }

  if (opts.asn) {
    u += `-asn-${slug(String(opts.asn))}`
  }

  if (opts.session_type === 'sticky') {
    // CORRECTED: previously had session before lifetime, and converted
    // sticky_duration (minutes) to seconds. Real format is lifetime in raw
    // MINUTES, then session — e.g. -lifetime-1440-session-mBXMRo for a
    // 24-hour (1440 min) sticky session. Confirmed directly from a live
    // credential string, not from third-party docs (which said seconds).
    const lifetimeMinutes = Math.max(1, Math.round(opts.sticky_duration ?? 10))
    const id = sessionId ?? genSessionId()
    u += `-lifetime-${lifetimeMinutes}-session-${id}`
  }

  return u
}

// Validates targeting inputs before they're ever written to a credential
// row. Previously nothing rejected state/city with no country — the
// dashboard form let a user pick "Any country" and still type a state, and
// the v1 API had no check at all. buildProxyUsername() would then silently
// drop the state/city with zero indication the request was only partially
// honored. Callers (dashboard proxy creation, v1 sub-user creation) should
// run this before insert and surface the error, so the bad combination can
// never actually get persisted — buildProxyUsername's silent-drop behavior
// stays purely as a defensive fallback for rendering pre-existing rows.
export function validateTargeting(opts: TargetingOptions): string | null {
  if ((opts.state || opts.city) && !opts.country) {
    return 'A country is required when specifying a state or city.'
  }
  return null
}
