'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { formatGb } from '@/lib/format'
import { RECLAIM_WINDOW_DAYS } from '@/lib/reseller'
import { apiJson } from '@/lib/clientApi'

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

  // Reclaim all of the unused part, or just some of it: a blank answer takes
  // back everything that can be, a number takes back at most that many GB (the
  // server still caps it at what the client hasn't used or committed).
  async function reclaim(t: Transfer) {
    const remaining = t.gb_amount - t.reclaimed_gb
    const answer = window.prompt(
      `Reclaim from ${t.email ?? 'this client'} (${formatGb(remaining)} GB of this transfer is still with them).\n\n` +
      `How many GB? Leave blank to take back everything unused.\n\n` +
      `Only bandwidth they have not used, assigned to a proxy, or topped up past can come back (within ${RECLAIM_WINDOW_DAYS} days of the transfer). They will be emailed.`,
      ''
    )
    if (answer === null) return
    let gb: number | undefined
    if (answer.trim() !== '') {
      const n = Number(answer.trim())
      if (!Number.isFinite(n) || n <= 0 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
        toast.error('Enter a positive amount with at most 3 decimal places — nothing was reclaimed')
        return
      }
      if (n > remaining + 1e-9) {
        toast.error(`That is more than the ${formatGb(remaining)} GB left on this transfer — nothing was reclaimed`)
        return
      }
      gb = n
    }
    setBusy(t.id)
    try {
      // apiJson answers the password / 2FA prompt for this sensitive action.
      const data = await apiJson('POST', '/api/reseller/reclaim', { transfer_id: t.id, ...(gb !== undefined ? { gb } : {}) })
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
                    {busy === t.id ? 'Reclaiming…' : 'Reclaim…'}
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
