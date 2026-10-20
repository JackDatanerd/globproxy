'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Resolve / reopen one support report (api/admin/support-report).
export default function AdminSupportActions({ reportId, status }: { reportId: string; status: 'open' | 'resolved' | string }) {
  const [loading, setLoading] = useState(false)

  async function act(action: 'resolve' | 'reopen') {
    let note: string | null = ''
    if (action === 'resolve') {
      note = window.prompt('Optional internal note (what was done) — kept with the report:', '')
      if (note === null) return
    }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/support-report', { reportId, action, note })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    toast.success(action === 'resolve' ? 'Report resolved' : 'Report reopened')
    window.location.reload()
  }

  return status === 'open' ? (
    <button onClick={() => act('resolve')} disabled={loading}
      className="text-xs font-mono text-accent2 border border-accent2/30 px-3 py-1.5 rounded-lg hover:bg-accent2-light disabled:opacity-50">
      {loading ? '…' : 'Resolve'}
    </button>
  ) : (
    <button onClick={() => act('reopen')} disabled={loading}
      className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink hover:border-ink2 disabled:opacity-50">
      {loading ? '…' : 'Reopen'}
    </button>
  )
}
