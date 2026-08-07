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

// Previously only trimmed + lowercased + stripped whitespace — hyphens and
// every other character passed straight through. Since these values get
// concatenated directly into the Geonode-facing connection username (see
// buildProxyUsername below), a country/state/city value containing its own
// "-key-value" segments (e.g. "us-state-x-lifetime-999999-session-AAAAAAAA")
// was passed through unchanged and let a caller inject arbitrary extra
// segments into their own username — forged lifetime/session values or
// malformed data sent straight to Geonode. Stripping everything outside
// [a-z0-9] closes this at the source: no separator character can survive
// slug(), so no injected segment can be constructed this way regardless of
// what validateTargeting() below does or misses. Defense in depth — the
// real gate is the whitelist validation in validateTargeting(), but this
// makes the builder itself safe even for legacy/pre-existing rows that
// predate that check.
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
    u += `-asn-${String(opts.asn).trim()}`
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

// country/state/city/asn were previously only checked for *presence*
// (state/city require a country) — never for content. Nothing stopped a
// caller bypassing the dashboard's dropdowns (which only ever submit real
// Geonode-sourced codes from /public/geo — see lib/geoTargeting.ts) and
// hitting POST /api/dashboard/proxies or POST /api/v1/sub-users directly
// with arbitrary strings. Those get concatenated straight into the
// Geonode-facing connection username in buildProxyUsername() above, so an
// unvalidated country/state/city/asn was a way to inject extra
// "-key-value" segments into a caller's own username (forged lifetime,
// forged session id, malformed data sent to Geonode). slug()'s character
// stripping (above) already closes the injection at the builder itself,
// but rejecting bad input here — loudly, with a clear 400 — is the actual
// gate: it stops silently-mangled input from ever being accepted as if it
// meant something else.
//
// Format matches what /public/geo actually serves (see lib/geoTargeting.ts
// header comment — codes are pre-slugged: lowercase, no spaces, no
// punctuation) rather than an exact whitelist lookup against the full
// Geonode dataset — that dataset is 210 countries x nested states/cities,
// not something worth loading per-request just to reject the injection
// case. A syntactically-valid-but-nonexistent code (e.g. "zz") still fails
// safely: Geonode's own API rejects it or returns no matching peers, same
// as it always would have for a typo.
// Cap is 64 chars, not an eyeballed round number — the actual Geonode
// dataset (public/geo) has real state codes up to 56 chars long (e.g.
// Transnistria's "administrativeterritorialunitsoftheleftbankofthedniester"),
// so a tighter cap would have rejected legitimate targeting. 64 gives
// headroom above the longest real value without allowing pathological
// input.
const COUNTRY_RE = /^[a-z]{2}$/
const STATE_CITY_RE = /^[a-z0-9]{1,64}$/
const ASN_RE = /^[0-9]{1,10}$/

export function validateTargeting(opts: TargetingOptions): string | null {
  if ((opts.state || opts.city) && !opts.country) {
    return 'A country is required when specifying a state or city.'
  }
  if (opts.country != null && opts.country !== '') {
    if (!COUNTRY_RE.test(slug(String(opts.country)))) {
      return 'Country must be a 2-letter code.'
    }
  }
  if (opts.state != null && opts.state !== '' && !STATE_CITY_RE.test(slug(String(opts.state)))) {
    return 'State contains invalid characters.'
  }
  if (opts.city != null && opts.city !== '' && !STATE_CITY_RE.test(slug(String(opts.city)))) {
    return 'City contains invalid characters.'
  }
  if (opts.asn != null && opts.asn !== '' && !ASN_RE.test(String(opts.asn).trim())) {
    return 'ASN must be numeric.'
  }
  return null
}
