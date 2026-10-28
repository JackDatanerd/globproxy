import type { MetadataRoute } from 'next'
import { getAllPosts, getHelpArticles, postPath } from '@/lib/blog/utils'
import { LOCATION_COUNTRIES } from '@/lib/locations/data'

const BASE_URL = 'https://globproxy.com'

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: BASE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE_URL}/blog`, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE_URL}/help`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/locations`, changeFrequency: 'weekly', priority: 0.7 },
    { url: `${BASE_URL}/docs/api`, changeFrequency: 'monthly', priority: 0.5 },
  ]

  const postRoutes: MetadataRoute.Sitemap = [...getAllPosts(), ...getHelpArticles()].map((post) => ({
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
