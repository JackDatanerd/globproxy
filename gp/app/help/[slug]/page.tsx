import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import PostArticle from '@/components/blog/PostArticle'
import { getHelpArticles, getHelpArticleBySlug } from '@/lib/blog/utils'

export function generateStaticParams() {
  return getHelpArticles().map((post) => ({ slug: post.slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const post = getHelpArticleBySlug(slug)
  if (!post) return {}

  return {
    title: `${post.title} — GlobProxy`,
    description: post.description,
    alternates: { canonical: `/help/${post.slug}` },
    openGraph: {
      title: post.title,
      description: post.description,
      url: `/help/${post.slug}`,
      type: 'article',
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt ?? post.publishedAt,
    },
    twitter: { card: 'summary_large_image', title: post.title, description: post.description },
  }
}

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getHelpArticleBySlug(slug)
  if (!post) notFound()
  return <PostArticle post={post} />
}
