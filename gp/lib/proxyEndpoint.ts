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
const SESSION_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function genSessionId(): string {
  // crypto, not Math.random — and rejection sampling so the 62-char alphabet
  // isn't modulo-biased (248 = 62 * 4 is the largest multiple below 256).
  const out: string[] = []
  while (out.length < 8) {
    const buf = crypto.getRandomValues(new Uint8Array(16))
    for (const b of buf) {
      if (b < 248 && out.length < 8) out.push(SESSION_CHARS[b % 62])
    }
  }
  return out.join('')
}

// Stable, non-secret session id derived from a seed (credential id) + index.
// The dashboard's ad hoc endpoints used genSessionId() inside useMemo, so
// every page load minted a new id — and since the id IS the sticky-session
// key, every reload silently moved "endpoint 1" to a different IP and
// invalidated any list the customer had already exported. Deterministic
// derivation keeps each endpoint on the same peer until they choose
// otherwise (named sessions via SessionManager are the explicit rotation
// mechanism). FNV-1a + xorshift: it only needs to be stable and spread out,
// not unpredictable (the username it lands in is already behind the
// credential's password).
export function deriveSessionId(seed: string, index = 0): string {
  let h = 2166136261
  const input = `${seed}#${index}`
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  let out = ''
  for (let i = 0; i < 8; i++) {
    h ^= h << 13; h >>>= 0
    h ^= h >>> 17
    h ^= h << 5; h >>>= 0
    out += SESSION_CHARS[h % 62]
  }
  return out
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
    // NaN (a non-numeric stored value) used to flow through Math.max/round
    // and produce a literal "lifetime-NaN" in the username.
    const rawLifetime = Number(opts.sticky_duration ?? 10)
    const lifetimeMinutes = Number.isFinite(rawLifetime) ? Math.min(1440, Math.max(1, Math.round(rawLifetime))) : 10
    // The id is interpolated straight into the username, so it is reduced to
    // [A-Za-z0-9] here no matter where it came from (a named session's token
    // is stored in a table the customer can write to).
    const cleanId = sessionId === undefined ? '' : String(sessionId).replace(/[^A-Za-z0-9]/g, '').slice(0, 32)
    const id = cleanId || genSessionId()
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
//
// RESTORED 2026-08-07 — this block was accidentally dropped by a later
// commit (an unrelated slug()/stock-calc edit was made from a stale copy
// of this file and silently clobbered it on merge). The injection itself
// stayed closed the whole time regardless — slug()'s character stripping
// is unconditional and doesn't depend on this check — but malformed input
// was being silently accepted instead of rejected with a clear error in
// the gap. Confirmed via direct adversarial testing against the compiled
// module (real injection payloads through country/state/asn, not just
// read the diff) before restoring.
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
