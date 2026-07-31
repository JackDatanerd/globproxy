'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// Previously this wrote straight to `profiles` from the browser
// (relying only on RLS), which meant:
//  - approve/reject never went through a server route at all (approve had
//    no route to call; reject-reseller existed but was never invoked)
//  - suspend never called /api/admin/suspend-user, so it neither killed
//    the target's active session nor sent the suspension email that
//    route was actually built to send
// Routing through the server endpoints fixes all three.
export default function AdminResellerActions({ userId, action }: { userId: string; action: 'approve' | 'suspend' | 'reject' }) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    const { data: { session } } = await createClient().auth.getSession()

    let res: Response
    if (action === 'approve') {
      res = await fetch('/api/admin/approve-reseller', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
    } else if (action === 'reject') {
      res = await fetch('/api/admin/reject-reseller', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })
    } else {
      res = await fetch('/api/admin/suspend-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: userId, action: 'suspend' }),
      })
    }

    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Action failed')
    } else {
      toast.success(
        action === 'approve' ? 'Reseller approved' : action === 'reject' ? 'Application rejected' : 'Reseller suspended'
      )
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
      {loading ? '...' : action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Suspend'}
    </button>
  )
}
