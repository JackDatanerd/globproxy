'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Second, more visible entry point for app/api/admin/delete-user, next to
// the Reset 2FA button on the user detail page.
export default function AdminDeleteUserButton({ userId, email }: { userId: string; email: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function del() {
    if (!confirm(`Permanently delete ${email}? This anonymises their profile, releases their proxy credentials and cannot be undone.`)) return
    // The old second dialog said "Type OK to confirm" but confirm() can't
    // take input. A real typed confirmation, matched against the email:
    const typed = window.prompt(`Type the account email to confirm deletion:\n${email}`)
    if (typed === null) return
    if (typed.trim().toLowerCase() !== email.toLowerCase()) { toast.error('Email did not match — nothing was deleted'); return }

    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/delete-user', { user_id: userId })
    if (!ok) { toast.error(data.error ?? 'Delete failed'); setLoading(false); return }
    toast.success('Account deleted')
    router.push('/admin/users')
  }

  return (
    <button onClick={del} disabled={loading}
      className="text-xs font-mono text-red-600 border border-red-300 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-all disabled:opacity-50">
      {loading ? 'Deleting…' : 'Delete account'}
    </button>
  )
}
