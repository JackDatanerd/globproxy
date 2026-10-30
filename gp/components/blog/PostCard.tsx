import Link from 'next/link'
import type { BlogPost } from '@/lib/blog/types'
import { postPath, readingTime } from '@/lib/blog/utils'

export default function PostCard({ post, featured = false, headingLevel = 'h3' }: { post: BlogPost; featured?: boolean; headingLevel?: 'h2' | 'h3' }) {
  // The blog index sits directly under the page <h1>, so its cards use h2 (h1 -> h3 skipped a level).
  const Heading = headingLevel
  return (
    <Link
      href={postPath(post)}
      className={`group border border-border rounded-xl p-7 hover:border-accent hover:shadow-sm transition-all bg-white flex flex-col ${
        featured ? 'md:col-span-2' : ''
      }`}
    >
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[10px] font-mono tracking-widest uppercase text-accent bg-accent-light px-3 py-1 rounded-full">
          {post.category}
        </span>
        <span className="text-xs text-subtle font-mono">{readingTime(post)}</span>
      </div>
      <Heading className={`font-display font-bold text-ink tracking-tight mb-3 group-hover:text-accent transition-colors ${featured ? 'text-2xl' : 'text-lg'}`}>
        {post.title}
      </Heading>
      <p className="text-ink2 text-sm font-light leading-relaxed mb-4">{post.excerpt}</p>
      <div className="mt-auto text-sm text-accent font-medium">Read more →</div>
    </Link>
  )
}
