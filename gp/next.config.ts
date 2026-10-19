import type { NextConfig } from 'next'

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.paystack.co https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.paystack.co https://checkout.paystack.com https://challenges.cloudflare.com",
  "frame-src https://checkout.paystack.com https://js.paystack.co https://challenges.cloudflare.com",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'report-uri /api/csp-report',
].join('; ')

const nextConfig: NextConfig = {
  experimental: { serverActions: { allowedOrigins: ['globproxy.com', '*.workers.dev'] } },
  // Baseline security headers on every response.
  //
  // Content-Security-Policy ships in REPORT-ONLY mode first: the app loads
  // Paystack's inline popup, Cloudflare Turnstile and Supabase, and a wrong
  // enforced CSP breaks checkout silently. Violations are POSTed to
  // /api/csp-report (visible in the Worker logs). Once a week of traffic shows
  // no legitimate violations, rename the header to Content-Security-Policy and
  // replace 'unsafe-inline' with nonces.
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
          { key: 'Content-Security-Policy-Report-Only', value: CSP_REPORT_ONLY },
        ],
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
