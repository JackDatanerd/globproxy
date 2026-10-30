import type { MetadataRoute } from 'next'
import { getAllPosts, getHelpArticles, postPath } from '@/lib/blog/utils'
import { LOCATION_COUNTRIES } from '@/lib/locations/data'

const BASE_URL = 'https://globproxy.com'

// Newest date among a set of posts — a truthful lastModified for an index page. Static routes with
// no real modification date (homepage, legal, locations) omit lastModified rather than stamping
// every build with "now", which would tell crawlers everything changed every deploy.
function newest(posts: { publishedAt: string; updatedAt?: string }[]): string | undefined {
  return posts.map((p) => p.updatedAt ?? p.publishedAt).sort().pop()
}

export default function sitemap(): MetadataRoute.Sitemap {
  const blogPosts = getAllPosts()
  const helpArticles = getHelpArticles()
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE_URL}/blog`, lastModified: newest(blogPosts), changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE_URL}/help`, lastModified: newest(helpArticles), changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/locations`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/status`, changeFrequency: 'daily', priority: 0.4 },
    { url: `${BASE_URL}/docs/api`, changeFrequency: 'monthly', priority: 0.5 },
    { url: `${BASE_URL}/terms`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/privacy`, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${BASE_URL}/refunds`, changeFrequency: 'yearly', priority: 0.3 },
  ]

  const postRoutes: MetadataRoute.Sitemap = [...blogPosts, ...helpArticles].map((post) => ({
    url: `${BASE_URL}${postPath(post)}`,
    lastModified: post.updatedAt ?? post.publishedAt,
    changeFrequency: 'monthly',
    priority: 0.6,
  }))

  const locationRoutes: MetadataRoute.Sitemap = LOCATION_COUNTRIES.map((c) => ({
    url: `${BASE_URL}/locations/${c.code}`,
    changeFrequency: 'monthly',
    priority: 0.5,
  }))

  return [...staticRoutes, ...postRoutes, ...locationRoutes]
}
