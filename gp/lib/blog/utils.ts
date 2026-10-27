import { BLOG_POSTS } from './posts'
import type { BlogPost, ContentBlock } from './types'

const WORDS_PER_MINUTE = 220

function blockWordCount(block: ContentBlock): number {
  switch (block.type) {
    case 'p':
    case 'h2':
    case 'h3':
      return block.text.split(/\s+/).length
    case 'ul':
    case 'ol':
      return block.items.reduce((sum, i) => sum + i.split(/\s+/).length, 0)
    case 'quote':
      return block.text.split(/\s+/).length
    case 'callout':
      return block.title.split(/\s+/).length + block.text.split(/\s+/).length
    case 'table':
      return block.rows.reduce((sum, row) => sum + row.join(' ').split(/\s+/).length, 0)
    case 'code':
      // Snippets are skimmed and copied, not read at prose speed — count a
      // fraction so a code-heavy guide doesn't claim a 20-minute read.
      return Math.round(block.code.split(/\s+/).filter(Boolean).length / 4)
    default:
      return 0
  }
}

export function readingTime(post: BlogPost): string {
  const words = post.body.reduce((sum, b) => sum + blockWordCount(b), 0)
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE))
  return `${minutes} min read`
}

export function getAllPosts(): BlogPost[] {
  return [...BLOG_POSTS].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
}

export function getPostBySlug(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug)
}

export function getPostsByCategory(category: string): BlogPost[] {
  return getAllPosts().filter((p) => p.category === category)
}

// Same category first, falls back to most recent, excludes self, caps at 3.
export function getRelatedPosts(post: BlogPost, limit = 3): BlogPost[] {
  const others = getAllPosts().filter((p) => p.slug !== post.slug)
  const sameCategory = others.filter((p) => p.category === post.category)
  const rest = others.filter((p) => p.category !== post.category)
  return [...sameCategory, ...rest].slice(0, limit)
}
