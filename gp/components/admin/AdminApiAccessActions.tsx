'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function AdminApiAccessActions({ userId, action }: { userId: string; action: 'approve' | 'reject' }) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    const { ok, data } = await adminPost(`/api/admin/${action === 'approve' ? 'approve-api-access' : 'reject-api-access'}`, { userId })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(action === 'approve' ? 'API access granted' : 'Request rejected')
    window.location.reload()
  }

  return (
    <button onClick={handle} disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${
        action === 'approve' ? 'bg-accent2 text-white border-accent2 hover:opacity-90' : 'border-red-200 text-red-400 hover:bg-red-50'
      }`}>
      {loading ? '...' : action === 'approve' ? 'Approve' : 'Reject'}
    </button>
  )
}
