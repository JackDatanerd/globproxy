'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

export default function AdminMfaResetButton({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function reset() {
    // MFA is optional platform-wide now, so after a reset the account can
    // sign in with just its password — the wording used to say they'd be
    // forced through setup again.
    if (!confirm("Reset this user's two-factor authentication? It will be switched off and they can sign in with just their password until they re-enable it. They'll be emailed. Only do this after verifying who is asking.")) return
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/mfa-reset', { user_id: userId })
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Reset failed'); return }
    toast.success('MFA reset — user has been notified by email')
    router.refresh()
  }

  return (
    <button onClick={reset} disabled={loading}
      className="text-xs font-mono text-red-500 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50 transition-all disabled:opacity-50">
      {loading ? 'Resetting…' : 'Reset 2FA'}
    </button>
  )
}
