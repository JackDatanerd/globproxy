import { renderPostOg } from '@/lib/blog/ogImage'
import { getPostBySlug } from '@/lib/blog/utils'

// No explicit `runtime = 'edge'` here on purpose: this app's OpenNext Cloudflare
// build (open-next.config.ts) bundles everything except middleware into a single
// Node-runtime Worker (wrapper: "cloudflare-node"). Declaring an edge runtime on
// an individual app-directory route tells Next to split it into a separate edge
// function target, which this OpenNext preset doesn't build for and fails on:
// "app/blog/[slug]/opengraph-image cannot use the edge runtime." next/og's
// ImageResponse works fine under the default (nodejs) runtime in Next 16.
export const alt = 'GlobProxy blog post'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPostBySlug(slug)
  return renderPostOg(post?.title ?? 'GlobProxy Blog', post?.category ?? 'Blog')
}
