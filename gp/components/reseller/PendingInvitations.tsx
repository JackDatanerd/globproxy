'use client'

import { useState } from 'react'
import toast from 'react-hot-toast'
import { formatGb } from '@/lib/format'
import { apiJson } from '@/lib/clientApi'

export type PendingInvite = { id: string; email: string; gb: number; created_at: string; expires_at: string; note: string | null }

// Bandwidth reserved for addresses that haven't signed up yet. It leaves your
// available stock the moment you send it and lands when they confirm an account;
// cancelling (or the 30-day expiry) puts it straight back.
export default function PendingInvitations({ invites }: { invites: PendingInvite[] }) {
  const [busy, setBusy] = useState<string | null>(null)

  async function cancel(i: PendingInvite) {
    if (!window.confirm(`Cancel the invitation for ${i.email}? The ${formatGb(i.gb)} GB goes back to your available stock.`)) return
    setBusy(i.id)
    try {
      const d = await apiJson('POST', '/api/reseller/invitations/cancel', { pending_id: i.id })
      toast.success(`${formatGb(d.returned_gb)} GB returned to your stock`)
      setTimeout(() => window.location.reload(), 600)
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setBusy(null)
    }
  }

  const date = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div className="bg-white border border-border rounded-xl mb-6 overflow-x-auto">
      <div className="px-5 py-3 border-b border-border">
        <div className="text-sm font-medium text-ink">Waiting for sign-up <span className="text-muted font-mono font-normal">({invites.length})</span></div>
        <div className="text-[11px] text-muted mt-0.5">Reserved for people without an account yet. It&apos;s delivered when they sign up with that email and confirm it; unclaimed after 30 days it returns to your stock.</div>
      </div>
      <table className="w-full">
        <tbody>
          {invites.map((i, n) => (
            <tr key={i.id} className={n < invites.length - 1 ? 'border-b border-border' : ''}>
              <td className="px-5 py-3 text-sm text-ink">{i.email}</td>
              <td className="px-5 py-3 font-mono text-sm font-medium text-ink whitespace-nowrap">{formatGb(i.gb)} GB</td>
              <td className="px-5 py-3 text-xs text-muted whitespace-nowrap">sent {date(i.created_at)} · expires {date(i.expires_at)}</td>
              <td className="px-5 py-3 text-xs text-muted max-w-[160px] truncate">{i.note ?? ''}</td>
              <td className="px-5 py-3 text-right">
                <button onClick={() => cancel(i)} disabled={busy === i.id} className="text-xs font-mono text-accent hover:underline disabled:opacity-50">
                  {busy === i.id ? 'Cancelling…' : 'Cancel'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
