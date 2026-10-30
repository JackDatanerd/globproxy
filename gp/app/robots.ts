import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Dashboard, admin, auth, invoice, and reseller-portal pages are
        // private/user-specific — already gated behind auth in middleware,
        // but excluded here too so nothing private ever gets crawled or
        // shows up as a dead login-walled result in search.
        // '/r/' is the affiliate redirect (/r/CODE -> signup). It is not content, and a crawler
        // following affiliate links would otherwise count as referral clicks.
        disallow: ['/dashboard', '/admin', '/auth', '/invoice', '/reseller', '/api', '/r/'],
      },
    ],
    sitemap: 'https://globproxy.com/sitemap.xml',
    host: 'https://globproxy.com',
  }
}
