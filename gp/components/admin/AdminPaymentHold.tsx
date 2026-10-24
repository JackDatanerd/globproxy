'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Payment hold on one account (lib/paymentHold.ts): a lost chargeback places it
// automatically; staff clear it after reviewing the account, or place it by hand.
export default function AdminPaymentHold({
  userId, hold,
}: {
  userId: string
  hold: { reason: string; source: string; created_at: string } | null
}) {
  const [loading, setLoading] = useState(false)

  async function run(action: 'clear' | 'place') {
    const verb = action === 'clear' ? 'Clear the payment hold? This account will be able to buy again.' : 'Put this account on payment hold? It will not be able to buy until you clear it.'
    if (!window.confirm(verb)) return
    const reason = window.prompt('Reason (kept in the audit log):')?.trim()
    if (!reason || reason.length < 3) { toast.error('A reason of at least 3 characters is required.'); return }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/payment-hold', { userId, action, reason })
    if (!ok) { toast.error(data.error ?? 'Failed'); setLoading(false); return }
    toast.success(action === 'clear' ? 'Payment hold cleared' : 'Account put on payment hold')
    window.location.reload()
  }

  if (!hold) {
    return (
      <button onClick={() => run('place')} disabled={loading}
        className="text-[11px] font-mono px-2.5 py-1 rounded-lg border border-border text-ink hover:bg-surface disabled:opacity-50 whitespace-nowrap">
        {loading ? '...' : 'Put on payment hold'}
      </button>
    )
  }
  return (
    <div className="mt-4 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <span className="font-medium">Payment hold</span>
        <span className="font-mono text-xs"> · {new Date(hold.created_at).toLocaleString('en-GB')}</span>
        <span> — {hold.reason}{hold.source === 'dispute_lost' ? ' (automatic)' : ''}. New purchases are blocked.</span>
      </div>
      <button onClick={() => run('clear')} disabled={loading}
        className="text-[11px] font-mono px-2.5 py-1 rounded-lg border border-amber-300 hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap">
        {loading ? '...' : 'Clear hold'}
      </button>
    </div>
  )
}
