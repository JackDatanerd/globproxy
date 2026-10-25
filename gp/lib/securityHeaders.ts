// The response headers every answer should carry, in ONE place. next.config.ts sends them on
// everything the app renders; middleware.ts and custom-worker.ts also apply them to the
// answers THEY produce (login / 2FA redirects, the 503 page, edge guard and brake answers),
// because OpenNext returns a middleware-made response before it merges next.config headers.
// Import-free so the Worker bundle, next.config.ts and the unit tests can all load it.

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains'],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'SAMEORIGIN'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.paystack.com")'],
  // allow-popups, not same-origin: payment and verification widgets may open windows that
  // must keep a reference back to this page.
  ['Cross-Origin-Opener-Policy', 'same-origin-allow-popups'],
]

/** Sets every security header on `headers` (overwriting, so a response can never carry a weaker copy). */
export function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of SECURITY_HEADERS) headers.set(k, v)
}
