import Navbar from '@/components/Navbar'
import Footer from '@/components/Footer'
import PostCard from '@/components/blog/PostCard'
import { getAllPosts } from '@/lib/blog/utils'
import { pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Blog — GlobProxy',
  description:
    'Guides on residential proxy bandwidth, city-level geo-targeting, session types, and honest provider comparisons — from the team building GlobProxy.',
  socialTitle: 'GlobProxy Blog — proxy bandwidth, geo-targeting and sessions',
  path: '/blog',
})

export default function BlogIndexPage() {
  const posts = getAllPosts()
  const [latest, ...rest] = posts

  return (
    <>
      <Navbar />
      <main id="main" className="max-w-6xl mx-auto px-6 py-16">
        <div className="mb-12">
          <div className="inline-block bg-accent-light text-accent text-xs font-mono tracking-widest uppercase px-4 py-1.5 rounded-full mb-4">
            Blog
          </div>
          <h1 className="font-display text-4xl lg:text-5xl font-black tracking-tight text-ink mb-3">
            Bandwidth, geo-targeting,<br />and how not to waste either.
          </h1>
          <p className="text-ink2 font-light leading-relaxed max-w-xl">
            Practical guides on proxy bandwidth, city-level targeting, session types, and honest comparisons — written for people actually running the workload, not for search engines.
          </p>
        </div>
        {posts.length === 0 ? (
          <p className="text-ink2 font-light">Nothing published yet — check back soon.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {latest && <PostCard post={latest} featured headingLevel="h2" />}
            {rest.map((post) => (
              <PostCard key={post.slug} post={post} headingLevel="h2" />
            ))}
          </div>
        )}
      </main>
      <Footer />
    </>
  )
}
