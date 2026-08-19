'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// Same route AdminUserControls.tsx's dropdown entry calls (app/api/admin/
// delete-user) — this is the second, more visible entry point on the
// detail page itself, next to the existing Reset 2FA button, since that's
// evidently where this gets used in practice rather than the list-page
// dropdown.
export default function AdminDeleteUserButton({ userId, email }: { userId: string; email: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function del() {
    if (!confirm(`Permanently delete ${email}? This anonymises their profile and cannot be undone.`)) return
    if (!confirm('Really sure? There is no undo for this.')) return
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ user_id: userId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
      toast.success('Account deleted')
      router.push('/admin/users')
    } catch (e: any) {
      toast.error(e.message)
      setLoading(false)
    }
  }

  return (
    <button
      onClick={del}
      disabled={loading}
      className="text-xs font-mono text-red-600 border border-red-300 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-all disabled:opacity-50"
    >
      {loading ? 'Deleting…' : 'Delete account'}
    </button>
  )
}
