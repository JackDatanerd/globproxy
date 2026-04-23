'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function AdminResellerActions({ userId, action }: { userId: string; action: 'approve' | 'suspend' }) {
  const [loading, setLoading] = useState(false)

  async function handle() {
    setLoading(true)
    const updates = action === 'approve'
      ? { role: 'reseller', reseller_status: 'approved' }
      : { role: 'user', reseller_status: 'suspended' }
    const { error } = await createClient().from('profiles').update(updates).eq('id', userId)
    if (error) toast.error(error.message)
    else { toast.success(action === 'approve' ? 'Reseller approved' : 'Reseller suspended'); window.location.reload() }
    setLoading(false)
  }

  return (
    <button onClick={handle} disabled={loading}
      className={`text-xs font-mono px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50 ${action === 'approve' ? 'bg-accent2 text-white border-accent2 hover:opacity-90' : 'border-red-200 text-red-400 hover:bg-red-50'}`}>
      {loading ? '...' : action === 'approve' ? 'Approve' : 'Suspend'}
    </button>
  )
}
