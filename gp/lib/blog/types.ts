// Content is modeled as typed blocks rather than raw markdown/MDX so posts
// render with the exact design tokens used everywhere else in the app
// (font-display, text-ink, etc.) with no separate markdown-styling pass to
// keep in sync, and no new content-parsing dependency to install/maintain.

export type ContentBlock =
  | { type: 'p'; text: string }
  | { type: 'h2'; text: string; id?: string }
  | { type: 'h3'; text: string; id?: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string; cite?: string }
  | { type: 'callout'; title: string; text: string; tone?: 'accent' | 'accent2' }
  | { type: 'table'; headers: string[]; rows: string[][] }
  // A copy-paste snippet (commands, config, connection strings). `code` is
  // rendered verbatim in a monospace block with a copy button — newlines and
  // indentation are kept. `caption` is an optional one-line label above it.
  | { type: 'code'; code: string; language?: string; caption?: string }

export type BlogCategory =
  | 'Bandwidth & Pricing'
  | 'Geo-Targeting'
  | 'Use Cases'
  | 'Comparisons'
  | 'Guides'
  | 'Reseller'

export interface FaqItem {
  q: string
  a: string
}

export interface BlogPost {
  slug: string
  title: string
  // Meta description — keep under ~160 chars, this is what shows in SERPs.
  description: string
  // Shown on the /blog index card. Can differ slightly from description.
  excerpt: string
  category: BlogCategory
  // 'help' = a customer support how-to. Lives at /help/<slug>, is excluded from
  // the /blog index and feeds, and /blog/<slug> permanently redirects to it
  // (next.config.ts). Omit for ordinary blog posts.
  section?: 'help'
  publishedAt: string // ISO date, e.g. '2026-08-20'
  updatedAt?: string
  body: ContentBlock[]
  faq?: FaqItem[]
}
