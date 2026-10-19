'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

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
    const { ok, data } = await adminPost('/api/admin/sync-usage', userId ? { user_id: userId } : {})
    setLoading(false)
    if (!ok) { toast.error(data.error ?? 'Sync failed'); return }
    toast.success(
      data.updated_credentials > 0
        ? `Synced — ${data.updated_credentials} credential${data.updated_credentials === 1 ? '' : 's'} updated`
        : 'Synced — already up to date'
    )
    router.refresh()
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
