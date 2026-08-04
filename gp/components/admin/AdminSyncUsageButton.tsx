'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

// user_id omitted = sync every active credential across every user
// (same work the cron 'usage' task does). user_id present = just that
// user's active credentials, pulled live from Geonode one at a time.
export default function AdminSyncUsageButton({
  userId,
  label = 'Sync usage now',
}: {
  userId?: string
  label?: string
}) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function sync() {
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/admin/sync-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify(userId ? { user_id: userId } : {}),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Sync failed')
      } else {
        toast.success(
          data.updated_credentials > 0
            ? `Synced — ${data.updated_credentials} credential${data.updated_credentials === 1 ? '' : 's'} updated`
            : 'Synced — already up to date'
        )
        router.refresh()
      }
    } catch {
      toast.error('Sync failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={sync}
      disabled={loading}
      className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink hover:border-ink2 transition-all disabled:opacity-50"
    >
      {loading ? 'Syncing…' : label}
    </button>
  )
}
