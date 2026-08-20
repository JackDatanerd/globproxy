import { ImageResponse } from 'next/og'
import { getPostBySlug } from '@/lib/blog/utils'

export const runtime = 'edge'
export const alt = 'GlobProxy blog post'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Same design tokens as tailwind.config.js (ink/accent/accent2) — ImageResponse
// can't consume Tailwind classes so the hex values are duplicated here on
// purpose rather than imported, since this runs in an isolated edge runtime.
const INK = '#0f1114'
const ACCENT = '#0057ff'
const ACCENT2 = '#00c896'

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = getPostBySlug(slug)
  const title = post?.title ?? 'GlobProxy Blog'
  const category = post?.category ?? 'Blog'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: INK,
          padding: '72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: 2,
              textTransform: 'uppercase',
              color: ACCENT2,
              backgroundColor: 'rgba(0,200,150,0.12)',
              padding: '8px 18px',
              borderRadius: 999,
            }}
          >
            {category}
          </div>
        </div>
        <div
          style={{
            fontSize: 56,
            fontWeight: 800,
            color: 'white',
            lineHeight: 1.15,
            letterSpacing: -1,
            display: 'flex',
          }}
        >
          {title.length > 90 ? `${title.slice(0, 90)}…` : title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 28, fontWeight: 800, color: 'white' }}>
          Glob<span style={{ color: ACCENT }}>Proxy</span>
        </div>
      </div>
    ),
    { ...size }
  )
}
