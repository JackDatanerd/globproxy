import type { Metadata } from 'next'
import Link from 'next/link'
import Navbar from '@/components/Navbar'
import { HELP_TOPICS } from '@/lib/blog/help'
import { getHelpArticleBySlug, postPath, readingTime } from '@/lib/blog/utils'

export const metadata: Metadata = {
  title: 'Help Centre — GlobProxy',
  description:
    'Step-by-step help for connecting to the proxy, targeting a country or city, managing sessions and bandwidth, payments, and account security.',
  alternates: { canonical: '/help' },
  openGraph: {
    title: 'Help Centre — GlobProxy',
    description: 'Step-by-step help for connecting, targeting, sessions, bandwidth, payments and account security.',
    url: '/help',
    type: 'website',
  },
}

export default function HelpIndexPage() {
  return (
    <>
      <Navbar />
      <div className="max-w-4xl mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">
            Help centre
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-3">
            How can we help?
          </h1>
          <p className="text-ink2 font-light leading-relaxed max-w-xl">
            Step-by-step guides for the things customers ask us most. If you cannot find your answer, email{' '}
            <a href="mailto:support@globproxy.com" className="text-accent hover:underline">support@globproxy.com</a>.
          </p>
        </div>

        <div className="flex flex-col gap-12">
          {HELP_TOPICS.map((topic) => {
            const articles = topic.slugs.map((s) => getHelpArticleBySlug(s)).filter((a) => !!a)
            if (articles.length === 0) return null
            return (
              <section key={topic.title}>
                <h2 className="font-display text-2xl font-bold tracking-tight text-ink mb-1">{topic.title}</h2>
                <p className="text-ink2 font-light text-sm mb-5">{topic.blurb}</p>
                <div className="flex flex-col gap-3">
                  {articles.map((a) => (
                    <Link
                      key={a!.slug}
                      href={postPath(a!)}
                      className="group border border-border rounded-xl p-5 bg-white hover:border-accent hover:shadow-sm transition-all"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <h3 className="font-display font-bold text-ink tracking-tight group-hover:text-accent transition-colors">
                          {a!.title}
                        </h3>
                        <span className="text-xs text-muted font-mono shrink-0">{readingTime(a!)}</span>
                      </div>
                      <p className="text-ink2 text-sm font-light leading-relaxed mt-1.5">{a!.excerpt}</p>
                    </Link>
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        <div className="mt-16 bg-surface border border-border rounded-2xl p-8 text-center">
          <h2 className="font-display text-xl font-bold text-ink tracking-tight mb-2">Did not find it?</h2>
          <p className="text-ink2 font-light text-sm mb-5">
            Tell us what you are trying to do and what you see on screen. A real person will reply.
          </p>
          <a href="mailto:support@globproxy.com" className="inline-flex bg-accent text-white px-7 py-3 rounded-xl font-medium hover:-translate-y-0.5 transition-all">
            Contact support →
          </a>
        </div>
      </div>
    </>
  )
}
