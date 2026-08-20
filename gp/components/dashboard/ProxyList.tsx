'use client'
import { useMemo, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import ProxyCard from '@/components/dashboard/ProxyCard'
import { formatGb } from '@/lib/format'

interface Props {
  creds: any[]
  availableGb: number
}

type StatusFilter = 'all' | 'active' | 'pending'

const DISMISS_KEY = 'gp_usage_banner_dismissed'

// Which credentials are close to running out with nothing set up to
// refill them automatically — nothing like this existed before, so
// running out mid-use was a silent surprise (proxy just stops working)
// rather than something visible ahead of time. 80% is "heads up," 95% is
// "about to actually stop working." Escalating past a dismissed tier
// re-surfaces the banner rather than staying hidden forever — a dismiss
// at 80% shouldn't suppress the more urgent 95% warning later.
function usageTier(cred: any): 'urgent' | 'warn' | null {
  if (cred.status !== 'active' || cred.auto_topup_enabled) return null
  if (!cred.gb_allocated || cred.gb_allocated <= 0) return null
  const pct = (cred.gb_used / cred.gb_allocated) * 100
  if (pct >= 95) return 'urgent'
  if (pct >= 80) return 'warn'
  return null
}

// Search + status filter didn't exist at all on this page before — needed
// once someone has more than a handful of sessions to scan through. Only
// one row is expanded at a time so opening a new one doesn't leave a wall
// of open cards behind.
export default function ProxyList({ creds, availableGb }: Props) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const nearLimit = useMemo(() => {
    return creds
      .map(c => ({ cred: c, tier: usageTier(c) }))
      .filter((x): x is { cred: any; tier: 'urgent' | 'warn' } => x.tier !== null)
      .sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'urgent' ? -1 : 1))
  }, [creds])

  // Dismissal key includes the tier, so escalating from warn -> urgent on
  // the same credential is treated as a new thing to dismiss, not still
  // covered by an earlier dismiss of the less urgent version.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DISMISS_KEY)
      setDismissed(raw ? JSON.parse(raw) : {})
    } catch {}
  }, [])

  function dismissKeyFor(credId: string, tier: string) { return `${credId}:${tier}` }

  function dismiss(credId: string, tier: string) {
    setDismissed(prev => {
      const next = { ...prev, [dismissKeyFor(credId, tier)]: true }
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  const visibleWarnings = nearLimit.filter(({ cred, tier }) => !dismissed[dismissKeyFor(cred.id, tier)])

  function jumpTo(credId: string) {
    setExpandedId(credId)
    // Wait a tick for the expand to render before scrolling to it.
    setTimeout(() => cardRefs.current[credId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return creds.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!q) return true
      const haystack = [c.label, c.country, c.state, c.city, c.session_type, c.protocol]
        .filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [creds, query, statusFilter])

  const counts = useMemo(() => ({
    all: creds.length,
    active: creds.filter(c => c.status === 'active').length,
    pending: creds.filter(c => c.status === 'pending').length,
  }), [creds])

  return (
    <div>
      {/* Usage-near-limit banners — one per affected credential, each
          independently dismissible. A single combined banner would hide
          which specific session(s) need attention; separate ones keep
          each dismiss meaningful and let the "jump to it" link go
          somewhere specific. */}
      {visibleWarnings.length > 0 && (
        <div className="flex flex-col gap-2 mb-3.5">
          {visibleWarnings.map(({ cred, tier }) => (
            <div key={cred.id}
              className={`flex items-center gap-3 rounded-lg border px-4 py-2.5 text-xs ${
                tier === 'urgent' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-100 text-amber-700'
              }`}>
              <span>{tier === 'urgent' ? '⚠️' : '📊'}</span>
              <span className="flex-1">
                <button onClick={() => jumpTo(cred.id)} className="font-medium hover:underline">
                  {cred.label || 'This session'}
                </button>
                {' '}has used {formatGb(cred.gb_used)} of {formatGb(cred.gb_allocated)}GB
                {tier === 'urgent' ? ' — about to stop working' : ''} and auto-topup isn't on.
              </span>
              <button onClick={() => jumpTo(cred.id)}
                className={`font-mono text-[11px] px-2.5 py-1 rounded-md border flex-shrink-0 ${
                  tier === 'urgent' ? 'border-red-300 hover:bg-red-100' : 'border-amber-300 hover:bg-amber-100'
                }`}>
                Set up auto-topup
              </button>
              <button onClick={() => dismiss(cred.id, tier)} aria-label="Dismiss"
                className="text-current opacity-50 hover:opacity-100 flex-shrink-0 px-1">✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2.5 mb-3.5 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted text-xs">⌕</span>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by label, country, city…"
            className="w-full bg-white border border-border pl-8 pr-3 py-2 rounded-lg text-xs focus:outline-none focus:border-accent transition-colors"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {([['all', 'All'], ['active', 'Active'], ['pending', 'Pending']] as const).map(([val, label]) => (
            <button key={val} onClick={() => setStatusFilter(val)}
              className={`text-[11px] font-mono px-3 py-1.5 rounded-full border transition-colors ${
                statusFilter === val ? 'bg-ink text-white border-ink' : 'bg-white text-ink2 border-border hover:border-ink2/40'
              }`}>
              {label} <span className="opacity-60">({counts[val]})</span>
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] font-mono text-muted">{filtered.length} shown</span>
      </div>

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-2">
          {filtered.map((cred, i) => (
            <div key={cred.id} ref={el => { cardRefs.current[cred.id] = el }}>
              <ProxyCard
                cred={cred}
                index={i}
                expanded={expandedId === cred.id}
                onToggle={() => setExpandedId(prev => prev === cred.id ? null : cred.id)}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-dashed border-border rounded-xl p-10 text-center">
          <p className="text-muted text-sm">No sessions match your search or filter.</p>
          <button onClick={() => { setQuery(''); setStatusFilter('all') }}
            className="text-accent text-sm hover:underline mt-1.5">
            Clear filters
          </button>
        </div>
      )}
    </div>
  )
}
