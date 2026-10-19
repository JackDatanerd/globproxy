import Link from 'next/link'

// Server-rendered prev/next for the admin list pages. Keeps the other query
// params (search, filters) when paging. These lists used to be a hard
// .limit(200) or an unbounded fetch (silently capped at PostgREST's 1000
// rows), with no way to reach anything older.
export default function AdminPager({
  basePath, page, pageSize, total, params = {},
}: {
  basePath: string
  page: number
  pageSize: number
  total: number
  params?: Record<string, string | undefined>
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null

  const href = (p: number) => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
    if (p > 1) sp.set('page', String(p))
    const qs = sp.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }
  const btn = 'text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2 hover:text-ink transition-all'
  const off = 'text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-muted opacity-50'

  return (
    <div className="flex items-center justify-between mt-4">
      <span className="text-xs font-mono text-muted">Page {page} of {pages} · {total.toLocaleString()} total</span>
      <div className="flex gap-2">
        {page > 1 ? <Link href={href(page - 1)} className={btn}>← Prev</Link> : <span className={off}>← Prev</span>}
        {page < pages ? <Link href={href(page + 1)} className={btn}>Next →</Link> : <span className={off}>Next →</span>}
      </div>
    </div>
  )
}

export function parsePage(v: string | string[] | undefined): number {
  const n = parseInt(Array.isArray(v) ? v[0] : v ?? '1', 10)
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? n : 1
}

// Strips characters that would break out of a PostgREST .or()/.ilike
// filter string (commas and parentheses delimit conditions; % and * are
// wildcards the caller didn't ask for).
export function cleanSearch(v: string | string[] | undefined): string {
  const raw = (Array.isArray(v) ? v[0] : v) ?? ''
  return raw.replace(/[,()%*\\"']/g, ' ').trim().slice(0, 80)
}
