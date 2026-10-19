import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { serverActions: { allowedOrigins: ['globproxy.com', '*.workers.dev'] } },
  // Baseline security headers on every response. Deliberately no
  // Content-Security-Policy yet: the app loads Paystack's inline popup,
  // Cloudflare Turnstile and Supabase, and a wrong CSP breaks checkout
  // silently — add one in Report-Only mode first.
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
