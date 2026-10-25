import type { NextConfig } from 'next'
import { buildCsp, cspHeaderName } from './lib/csp'
import { unprotectedSource } from './lib/protectedPaths'
import { SECURITY_HEADERS } from './lib/securityHeaders'

// Content-Security-Policy. REPORT-ONLY by default: the browser evaluates every
// rule below and posts violations to /api/csp-report (which logs them and counts
// them per directive / blocked URL / page — see Admin → Settings) but blocks
// nothing, so a missing allow-list entry cannot break checkout, Turnstile or
// Supabase the way an enforced policy would.
//
// Promote it WITHOUT a code change: once a week or two of real traffic produces
// no unexpected reports, set the build variable CSP_MODE=enforce (GitHub →
// Settings → Variables → Actions → CSP_MODE; deploy.yml passes it to the build)
// and redeploy. Unset it (or any other value) to go back to report-only. The
// header is fixed at build time, so a redeploy is what applies the change.
//
// Two policies, one source (lib/csp.ts):
//  - THIS file sets the static one every response carries. Its script-src keeps
//    'unsafe-inline', because Next's hydration bootstrap is inline and a nonce
//    needs a per-request value — which would make the public pages dynamic and
//    defeat the anonymous edge cache in custom-worker.ts.
//  - middleware.ts sets its own instead (the static header is not sent there), on
//    /dashboard, /reseller, /admin and /invoice only — per-user, never cached — with
//    a per-request-nonce + 'strict-dynamic' policy that has no 'unsafe-inline' for
//    scripts. That is where an injected
//    script would do real damage, so that is where the strict policy matters.
// Both follow CSP_MODE. object-src, base-uri, frame-ancestors and the
// connect/frame allow-lists are strict in both.
const CSP_HEADER_NAME = cspHeaderName()
const CSP_POLICY = buildCsp()

const nextConfig: NextConfig = {
  // The app defines no Server Actions at all (no 'use server' anywhere), so
  // this allow-list only needs the real site. It used to also trust every
  // *.workers.dev host — i.e. any Worker on any Cloudflare account — which
  // would be an open door the day a Server Action is added.
  experimental: { serverActions: { allowedOrigins: ['globproxy.com', 'www.globproxy.com'] } },
  // The Worker has no CSP_MODE at runtime (it is a build variable), and middleware.ts
  // needs it to pick report-only vs enforcing for its nonce policy: inline it.
  env: { CSP_MODE: process.env.CSP_MODE ?? '', CSP_MODE_PROTECTED: process.env.CSP_MODE_PROTECTED ?? '' },
  // Don't announce the framework on every response.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: SECURITY_HEADERS.map(([key, value]) => ({ key, value })),
      },
      // The static CSP, on everything EXCEPT the signed-in areas: middleware.ts sets
      // its own per-request-nonce policy there, and sending both would have the browser
      // evaluate (and report against) two policies. Both this and
      // middleware's isProtected read the prefixes from lib/protectedPaths.ts (whole path
      // segments), so they cannot drift apart.
      {
        source: unprotectedSource(),
        headers: [{ key: CSP_HEADER_NAME, value: CSP_POLICY }],
      },
      // Admin API answers (user lists, payout destinations, exports) are never cacheable.
      {
        source: '/api/admin/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
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
