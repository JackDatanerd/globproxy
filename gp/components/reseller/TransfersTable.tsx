'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { formatGb } from '@/lib/format'
import { RECLAIM_WINDOW_DAYS } from '@/lib/reseller'

type Transfer = {
  id: string
  created_at: string
  gb_amount: number
  reclaimed_gb: number
  status: string
  note: string | null
  email: string | null
  deleted: boolean
}

export default function TransfersTable({ transfers }: { transfers: Transfer[] }) {
  const [busy, setBusy] = useState<string | null>(null)

  async function reclaim(t: Transfer) {
    const remaining = t.gb_amount - t.reclaimed_gb
    if (!window.confirm(
      `Reclaim the UNUSED part of this ${formatGb(remaining)} GB transfer from ${t.email ?? 'this client'}?\n\n` +
      `Only bandwidth they have not used, assigned to a proxy, or topped up past can come back (within ${RECLAIM_WINDOW_DAYS} days of the transfer). They will be emailed.`
    )) return
    setBusy(t.id)
    try {
      const res = await fetch('/api/reseller/reclaim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transfer_id: t.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Could not reclaim')
      toast.success(`Reclaimed ${formatGb(data.reclaimed_gb)} GB`)
      setTimeout(() => window.location.reload(), 600)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  const badge = (s: string) =>
    s === 'active' ? 'bg-accent2-light text-accent2' : s === 'reclaimed' ? 'bg-zinc-100 text-zinc-500' : 'bg-yellow-50 text-yellow-600'

  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border bg-surface">
          {['Date', 'Client', 'GB', 'Note', 'Status', ''].map(h => (
            <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {transfers.map((t, i) => {
          const remaining = t.gb_amount - t.reclaimed_gb
          return (
            <tr key={t.id} className={`${i < transfers.length - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
              <td className="px-5 py-3.5 text-xs font-mono text-muted whitespace-nowrap">
                {new Date(t.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
              </td>
              <td className="px-5 py-3.5 text-sm text-ink">{t.deleted ? 'Deleted account' : (t.email ?? '—')}</td>
              <td className="px-5 py-3.5 font-mono text-sm font-medium text-ink whitespace-nowrap">
                {formatGb(t.gb_amount)} GB
                {t.reclaimed_gb > 0 && <span className="block text-[10px] text-muted font-normal">−{formatGb(t.reclaimed_gb)} reclaimed</span>}
              </td>
              <td className="px-5 py-3.5 text-xs text-muted max-w-[200px] truncate">{t.note ?? ''}</td>
              <td className="px-5 py-3.5">
                <span className={`text-[10px] font-mono px-2.5 py-1 rounded-full ${badge(t.status)}`}>{t.status}</span>
              </td>
              <td className="px-5 py-3.5 text-right">
                {t.status === 'active' && remaining > 0 && !t.deleted && Date.now() - new Date(t.created_at).getTime() < RECLAIM_WINDOW_DAYS * 86_400_000 && (
                  <button onClick={() => reclaim(t)} disabled={busy === t.id}
                    className="text-xs font-mono text-accent hover:underline disabled:opacity-50">
                    {busy === t.id ? 'Reclaiming…' : 'Reclaim unused'}
                  </button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
