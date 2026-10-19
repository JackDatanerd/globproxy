'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function AdminClearFlagButton({ referralId }: { referralId: string }) {
  const [loading, setLoading] = useState(false)

  async function clear() {
    if (!confirm('Clear this flag? Future orders from this referral will earn the referrer their bonus / commission normally.')) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/clear-referral-flag', { referralId })
    if (!ok) { toast.error(data.error ?? 'Could not clear the flag'); setLoading(false); return }
    toast.success('Flag cleared')
    window.location.reload()
  }

  return (
    <button onClick={clear} disabled={loading}
      className="text-xs font-mono px-3 py-1.5 rounded-lg bg-accent2 text-white border border-accent2 hover:opacity-90 disabled:opacity-50">
      {loading ? '...' : 'Clear flag'}
    </button>
  )
}
