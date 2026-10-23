'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Cancels one open reseller invitation; the reserved stock returns to the reseller.
export default function AdminCancelInvitation({ pendingId }: { pendingId: string }) {
  const [loading, setLoading] = useState(false)
  async function go() {
    if (!confirm('Cancel this invitation? The reserved stock goes back to the reseller.')) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/cancel-invitation', { pendingId })
    if (!ok) { toast.error((data as any).error ?? 'Could not cancel'); setLoading(false); return }
    toast.success('Invitation cancelled')
    setTimeout(() => window.location.reload(), 500)
  }
  return (
    <button onClick={go} disabled={loading} className="text-xs font-mono px-3 py-1.5 rounded-lg border border-red-200 text-red-400 hover:bg-red-50 disabled:opacity-50">
      {loading ? '...' : 'Cancel'}
    </button>
  )
}
