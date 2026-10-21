'use client'
import { useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'
import AdminAffiliateActions from '@/components/admin/AdminAffiliateActions'

export type PendingPayoutRow = {
  id: string
  referrerId: string
  name: string
  email: string
  deleted: boolean
  suspended: boolean
  cycle: string
  amountUsd: number
  // Already-formatted destination lines (null when the account was deleted).
  destination: { title: string; detail: string } | null
}

// The pending-payouts table with row selection, so one real-world batch (one
// USDT sweep, one bank file) can be recorded in one action instead of one
// prompt per affiliate. Each row still goes through the same atomic claim and
// affiliate email as the single "Mark paid" button.
export default function AdminPendingPayouts({ rows }: { rows: PendingPayoutRow[] }) {
  const payable = rows.filter(r => !r.deleted && !r.suspended)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)

  const total = rows.filter(r => selected.has(r.id)).reduce((s, r) => s + r.amountUsd, 0)
  const allSelected = payable.length > 0 && payable.every(r => selected.has(r.id))

  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(payable.map(r => r.id)))
  }

  async function markSelected() {
    if (selected.size === 0) return
    const ref = window.prompt(
      `Mark ${selected.size} payout${selected.size === 1 ? '' : 's'} (total $${total.toFixed(2)}) as PAID.\n\nOnly continue once the money has actually been sent. One reference for the whole batch (optional — shown to each affiliate):`, ''
    )
    if (ref === null) return
    setLoading(true)
    // Sent in chunks: one request for hundreds of payouts (each with an RPC, an
    // audit row and an email) risks a Worker timeout partway through. Every payout
    // is claimed atomically and idempotently, so a re-run after an interruption
    // is safe — already-paid ones simply report "not in a payable state".
    const ids = Array.from(selected)
    const CHUNK = 25
    let paidCount = 0
    const failed: { payoutId: string; error: string }[] = []
    let aborted: string | null = null
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { ok, data } = await adminPost('/api/admin/bulk-mark-payouts-paid', { payoutIds: ids.slice(i, i + CHUNK), reference: ref })
      const d = data as any
      if (!ok && d.paid == null) { aborted = d.error ?? 'Bulk action failed'; break }
      paidCount += d.paid ?? 0
      failed.push(...(d.failed ?? []))
    }
    if (aborted) {
      toast.error(`${paidCount} marked paid before it stopped: ${aborted}. Reload to see what is left, then retry — nothing is paid twice.`, { duration: 15000 })
      setLoading(false)
      if (paidCount > 0) setTimeout(() => window.location.reload(), 6000)
      return
    }
    if (failed.length) {
      toast.error(`${paidCount} marked paid, ${failed.length} failed: ${failed.slice(0, 3).map(f => f.error).join('; ')}`, { duration: 12000 })
      setTimeout(() => window.location.reload(), 4000)
    } else {
      toast.success(`${paidCount} payout${paidCount === 1 ? '' : 's'} marked paid`)
      window.location.reload()
    }
  }

  return (
    <div>
      {selected.size > 0 && (
        <div className="flex items-center justify-between bg-accent-light border border-accent/20 rounded-xl px-4 py-2.5 mb-3">
          <div className="text-xs font-mono text-ink">{selected.size} selected · ${total.toFixed(2)}</div>
          <button onClick={markSelected} disabled={loading}
            className="text-xs font-mono px-3 py-1.5 rounded-lg bg-accent2 text-white border border-accent2 hover:opacity-90 disabled:opacity-50">
            {loading ? '...' : 'Mark selected paid'}
          </button>
        </div>
      )}
      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="px-4 py-3 w-8">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={payable.length === 0} aria-label="Select all payable payouts" />
              </th>
              {['Affiliate', 'Cycle', 'Amount', 'Send to', 'Actions'].map(h => (
                <th key={h} className="text-left px-6 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id} className={i < rows.length - 1 ? 'border-b border-border' : ''}>
                <td className="px-4 py-4">
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} disabled={p.deleted || p.suspended}
                    aria-label={`Select payout for ${p.email}`} />
                </td>
                <td className="px-6 py-4">
                  <div className="text-sm font-medium text-ink">
                    {p.name || '—'}
                    {p.deleted && <span className="ml-2 text-[10px] font-mono bg-red-50 text-red-500 px-2 py-0.5 rounded-full">Deleted — void this</span>}
                    {!p.deleted && p.suspended && <span className="ml-2 text-[10px] font-mono bg-amber-50 text-amber-700 px-2 py-0.5 rounded-full">Suspended — check before paying</span>}
                  </div>
                  <div className="text-xs font-mono text-muted">{p.email}</div>
                  <Link href={`/admin/affiliates/${p.referrerId}`} className="text-[10px] font-mono text-accent hover:underline">Details →</Link>
                </td>
                <td className="px-6 py-4 text-xs font-mono text-muted">{p.cycle}</td>
                <td className="px-6 py-4 font-mono text-sm text-accent">${p.amountUsd.toFixed(2)}</td>
                <td className="px-6 py-4 text-xs font-mono text-ink">
                  {p.destination
                    ? <>{p.destination.title}<br /><span className="text-muted">{p.destination.detail}</span></>
                    : <span className="text-muted">Account deleted — destination removed</span>}
                </td>
                <td className="px-6 py-4">
                  <div className="flex gap-2">
                    {!p.deleted && <AdminAffiliateActions payoutId={p.id} action="markPaid" amountUsd={p.amountUsd} />}
                    <AdminAffiliateActions payoutId={p.id} action="voidPayout" amountUsd={p.amountUsd} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
