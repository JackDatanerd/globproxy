import Link from 'next/link'
import Navbar from '@/components/Navbar'
import JsonLd from '@/components/JsonLd'
import PostCard from '@/components/blog/PostCard'
import PostBody, { PostFaq } from '@/components/blog/PostBody'
import { getRelatedPosts, postPath, readingTime } from '@/lib/blog/utils'
import type { BlogPost } from '@/lib/blog/types'

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
}

// One article layout for both /blog/<slug> and /help/<slug>. The section only
// changes the breadcrumb, the closing call to action and the related-reading
// heading; everything else (structured data, body, FAQ) is identical.
export default function PostArticle({ post }: { post: BlogPost }) {
  const isHelp = post.section === 'help'
  const rootHref = isHelp ? '/help' : '/blog'
  const rootLabel = isHelp ? 'Help' : 'Blog'
  const related = getRelatedPosts(post)
  const url = `https://globproxy.com${postPath(post)}`

  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt ?? post.publishedAt,
    author: { '@type': 'Organization', name: 'GlobProxy', url: 'https://globproxy.com' },
    publisher: { '@type': 'Organization', name: 'GlobProxy', url: 'https://globproxy.com' },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://globproxy.com' },
      { '@type': 'ListItem', position: 2, name: rootLabel, item: `https://globproxy.com${rootHref}` },
      { '@type': 'ListItem', position: 3, name: post.title, item: url },
    ],
  }

  const faqSchema = post.faq
    ? {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: post.faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      }
    : null

  return (
    <>
      <JsonLd data={articleSchema} />
      <JsonLd data={breadcrumbSchema} />
      {faqSchema && <JsonLd data={faqSchema} />}
      <Navbar />
      <article className="max-w-3xl mx-auto px-6 py-16">
        <nav className="text-xs font-mono text-muted mb-8 flex items-center gap-2">
          <Link href={rootHref} className="hover:text-ink transition-colors">{rootLabel}</Link>
          <span>/</span>
          <span className="text-ink2">{post.category}</span>
        </nav>
        <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-5">
          {post.category}
        </div>
        <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink leading-[1.1] mb-5">
          {post.title}
        </h1>
        <div className="flex items-center gap-3 text-sm text-muted font-mono mb-12">
          <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
          <span>·</span>
          <span>{readingTime(post)}</span>
        </div>
        <PostBody body={post.body} />
        {post.faq && <PostFaq items={post.faq} />}

        {isHelp ? (
          <div className="mt-14 pt-10 border-t border-border bg-surface rounded-2xl p-8 text-center">
            <h2 className="font-display text-2xl font-bold text-ink tracking-tight mb-2">Still stuck?</h2>
            <p className="text-ink2 font-light text-sm mb-6">
              Email us at support@globproxy.com and include your account email and what you see on screen.
            </p>
            <a
              href="mailto:support@globproxy.com"
              className="inline-flex items-center gap-2 bg-accent text-white px-7 py-3 rounded-xl font-medium hover:-translate-y-0.5 transition-all"
            >
              Contact support →
            </a>
          </div>
        ) : (
          <div className="mt-14 pt-10 border-t border-border bg-ink rounded-2xl p-8 text-center">
            <h2 className="font-display text-2xl font-bold text-white tracking-tight mb-2">
              Try it on 1 GB before you commit to more.
            </h2>
            <p className="text-white/50 font-light text-sm mb-6">Non-expiring bandwidth, 195 countries, city-level targeting — from $4.50.</p>
            <Link
              href="/auth/signup"
              className="inline-flex items-center gap-2 bg-white text-ink px-7 py-3 rounded-xl font-medium hover:-translate-y-0.5 transition-all"
            >
              Get started →
            </Link>
          </div>
        )}
      </article>

      {related.length > 0 && (
        <div className="bg-surface border-t border-border">
          <div className="max-w-6xl mx-auto px-6 py-16">
            <h2 className="font-display text-2xl font-bold tracking-tight text-ink mb-8">{isHelp ? 'More help articles' : 'Related reading'}</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {related.map((p) => (
                <PostCard key={p.slug} post={p} />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
