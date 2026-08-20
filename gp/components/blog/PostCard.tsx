import Link from 'next/link'
import type { BlogPost } from '@/lib/blog/types'
import { readingTime } from '@/lib/blog/utils'

export default function PostCard({ post, featured = false }: { post: BlogPost; featured?: boolean }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`group border border-border rounded-xl p-7 hover:border-accent hover:shadow-sm transition-all bg-white flex flex-col ${
        featured ? 'md:col-span-2' : ''
      }`}
    >
      <div className="flex items-center gap-3 mb-4">
        <span className="text-[10px] font-mono tracking-widest uppercase text-accent bg-accent-light px-3 py-1 rounded-full">
          {post.category}
        </span>
        <span className="text-xs text-muted font-mono">{readingTime(post)}</span>
      </div>
      <h3 className={`font-display font-bold text-ink tracking-tight mb-3 group-hover:text-accent transition-colors ${featured ? 'text-2xl' : 'text-lg'}`}>
        {post.title}
      </h3>
      <p className="text-ink2 text-sm font-light leading-relaxed mb-4">{post.excerpt}</p>
      <div className="mt-auto text-sm text-accent font-medium">Read more →</div>
    </Link>
  )
}
