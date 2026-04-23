import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { serverActions: { allowedOrigins: ['globproxy.com', '*.workers.dev'] } },
}

export default nextConfig
