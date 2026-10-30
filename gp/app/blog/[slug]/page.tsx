import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import PostArticle from '@/components/blog/PostArticle'
import { seoTitle } from '@/lib/blog/seoTitles'
import { pageMetadata } from '@/lib/seo'
import { getAllPosts, getPostBySlug } from '@/lib/blog/utils'

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const post = getPostBySlug(slug)
  if (!post) return {}

  // The <title> is the short SEO title from lib/blog/seoTitles.ts; Open Graph and Twitter keep the
  // full headline. The social image comes from this route's file-based opengraph-image.
  return pageMetadata({
    title: seoTitle(post),
    socialTitle: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    defaultImage: false,
    article: { publishedTime: post.publishedAt, modifiedTime: post.updatedAt ?? post.publishedAt },
  })
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPostBySlug(slug)
  if (!post) notFound()
  return <PostArticle post={post} />
}
