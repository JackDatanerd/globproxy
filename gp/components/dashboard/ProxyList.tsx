'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import ProxyCard from '@/components/dashboard/ProxyCard'

interface Props {
  creds: any[]
  availableGb: number
}

type StatusFilter = 'all' | 'active' | 'pending'

// Search + status filter didn't exist at all on this page before — needed
// once someone has more than a handful of sessions to scan through. Only
// one row is expanded at a time so opening a new one doesn't leave a wall
// of open cards behind.
export default function ProxyList({ creds, availableGb }: Props) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

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
            <ProxyCard
              key={cred.id}
              cred={cred}
              index={i}
              expanded={expandedId === cred.id}
              onToggle={() => setExpandedId(prev => prev === cred.id ? null : cred.id)}
            />
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
