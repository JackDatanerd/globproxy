'use client'
import { useMemo, useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import ProxyCard from '@/components/dashboard/ProxyCard'
import { formatGb } from '@/lib/format'
import { buildProxyUsername, getProxyPort, deriveSessionId } from '@/lib/proxyEndpoint'
import toast from 'react-hot-toast'
import { saveTextFile, apiFetch, apiJson } from '@/lib/clientApi'

interface Props {
  creds: any[]
  availableGb: number
  rotationEnabled?: boolean
}

type StatusFilter = 'all' | 'active' | 'pending' | 'suspended'

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
  // Any created_by: the server refuses top-up/auto-allocate/edit/delete on all
  // of them, including one whose creator is the owner.
  return !!cred.created_by
}

// Auto-allocate only counts as protection while it can actually act. Once the
// server has flagged it (balance empty / partial funding / size limit), the
// session is back to "will run out" — it used to stay silent because the flag
// was ignored here.
function autoAllocateCovering(cred: any): boolean {
  return !!cred.auto_topup_enabled && !cred.auto_topup_insufficient_alerted_at
}

function usageTier(cred: any): 'urgent' | 'warn' | null {
  if (cred.status !== 'active' || autoAllocateCovering(cred)) return null
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
export default function ProxyList({ creds, availableGb, rotationEnabled }: Props) {
  const router = useRouter()
  const [exporting, setExporting] = useState(false)
  // Bulk actions: pause / resume / delete many sessions in one go.
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})
  // Warnings stay hidden until the stored dismissals are read: showing them
  // first made already-dismissed banners flash on every page load.
  const [dismissedLoaded, setDismissedLoaded] = useState(false)
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
    setDismissedLoaded(true)
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

  const visibleWarnings = !dismissedLoaded ? [] : nearLimit.filter(({ cred, tier }) => !dismissed[dismissKeyFor(cred, tier)])

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
  // scraper fleet or a proxy manager without opening 30 cards. A sticky session
  // exports each of its named sessions (the fixed endpoints from its Sticky
  // sessions tab); one with none yet exports a single stable endpoint, the same
  // one the card's quick-copy gives.
  async function exportAll(format: 'csv' | 'txt' | 'url') {
    if (exporting) return
    setExporting(true)
    try { await exportAllInner(format) } finally { setExporting(false) }
  }
  async function exportAllInner(format: 'csv' | 'txt' | 'url') {
    type Row = { label: string; type: string; protocol: string; host: string; port: number | string; user: string; pass: string }
    const active = creds.filter(c => c.status === 'active' && c.username && c.password)
    let namedFailed = 0
    const rows: Row[] = []
    // ONE request for every named session of the account (was one GET per sticky session).
    const namedBy = new Map<string, { label: string; session_token: string }[]>()
    if (active.some(c => c.session_type === 'sticky')) {
      try {
        const data = await apiFetch('/api/dashboard/proxies/named-sessions')
        for (const n of data.sessions ?? []) {
          const list = namedBy.get(n.credential_id) ?? []
          list.push(n); namedBy.set(n.credential_id, list)
        }
      } catch { namedFailed = active.filter(c => c.session_type === 'sticky').length }
    }
    for (const c of active) {
      const sticky = c.session_type === 'sticky'
      const host = c.host || 'proxy.globproxy.com'
      const port = c.port || getProxyPort(c.protocol, c.session_type)
      const base = { type: c.session_type, protocol: c.protocol || 'http', host, port, pass: c.password as string }
      if (!sticky) {
        rows.push({ ...base, label: c.label || '', user: buildProxyUsername(c.username, { ...c, session_type: 'rotating', sticky_duration: null }) })
        continue
      }
      const named = namedBy.get(c.id) ?? []
      if (named.length === 0) {
        rows.push({ ...base, label: c.label || '', user: buildProxyUsername(c.username, c, deriveSessionId(c.id, 0)) })
      } else {
        for (const n of named) {
          rows.push({ ...base, label: `${c.label || 'Session'} / ${n.label}`, user: buildProxyUsername(c.username, c, n.session_token) })
        }
      }
    }
    if (rows.length === 0) { toast.error('No active sessions to export.'); return }
    const csvCell = (v: unknown) => {
      let s = String(v ?? '')
      // Spreadsheet formula injection: labels are free text.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    // `url` = scheme://user:pass@host:port, one per line — what most scrapers, browsers
    // and proxy managers paste directly (the .txt form is host:port:user:pass).
    const urlOf = (r: Row) => `${r.protocol === 'socks5' ? 'socks5' : 'http'}://${encodeURIComponent(r.user)}:${encodeURIComponent(r.pass)}@${r.host}:${r.port}`
    const body = format === 'csv'
      ? ['label,type,protocol,host,port,username,password', ...rows.map(r => [r.label, r.type, r.protocol, r.host, r.port, r.user, r.pass].map(csvCell).join(','))].join('\n') + '\n'
      : format === 'url'
        ? rows.map(urlOf).join('\n') + '\n'
        : rows.map(r => `${r.host}:${r.port}:${r.user}:${r.pass}`).join('\n') + '\n'
    saveTextFile(body, format === 'url' ? 'globproxy-endpoints-urls.txt' : `globproxy-endpoints.${format}`, format === 'csv' ? 'text/csv' : 'text/plain')
    toast.success(`Exported ${rows.length} endpoint${rows.length === 1 ? '' : 's'} — the file contains passwords, keep it private.`)
    if (namedFailed > 0) toast(`Couldn\u2019t load the named sessions of ${namedFailed} sticky session${namedFailed === 1 ? '' : 's'} — a single endpoint was exported for ${namedFailed === 1 ? 'it' : 'each'}.`, { icon: '⚠️', duration: 6000 })
  }

  // Reseller-allocated sessions can't be paused/deleted by the customer (the
  // server refuses), so they are never offered a checkbox.
  const selectable = (c: any) => !c.created_by
  // Only rows currently shown: a selection made before the search/filter changed must not
  // be acted on invisibly.
  const selectedCreds = filtered.filter(c => selected.has(c.id))
  const hiddenSelected = selected.size - selectedCreds.length
  const canPause  = selectedCreds.filter(c => c.status === 'active')
  const canResume = selectedCreds.filter(c => c.status === 'suspended' && c.suspended_reason === 'customer')
  function toggleSelected(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function exitSelecting() { setSelecting(false); setSelected(new Set()) }

  async function runBulk(kind: 'pause' | 'resume' | 'delete') {
    if (bulkBusy) return
    const targets = kind === 'pause' ? canPause : kind === 'resume' ? canResume : selectedCreds
    if (targets.length === 0) return
    if (kind === 'delete') {
      const unused = targets.reduce((sum, c) => sum + Math.max(0, Number(c.gb_allocated ?? 0) - Number(c.gb_used ?? 0)), 0)
      if (!window.confirm(`Delete ${targets.length} session${targets.length === 1 ? '' : 's'}? About ${formatGb(unused)} GB of unused bandwidth returns to your balance; GB already used isn't refunded. This can't be undone.`)) return
    }
    setBulkBusy(true)
    let ok = 0
    const failed: string[] = []
    let stop = false
    // Chunks of 20 per request: one usage sync per chunk instead of one per session, and one
    // rate-limit hit per chunk (see /api/dashboard/proxies/bulk-action).
    const labelOf = new Map(targets.map(c => [c.id, c.label || c.id.slice(0, 8)]))
    for (let i = 0; i < targets.length && !stop; i += 20) {
      const chunk = targets.slice(i, i + 20)
      try {
        const res = await apiJson('POST', '/api/dashboard/proxies/bulk-action', { action: kind, ids: chunk.map(c => c.id) })
        for (const r of res.results ?? []) {
          if (r.ok) ok++
          else failed.push(labelOf.get(r.id) ?? String(r.id).slice(0, 8))
        }
      } catch (err: any) {
        if (err?.code === 'mfa_required') { stop = true; break }   // redirected to verify
        for (const c of chunk) failed.push(c.label || c.id.slice(0, 8))
      }
    }
    setBulkBusy(false)
    const verb = kind === 'pause' ? 'paused' : kind === 'resume' ? 'resumed' : 'deleted'
    if (ok > 0) toast.success(`${ok} session${ok === 1 ? '' : 's'} ${verb}`)
    if (failed.length > 0) toast.error(`Couldn’t ${kind} ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`, { duration: 6000 })
    if (!stop) exitSelecting()
    router.refresh()
  }

  const counts = useMemo(() => ({
    all: creds.length,
    active: creds.filter(c => c.status === 'active').length,
    pending: creds.filter(c => c.status === 'pending').length,
    suspended: creds.filter(c => c.status === 'suspended').length,
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
                {isResellerAllocated(cred)
                  ? ' — ask your reseller for more bandwidth.'
                  : cred.auto_topup_enabled
                    ? ' and auto-allocate can\u2019t top it up — your account balance is empty or too low.'
                    : ' and auto-topup isn\u2019t on.'}
              </span>
              {!isResellerAllocated(cred) && (
                <button onClick={() => jumpTo(cred.id)}
                  className={`font-mono text-[11px] px-2.5 py-1 rounded-md border flex-shrink-0 ${
                    tier === 'urgent' ? 'border-red-300 hover:bg-red-100' : 'border-amber-300 hover:bg-amber-100'
                  }`}>
                  {cred.auto_topup_enabled ? 'Review' : 'Set up auto-topup'}
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
          {/* Suspended only appears when there is one — a session an admin
              disabled was previously findable only by scrolling "All". */}
          {([['all', 'All'], ['active', 'Active'], ['pending', 'Pending'], ['suspended', 'Suspended']] as const)
            .filter(([val]) => val !== 'suspended' || counts.suspended > 0 || statusFilter === 'suspended')
            .map(([val, label]) => (
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
          <button onClick={() => selecting ? exitSelecting() : setSelecting(true)} aria-pressed={selecting}
            className={`text-[11px] font-mono px-3 py-1.5 rounded-full border transition-colors ${selecting ? 'border-accent bg-accent-light text-accent' : 'border-border text-ink2 hover:border-accent hover:text-accent'}`}>
            {selecting ? 'Done' : 'Select'}
          </button>
          <button onClick={() => exportAll('txt')} disabled={exporting} title="Download host:port:user:pass for every active session"
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-border text-ink2 hover:border-accent hover:text-accent transition-colors disabled:opacity-50">
            {exporting ? 'Exporting…' : 'Export .txt'}
          </button>
          <button onClick={() => exportAll('url')} disabled={exporting} title="Download user:pass@host:port URLs, one per line, for every active session"
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-border text-ink2 hover:border-accent hover:text-accent transition-colors disabled:opacity-50">
            Export URLs
          </button>
          <button onClick={() => exportAll('csv')} disabled={exporting} title="Download a CSV of every active session"
            className="text-[11px] font-mono px-3 py-1.5 rounded-full border border-border text-ink2 hover:border-accent hover:text-accent transition-colors disabled:opacity-50">
            Export .csv
          </button>
        </div>
      </div>

      {selecting && (
        <div className="sticky top-2 z-10 mb-2.5 bg-white border border-accent/30 rounded-xl px-4 py-2.5 flex items-center gap-2.5 flex-wrap shadow-sm">
          <span className="text-xs font-mono text-ink">{selectedCreds.length} selected{hiddenSelected > 0 ? ` (+${hiddenSelected} hidden by the filter — not affected)` : ''}</span>
          <button onClick={() => setSelected(new Set(filtered.filter(selectable).map(c => c.id)))}
            className="text-[11px] font-mono text-accent hover:underline">Select all shown</button>
          <button onClick={() => setSelected(new Set())} disabled={selected.size === 0}
            className="text-[11px] font-mono text-muted hover:underline disabled:opacity-40">Clear</button>
          <span className="ml-auto flex gap-1.5">
            <button onClick={() => runBulk('pause')} disabled={bulkBusy || canPause.length === 0}
              className="text-[11px] font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:border-amber-300 hover:text-amber-600 transition-all disabled:opacity-40">
              Pause{canPause.length > 0 ? ` (${canPause.length})` : ''}
            </button>
            <button onClick={() => runBulk('resume')} disabled={bulkBusy || canResume.length === 0}
              className="text-[11px] font-mono px-3 py-1.5 rounded-lg border border-border text-muted hover:border-accent hover:text-accent transition-all disabled:opacity-40">
              Resume{canResume.length > 0 ? ` (${canResume.length})` : ''}
            </button>
            <button onClick={() => runBulk('delete')} disabled={bulkBusy || selectedCreds.length === 0}
              className="text-[11px] font-mono px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-all disabled:opacity-40">
              {bulkBusy ? 'Working…' : `Delete${selectedCreds.length > 0 ? ` (${selectedCreds.length})` : ''}`}
            </button>
          </span>
        </div>
      )}

      {filtered.length > 0 ? (
        <div className="flex flex-col gap-2">
          {filtered.map((cred) => (
            <div key={cred.id} ref={el => { cardRefs.current[cred.id] = el }} className={selecting ? 'flex items-start gap-2.5' : undefined}>
              {selecting && (
                <input type="checkbox" checked={selected.has(cred.id)} disabled={!selectable(cred) || bulkBusy}
                  onChange={() => toggleSelected(cred.id)}
                  aria-label={`Select ${cred.label || 'session'}`}
                  title={selectable(cred) ? undefined : 'Allocated by a reseller — can\u2019t be changed here'}
                  className="mt-5 h-4 w-4 flex-shrink-0 accent-[var(--accent,#0057ff)] disabled:opacity-30" />
              )}
              <div className={selecting ? 'flex-1 min-w-0' : undefined}>
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
                rotationEnabled={rotationEnabled}
              />
              </div>
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
