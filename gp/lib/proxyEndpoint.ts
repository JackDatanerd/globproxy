// Geonode encodes geo-targeting and sticky-session info directly in the
// username field — it is NOT accepted by the reseller API's sub-user
// creation endpoint (confirmed against the live OpenAPI spec: that endpoint
// only takes username/password/trafficLimitMB/activeUntil/email). Targeting
// only takes effect when the *connection* username includes these suffixes.
// This file is the one place that builds that suffixed username, so the
// create form, ProxyCard, and the API routes can't drift out of sync again.
//
// Format, in order: <base>-country-<cc>[-state-<state>|-city-<city>][-session-<id>-lifetime-<secs>]
// Source: docs.geonode.com geo-targeting + sticky-session guides.
// - country: lowercase 2-letter ISO code
// - state / city: lowercase, no spaces — mutually exclusive, both require country
// - session id: 8-char lowercase alphanumeric; lifetime: seconds

export interface TargetingOptions {
  country?: string | null
  state?: string | null
  city?: string | null
  protocol?: string | null
  session_type?: string | null
  sticky_duration?: number | null // minutes
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

function slug(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, '')
}

export function genSessionId(): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 8 }, () => c[Math.floor(Math.random() * c.length)]).join('')
}

// sessionId is optional so callers generating multiple endpoints can pass a
// distinct id per endpoint (each gets its own stable peer IP under sticky).
export function buildProxyUsername(baseUsername: string, opts: TargetingOptions, sessionId?: string): string {
  let u = baseUsername

  if (opts.country) {
    u += `-country-${slug(opts.country)}`
    // State and city are mutually exclusive per Geonode — both require country.
    if (opts.state) {
      u += `-state-${slug(opts.state)}`
    } else if (opts.city) {
      u += `-city-${slug(opts.city)}`
    }
  }

  if (opts.session_type === 'sticky') {
    const id = sessionId ?? genSessionId()
    const lifetimeSeconds = Math.max(1, Math.round((opts.sticky_duration ?? 10) * 60))
    u += `-session-${id}-lifetime-${lifetimeSeconds}`
  }

  return u
}
