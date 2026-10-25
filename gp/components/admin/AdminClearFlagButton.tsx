'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function AdminClearFlagButton({ referralId }: { referralId: string }) {
  const [loading, setLoading] = useState(false)

  async function clear() {
    if (!confirm('Clear this flag? Anything this referral\'s orders would have earned while flagged is back-filled to the referrer now, and future orders earn normally.')) return
    const reason = window.prompt('Why is this referral legitimate? (required — kept in the audit log):')?.trim()
    if (!reason || reason.length < 3) { toast.error('A reason of at least 3 characters is required.'); return }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/clear-referral-flag', { referralId, reason })
    if (!ok) { toast.error(data.error ?? 'Could not clear the flag'); setLoading(false); return }
    const b = data.backfill
    toast.success(b?.commissions_backfilled ? `Flag cleared · ${b.commissions_backfilled} commission${b.commissions_backfilled === 1 ? '' : 's'} back-filled ($${Number(b.commission_usd).toFixed(2)})` : b?.bonus_credited ? 'Flag cleared · GB bonus credited' : 'Flag cleared')
    window.location.reload()
  }

  return (
    <button onClick={clear} disabled={loading}
      className="text-xs font-mono px-3 py-1.5 rounded-lg bg-accent2 text-white border border-accent2 hover:opacity-90 disabled:opacity-50">
      {loading ? '...' : 'Clear flag'}
    </button>
  )
}
