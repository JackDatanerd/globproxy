'use client'
import { useMemo, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import ProxyCard from '@/components/dashboard/ProxyCard'
import { formatGb } from '@/lib/format'
import { buildProxyUsername, getProxyPort, deriveSessionId } from '@/lib/proxyEndpoint'
import toast from 'react-hot-toast'

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
//
// Reseller-allocated sessions are included too (they can't be topped up or
// auto-allocated by the customer, but running dry is just as disruptive —
// the banner points them at their reseller instead). They used to be
// skipped only implicitly, because auto_topup is never enabled on them…
// which meant they got the warning with a button for a feature they can't use.
function isResellerAllocated(cred: any): boolean {
  return !!cred.created_by && cred.created_by !== cred.user_id
}

function usageTier(cred: any): 'urgent' | 'warn' | null {
  if (cred.status !== 'active' || cred.auto_topup_enabled) return null
  if (!cred.gb_allocated || cred.gb_allocated <= 0) return null
  const pct = ((cred.gb_used ?? 0) / cred.gb_allocated) * 100
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
  const [requestedTab, setRequestedTab] = useState<{ id: string; tab: 'bandwidth'; nonce: number } | null>(null)

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
      const stored: Record<string, boolean> = raw ? JSON.parse(raw) : {}
      // Drop entries for deleted sessions so the stored map can't grow forever.
      const live = new Set(creds.map(c => c.id))
      const pruned = Object.fromEntries(Object.entries(stored).filter(([k]) => live.has(k.split(':')[0])))
      if (Object.keys(pruned).length !== Object.keys(stored).length) localStorage.setItem(DISMISS_KEY, JSON.stringify(pruned))
      setDismissed(pruned)
    } catch {}
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The key includes the credential's current allocation: after a top-up the
  // allocation changes, so a later re-drain past 80%/95% is a NEW warning
  // instead of staying silenced by a dismissal made before the refill.
  function dismissKeyFor(cred: any, tier: string) { return `${cred.id}:${tier}:${Number(cred.gb_allocated ?? 0)}` }

  function dismiss(cred: any, tier: string) {
    setDismissed(prev => {
      const next = { ...prev, [dismissKeyFor(cred, tier)]: true }
      try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  const visibleWarnings = nearLimit.filter(({ cred, tier }) => !dismissed[dismissKeyFor(cred, tier)])

  function jumpTo(credId: string) {
    // The target may be hidden by the current search/status filter — clear
    // them first, otherwise "jump to" expanded a row that wasn't rendered and
    // nothing visibly happened.
    setQuery('')
    setStatusFilter('all')
    setExpandedId(credId)
    // Land on the tab the banner is about, not whichever one was last open.
    setRequestedTab({ id: credId, tab: 'bandwidth', nonce: Date.now() })
    // Wait a tick for the expand to render before scrolling to it.
    setTimeout(() => cardRefs.current[credId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return creds.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!q) return true
      const haystack = [c.label, c.country, c.state, c.city, c.asn, c.session_type, c.protocol, c.status]
        .filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [creds, query, statusFilter])

  // One file with every active session's connection details — for loading a
  // scraper fleet or a proxy manager without opening 30 cards. Sticky sessions
  // export one stable endpoint each (the same one the card's quick-copy gives);
  // named sticky sessions live in each card's Sticky sessions tab.
  function exportAll(format: 'csv' | 'txt') {
    const rows = creds
      .filter(c => c.status === 'active' && c.username && c.password)
      .map(c => {
        const sticky = c.session_type === 'sticky'
        const host = c.host || 'proxy.globproxy.com'
        const port = c.port || getProxyPort(c.protocol, c.session_type)
        const user = sticky
          ? buildProxyUsername(c.username, c, deriveSessionId(c.id, 0))
          : buildProxyUsername(c.username, { ...c, session_type: 'rotating', sticky_duration: null })
        return { label: c.label || '', type: c.session_type, protocol: c.protocol || 'http', host, port, user, pass: c.password }
      })
    if (rows.length === 0) { toast.error('No active sessions to export.'); return }
    const csvCell = (v: unknown) => {
      let s = String(v ?? '')
      // Spreadsheet formula injection: labels are free text.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const body = format === 'csv'
      ? ['label,type,protocol,host,port,username,password', ...rows.map(r => [r.label, r.type, r.protocol, r.host, r.port, r.user, r.pass].map(csvCell).join(','))].join('\n') + '\n'
      : rows.map(r => `${r.host}:${r.port}:${r.user}:${r.pass}`).join('\n') + '\n'
    const blob = new Blob([body], { type: format === 'csv' ? 'text/csv' : 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `globproxy-endpoints.${format}`
    a.click(); URL.revokeObjectURL(url)
    toast.success(`Exported ${rows.length} session${rows.length === 1 ? '' : 's'} — the file contains passwords, keep it private.`)
  }

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
                {' '}has used {formatGb(cred.gb_used ?? 0)} of {formatGb(cred.gb_allocated)} GB
                {tier === 'urgent' ? ' — about to stop working' : ''}
                {isResellerAllocated(cred) ? ' — ask your reseller for more bandwidth.' : ' and auto-topup isn\u2019t on.'}
              </span>
              {!isResellerAllocated(cred) && (
                <button onClick={() => jumpTo(cred.id)}
                  className={`font-mono text-[11px] px-2.5 py-1 rounded-md border flex-shrink-0 ${
                    tier === 'urgent' ? 'border-red-300 hover:bg-red-100' : 'border-amber-300 hover:bg-amber-100'
                  }`}>
                  Set up auto-topup
                </button>
              )}
              <button onClick={() => dismiss(cred, tier)} aria-label="Dismiss"
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
        <div className="flex gap-1.5">
          <button onClick={() => exportAll('txt')} title="Download host:port:user:pass for every active session"
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-border text-ink2 hover:border-accent hover:text-accent transition-colors">
            Export .txt
          </button>
          <button onClick={() => exportAll('csv')} title="Download a CSV of every active session"
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-border text-ink2 hover:border-accent hover:text-accent transition-colors">
            Export .csv
          </button>
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-2">
          {filtered.map((cred) => (
            <div key={cred.id} ref={el => { cardRefs.current[cred.id] = el }}>
              <ProxyCard
                cred={cred}
                availableGb={availableGb}
                // Creation order across the FULL list (oldest = #1): the
                // list is newest-first and filtered, so a plain map index
                // renumbered every unlabeled session on each new session and
                // on every keystroke in the search box.
                index={creds.length - 1 - creds.findIndex(c => c.id === cred.id)}
                requestedTab={requestedTab && requestedTab.id === cred.id ? requestedTab : null}
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
