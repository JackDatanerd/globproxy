import type { NextConfig } from 'next'

// Content-Security-Policy, REPORT-ONLY. The browser evaluates every rule below
// and posts violations to /api/csp-report (which writes them to the Worker
// log) but blocks nothing, so a missing allow-list entry cannot break
// checkout, Turnstile or Supabase the way an enforced policy would.
//
// Promote it by renaming the header to `Content-Security-Policy` once a
// week or two of real traffic produces no unexpected reports.
//
// Known looseness, deliberately left for the enforcement step rather than
// guessed at now: script-src carries 'unsafe-inline' because Next's own
// hydration bootstrap is inline and a nonce-based policy needs a per-request
// nonce minted in middleware — which would make every page dynamic and defeat
// the anonymous edge cache in custom-worker.ts. Revisit with that trade-off in
// view; object-src, base-uri, frame-ancestors and the connect/frame allow-lists
// below are already strict.
function supabaseOrigins(): string[] {
  const out = ['https://*.supabase.co', 'wss://*.supabase.co']
  try {
    const u = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
    out.push(u.origin, u.origin.replace(/^http/, 'ws'))
  } catch {
    /* env not present at config time — the wildcard entries still cover hosted projects */
  }
  return [...new Set(out)]
}

const CSP_REPORT_ONLY = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://js.paystack.co https://checkout.paystack.com`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
  `font-src 'self' data: https://fonts.gstatic.com`,
  `img-src 'self' data: blob: https:`,
  `connect-src 'self' ${supabaseOrigins().join(' ')} https://api.paystack.co https://checkout.paystack.com https://challenges.cloudflare.com`,
  `frame-src https://challenges.cloudflare.com https://checkout.paystack.com https://js.paystack.co`,
  `frame-ancestors 'self'`,
  `base-uri 'self'`,
  `object-src 'none'`,
  `form-action 'self'`,
  `report-uri /api/csp-report`,
].join('; ')

const nextConfig: NextConfig = {
  // The app defines no Server Actions at all (no 'use server' anywhere), so
  // this allow-list only needs the real site. It used to also trust every
  // *.workers.dev host — i.e. any Worker on any Cloudflare account — which
  // would be an open door the day a Server Action is added.
  experimental: { serverActions: { allowedOrigins: ['globproxy.com', 'www.globproxy.com'] } },
  // Don't announce the framework on every response.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(self)' },
          // allow-popups, not same-origin: payment and verification widgets may
          // open windows that must keep a reference back to this page.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
          { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
        ],
      },
      // The Worker is also reachable at its *.workers.dev address (see the
      // note in wrangler.jsonc). Keep that copy of the site out of search
      // results so it cannot compete with, or duplicate, the real domain.
      {
        source: '/:path*',
        has: [{ type: 'host', value: '(.*\\.)?workers\\.dev' }],
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ]
  },
  // `cloudflare:sockets` (used by lib/networkProbe.ts, server-side only) is a
  // Workers-runtime module, not an npm package — webpack has no loader for
  // the "cloudflare:" URI scheme and fails the build trying to bundle it.
  // Marking it external tells webpack to leave the import as-is at runtime;
  // Wrangler's own bundler (which processes this Worker's output afterward)
  // understands the scheme natively and resolves it correctly at deploy time.
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || []
      config.externals.push('cloudflare:sockets')
    }
    return config
  },
}

export default nextConfig
