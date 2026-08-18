'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function AdminApiAccessActions({ userId, action }: { userId: string; action: 'approve' | 'reject' }) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()
    const res = await fetch(`/api/admin/${action === 'approve' ? 'approve-api-access' : 'reject-api-access'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ userId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Action failed')
    } else {
      toast.success(action === 'approve' ? 'API access granted' : 'Request rejected')
      window.location.reload()
    }
    setLoading(false)
  }

  return (
    <button
      onClick={handle}
      disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${
        action === 'approve'
          ? 'bg-accent2 text-white border-accent2 hover:opacity-90'
          : 'border-red-200 text-red-400 hover:bg-red-50'
      }`}
    >
      {loading ? '...' : action === 'approve' ? 'Approve' : 'Reject'}
    </button>
  )
}
