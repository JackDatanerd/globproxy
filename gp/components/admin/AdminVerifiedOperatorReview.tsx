'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// "I re-checked this Verified Operator and they stay" — restarts the review clock.
export default function AdminVerifiedOperatorReview({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(false)
  async function mark() {
    const note = window.prompt('What did you check, and why do they stay a Verified Operator? (required — kept in the audit log)', '')
    if (note === null) return
    if (note.trim().length < 3) { toast.error('A note (at least 3 characters) is required'); return }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/verified-operator-review', { userId, note })
    if (!ok) { toast.error(data.error ?? 'Could not record the review'); setLoading(false); return }
    toast.success('Review recorded')
    window.location.reload()
  }
  return (
    <button onClick={mark} disabled={loading}
      className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2 hover:text-ink disabled:opacity-50">
      {loading ? '…' : 'Mark reviewed'}
    </button>
  )
}
