import type { Metadata } from 'next'
import './globals.css'
import { Toaster } from 'react-hot-toast'
import JsonLd from '@/components/JsonLd'

const organizationSchema = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'GlobProxy',
  url: 'https://globproxy.com',
  logo: 'https://globproxy.com/android-chrome-512x512.png',
  description: 'Residential proxy network — non-expiring bandwidth, 195 countries, city-level targeting.',
}

export const metadata: Metadata = {
  title: 'GlobProxy — Residential Proxies That Never Expire',
  description: 'Buy residential bandwidth once, use it forever. 35M+ IPs, 195 countries, city-level targeting. No subscriptions.',
  metadataBase: new URL('https://globproxy.com'),
  openGraph: {
    title: 'GlobProxy — Residential Proxies That Never Expire',
    description: 'Buy once, use forever. 35M+ IPs, 195 countries, no subscriptions.',
    url: 'https://globproxy.com',
    siteName: 'GlobProxy',
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: 'GlobProxy' }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'GlobProxy', images: ['/og-image.png'] },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  manifest: '/site.webmanifest',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <JsonLd data={organizationSchema} />
        {children}
        <Toaster position="top-right" toastOptions={{ style: { fontFamily: 'DM Sans, sans-serif', fontSize: '14px' } }} />
      </body>
    </html>
  )
}
