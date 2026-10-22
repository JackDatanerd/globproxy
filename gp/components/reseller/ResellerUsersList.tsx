'use client'

import { useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { formatGb } from '@/lib/format'
import { fetchWithReauth } from '@/lib/reauthPrompt'

type Client = {
  client_id: string
  email: string
  full_name: string | null
  is_deleted: boolean
  is_suspended: boolean
  transfer_count: number
  total_received_gb: number
  total_reclaimed_gb: number
  last_transfer_at: string
  last_note: string | null
  client_total_gb: number | null
  client_used_gb: number | null
  client_available_gb: number | null
}

const MIN_GB = 0.1

// Strict amount parse: the old quick top-up did `parseFloat(x) || 1`, so a
// blank or "0" field silently sent 1 GB of real, irreversible stock.
function parseGb(raw: string): number | null {
  const t = raw.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n) || n < MIN_GB || n > 1_000_000) return null
  if (Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) return null
  return Math.round(n * 1000) / 1000
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`)

// Goes through fetchWithReauth (accounts without 2FA get the one-time password
// prompt instead of a dead "403") and carries an Idempotency-Key: a retry after
// a throttle or a dropped connection returns the first answer and can never
// move the bandwidth twice.
async function postAllocate(email: string, gb: number, note: string | undefined, key: string) {
  let res: Response
  try {
    res = await fetchWithReauth('/api/reseller/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ recipient_email: email, gb_allocated: gb, note: note || undefined }),
    })
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error' } as any, retryAfter: null as number | null }
  }
  const data: any = await res.json().catch(() => ({}))
  const ra = Number(res.headers.get('Retry-After'))
  return { ok: res.ok, status: res.status, data, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null }
}

export default function ResellerUsersList({
  clients, availableGb, total, page, pageSize, query,
}: { clients: Client[]; availableGb: number; total: number; page: number; pageSize: number; query: string }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ email: '', gb: '1', note: '' })
  const [bulk, setBulk] = useState('')
  const [quickGbs, setQuickGbs] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState('')
  const [quickLoadings, setQuickLoadings] = useState<Record<string, boolean>>({})

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const href = (p: number) => `/reseller/users?${new URLSearchParams({ ...(query ? { q: query } : {}), page: String(p) })}`

  async function sendSingle(e: React.FormEvent) {
    e.preventDefault()
    const gb = parseGb(form.gb)
    if (gb === null) { toast.error(`Enter an amount of at least ${MIN_GB} GB (max 3 decimals)`); return }
    if (gb > availableGb) { toast.error('Not enough bandwidth in your stock'); return }
    setLoading(true)
    const r = await postAllocate(form.email.trim(), gb, form.note.trim(), newKey())
    setLoading(false)
    if (!r.ok) { toast.error(r.data.error ?? 'Transfer failed'); return }
    toast.success(r.data.message ?? 'Transferred')
    setTimeout(() => window.location.reload(), 600)
  }

  async function sendQuick(c: Client) {
    const gb = parseGb(quickGbs[c.client_id] ?? '1')
    if (gb === null) { toast.error(`Enter an amount of at least ${MIN_GB} GB — nothing was sent`); return }
    if (gb > availableGb) { toast.error('Not enough bandwidth in your stock'); return }
    setQuickLoadings(p => ({ ...p, [c.client_id]: true }))
    const r = await postAllocate(c.email, gb, undefined, newKey())
    setQuickLoadings(p => ({ ...p, [c.client_id]: false }))
    if (!r.ok) { toast.error(r.data.error ?? 'Transfer failed'); return }
    toast.success(r.data.message ?? 'Transferred')
    setTimeout(() => window.location.reload(), 600)
  }

  // Bulk: one "email, gb[, note]" per line. Validated up front, confirmed with
  // the exact total, then sent one at a time through the SAME checked route as
  // a single transfer (so every per-transfer rule and throttle still applies).
  async function sendBulk(e: React.FormEvent) {
    e.preventDefault()
    const lines = bulk.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) { toast.error('Add at least one line'); return }
    if (lines.length > 200) { toast.error('Max 200 lines per batch'); return }

    const rows: { email: string; gb: number; note: string }[] = []
    for (const [i, line] of lines.entries()) {
      const [email, gbRaw, ...noteParts] = line.split(',').map(s => s.trim())
      const gb = parseGb(gbRaw ?? '')
      if (!email || !email.includes('@') || gb === null) { toast.error(`Line ${i + 1}: expected "email, GB[, note]" with at least ${MIN_GB} GB`); return }
      rows.push({ email, gb, note: noteParts.join(', ') })
    }
    const sum = rows.reduce((s, r) => s + r.gb, 0)
    if (sum > availableGb) { toast.error(`Batch totals ${formatGb(sum)} GB but you only have ${formatGb(availableGb)} GB`); return }
    if (!window.confirm(`Send ${formatGb(sum)} GB across ${rows.length} client${rows.length === 1 ? '' : 's'}?`)) return

    setLoading(true)
    let okCount = 0, invitedCount = 0
    const failed: { line: string; why: string }[] = []   // definite failures — safe to resend
    const unknown: string[] = []                          // outcome unknown — check Transfers first
    for (const [i, r] of rows.entries()) {
      const key = newKey() // reused across the retries of THIS line only
      let attempts = 0
      let res = await postAllocate(r.email, r.gb, r.note, key)
      // The server allows 30 transfers a minute: wait out the throttle and
      // resend with the SAME key instead of abandoning the rest of the batch.
      while ((res.status === 429 || res.status === 0) && attempts < 6) {
        attempts++
        const wait = Math.min(res.retryAfter ?? 15, 60)
        setProgress(`${i} of ${rows.length} sent — ${res.status === 429 ? 'rate limit reached' : 'connection problem'}, retrying in ${wait}s…`)
        await sleep(wait * 1000)
        res = await postAllocate(r.email, r.gb, r.note, key)
      }
      if (res.ok) { okCount++; if (res.data?.status === 'pending_signup') invitedCount++ }
      else if (res.status === 429 || res.status === 0 || (res.status === 409 && /did not finish|still being processed/.test(res.data?.error ?? ''))) {
        unknown.push(`${r.email} (${res.data?.error ?? 'no answer'})`)
      } else {
        failed.push({ line: [r.email, String(r.gb), r.note].filter(Boolean).join(', '), why: `${r.email}: ${res.data?.error ?? 'failed'}` })
      }
      setProgress(`${i + 1} of ${rows.length} processed`)
    }
    setLoading(false)
    setProgress('')
    // Only the lines that definitely did NOT go through stay in the box, so a
    // resubmit can't send the successful ones a second time.
    setBulk(failed.map(f => f.line).join('\n'))
    const parts = [`${okCount} sent${invitedCount ? ` (${invitedCount} reserved for people who haven't signed up yet)` : ''}`]
    if (failed.length) parts.push(`${failed.length} failed and left in the box:\n${failed.slice(0, 4).map(f => f.why).join('\n')}`)
    if (unknown.length) parts.push(`${unknown.length} could not be confirmed — check Transfers before resending: ${unknown.slice(0, 3).join('; ')}`)
    if (!failed.length && !unknown.length) toast.success(`Sent to all ${okCount} clients`)
    else toast.error(parts.join('\n'), { duration: 12000 })
    if (okCount > 0) setTimeout(() => window.location.reload(), failed.length || unknown.length ? 6000 : 1200)
  }

  const input = 'w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent'

  return (
    <div>
      <div className="bg-white border border-border rounded-xl mb-6 shadow-sm">
        <button onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between p-5 text-left transition-colors hover:bg-zinc-50 rounded-xl">
          <div>
            <div className="font-medium text-ink text-sm">Send bandwidth to a client</div>
            <div className="text-xs text-muted mt-0.5">Activates immediately for existing accounts; for an email with no account yet, the bandwidth is reserved and delivered when they sign up. You can reclaim any part they haven&apos;t used from Transfers (within 30 days).</div>
          </div>
          <span className={`text-xl text-muted font-light transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
        </button>

        {open && (
          <div className="px-5 pb-5 border-t border-border pt-5">
            <div className="flex gap-2 mb-4">
              {(['single', 'bulk'] as const).map(m => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`text-xs font-mono px-3 py-1.5 rounded-full border ${mode === m ? 'bg-accent text-white border-accent' : 'border-border text-muted'}`}>
                  {m === 'single' ? 'One client' : 'Bulk (paste list)'}
                </button>
              ))}
            </div>

            {mode === 'single' ? (
              <form onSubmit={sendSingle}>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                  <div>
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Client email *</label>
                    <input required type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                      placeholder="client@example.com" className={input} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to send *</label>
                    <input required type="number" min={MIN_GB} step="any" value={form.gb}
                      onChange={e => setForm({ ...form, gb: e.target.value })} className={input} />
                    <div className="text-[10px] font-mono text-muted mt-1">{formatGb(availableGb)} GB available</div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Note (private)</label>
                    <input type="text" maxLength={200} value={form.note} onChange={e => setForm({ ...form, note: e.target.value })}
                      placeholder="e.g. invoice #1042" className={input} />
                  </div>
                </div>
                <button type="submit" disabled={loading}
                  className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                  {loading ? 'Sending...' : `Send ${form.gb || '…'} GB →`}
                </button>
              </form>
            ) : (
              <form onSubmit={sendBulk}>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">One per line: email, GB[, note]</label>
                <textarea rows={6} value={bulk} onChange={e => setBulk(e.target.value)}
                  placeholder={'alice@example.com, 5, invoice 1042\nbob@example.com, 2.5'} className={`${input} font-mono`} />
                <div className="text-[10px] font-mono text-muted mt-1 mb-4">{formatGb(availableGb)} GB available · up to 200 lines · sent one by one (large batches pause briefly to stay within the rate limit)</div>
                <button type="submit" disabled={loading}
                  className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                  {loading ? (progress || 'Sending...') : 'Send batch →'}
                </button>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mb-3 pl-1 gap-4 flex-wrap">
        <h3 className="text-sm font-display font-bold text-ink">Your Clients <span className="text-muted font-mono font-normal">({total})</span>
          <a href={`/api/reseller/users-csv${query ? `?q=${encodeURIComponent(query)}` : ''}`} className="ml-3 text-[11px] font-mono font-normal text-accent hover:underline">Export CSV ↓</a>
        </h3>
        <form action="/reseller/users" method="get" className="flex gap-2">
          <input name="q" defaultValue={query} placeholder="Search email or name" maxLength={100}
            className="bg-white border border-border px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-accent w-56" />
          <button className="text-xs font-mono px-3 py-2 rounded-lg border border-border text-muted hover:bg-surface">Search</button>
        </form>
      </div>

      {clients.length > 0 ? (
        <div className="flex flex-col gap-3">
          {clients.map(c => {
            const net = Number(c.total_received_gb) - Number(c.total_reclaimed_gb)
            const unavailable = c.is_deleted || c.is_suspended
            return (
              <div key={c.client_id} className="bg-white border border-border rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
                <div className="min-w-0">
                  <div className="font-medium text-ink text-sm mb-1 flex items-center gap-2 flex-wrap">
                    <span className="truncate">{c.is_deleted ? 'Deleted account' : c.email}</span>
                    {c.is_deleted && <span className="text-[10px] font-mono bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full">deleted</span>}
                    {c.is_suspended && <span className="text-[10px] font-mono bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded-full">suspended</span>}
                  </div>
                  <div className="text-[11px] text-muted">
                    Net transferred: <strong className="text-ink font-mono">{formatGb(net)} GB</strong>
                    {Number(c.total_reclaimed_gb) > 0 && <> · reclaimed {formatGb(c.total_reclaimed_gb)} GB</>}
                    {' · '}{c.transfer_count} transfer{Number(c.transfer_count) === 1 ? '' : 's'}
                  </div>
                  {!c.is_deleted && c.client_total_gb !== null && (
                    <div className="text-[11px] text-muted mt-0.5">
                      Of the <strong className="text-ink font-mono">{formatGb(c.client_total_gb)} GB</strong> you sent: used{' '}
                      <strong className="text-ink font-mono">{formatGb(c.client_used_gb)}</strong> · {formatGb(c.client_available_gb)} GB unassigned
                    </div>
                  )}
                  {c.last_note && <div className="text-[11px] text-muted mt-0.5 italic truncate">Last note: {c.last_note}</div>}
                  <div className="text-[10px] text-muted tracking-wide mt-1 uppercase">
                    Last activity: {new Date(c.last_transfer_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </div>
                </div>

                {!unavailable && (
                  <div className="flex items-center gap-2 pt-2 md:pt-0 border-t md:border-t-0 border-border md:w-auto w-full">
                    <span className="text-[10px] font-mono text-muted uppercase mr-1 hidden md:block">Quick Top-Up</span>
                    <input type="number" min={MIN_GB} step="any" value={quickGbs[c.client_id] ?? '1'}
                      onChange={e => setQuickGbs(p => ({ ...p, [c.client_id]: e.target.value }))}
                      className="w-20 text-sm bg-surface border border-border rounded-lg px-2 py-2 focus:outline-none focus:border-accent" placeholder="GB" />
                    <button onClick={() => sendQuick(c)} disabled={quickLoadings[c.client_id]}
                      className="bg-accent2 text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity whitespace-nowrap">
                      {quickLoadings[c.client_id] ? 'Sending...' : 'Add +'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-14 text-center shadow-sm">
          <p className="text-muted text-sm font-light">{query ? 'No clients match that search.' : 'No clients yet. Transfer bandwidth above to build your roster.'}</p>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-5 text-xs font-mono text-muted">
          {page > 1 ? <Link href={href(page - 1)} className="text-accent hover:underline">← Previous</Link> : <span />}
          <span>Page {page} of {totalPages}</span>
          {page < totalPages ? <Link href={href(page + 1)} className="text-accent hover:underline">Next →</Link> : <span />}
        </div>
      )}
    </div>
  )
}
