'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function AdminMfaResetButton({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function reset() {
    if (!confirm("Reset this user's two-factor authentication? They'll need to set it up again on next login, and will be emailed about it.")) return
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/admin/mfa-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: userId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reset failed')
      toast.success('MFA reset — user has been notified by email')
      router.refresh()
    } catch (e: any) {
      toast.error(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={reset}
      disabled={loading}
      className="text-xs font-mono text-red-500 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-all disabled:opacity-50"
    >
      {loading ? 'Resetting…' : 'Reset 2FA'}
    </button>
  )
}
