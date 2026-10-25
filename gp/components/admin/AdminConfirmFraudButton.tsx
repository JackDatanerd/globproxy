'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Marks a flagged referral as confirmed fraud: it stays blocked (never earns)
// but leaves the review queue.
export default function AdminConfirmFraudButton({ referralId }: { referralId: string }) {
  const [loading, setLoading] = useState(false)

  async function confirmFraud() {
    if (!confirm('Confirm this referral as fraud? It stays blocked — it will never earn a bonus or commission — and leaves the review queue. You can still clear it later.')) return
    const reason = window.prompt('What shows this is fraud? (required — kept in the audit log):')?.trim()
    if (!reason || reason.length < 3) { toast.error('A reason of at least 3 characters is required.'); return }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/confirm-referral-fraud', { referralId, reason })
    if (!ok) { toast.error(data.error ?? 'Could not confirm'); setLoading(false); return }
    toast.success('Marked as confirmed fraud')
    window.location.reload()
  }

  return (
    <button onClick={confirmFraud} disabled={loading}
      className="text-xs font-mono px-3 py-1.5 rounded-lg text-red-600 border border-red-300 hover:bg-red-50 disabled:opacity-50">
      {loading ? '...' : 'Confirm fraud'}
    </button>
  )
}
