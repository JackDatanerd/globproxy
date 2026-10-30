import type { Metadata } from 'next'

// Next.js merges metadata SHALLOWLY: a page that exports its own `openGraph` (or `twitter`) replaces
// the root layout's whole object, and a page that exports only `title`/`description` inherits the
// root's og:title, og:description, og:url (= the homepage) and twitter:title. Before this helper
// /terms, /privacy, /refunds, /status and /locations/* shared the homepage's social card and og:url,
// and /blog and /help lost og:image. Every public page now builds its metadata here so title,
// description, canonical, Open Graph and Twitter always agree.
export const SITE_NAME = 'GlobProxy'

export const DEFAULT_OG_IMAGE = {
  url: '/og-image.png',
  width: 1200,
  height: 630,
  alt: 'GlobProxy — residential proxies that never expire',
}

type PageMetaInput = {
  /** Full <title>, brand suffix included. */
  title: string
  description: string
  /** Canonical path, e.g. "/terms". Always relative; metadataBase makes it absolute. */
  path: string
  /** Open Graph / Twitter title when it should differ from <title> (defaults to title). */
  socialTitle?: string
  /** Set false on routes that ship a file-based opengraph-image (it takes priority anyway). */
  defaultImage?: boolean
  /** Extra openGraph fields for articles. */
  article?: { publishedTime: string; modifiedTime: string }
}

export function pageMetadata(input: PageMetaInput): Metadata {
  const { title, description, path, article } = input
  const socialTitle = input.socialTitle ?? title
  const images = input.defaultImage === false ? undefined : [DEFAULT_OG_IMAGE]
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title: socialTitle,
      description,
      url: path,
      siteName: SITE_NAME,
      ...(images ? { images } : {}),
      ...(article ? { type: 'article' as const, ...article } : { type: 'website' as const }),
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      ...(images ? { images: images.map((i) => i.url) } : {}),
    },
  }
}
