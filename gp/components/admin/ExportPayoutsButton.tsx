'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { createClient } from '@/lib/supabase/client'
import { fetchWithReauth } from '@/lib/reauthPrompt'

// Downloads the bulk-pay sheet (destination snapshot per payout) as CSV.
// The route needs the Bearer token, so a plain <a href> can't be used.
export default function ExportPayoutsButton({ status = 'pending' }: { status?: 'pending' | 'paid' | 'all' }) {
  const [loading, setLoading] = useState(false)

  async function download() {
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      if (!session?.access_token) { toast.error('Your session has expired — refresh and sign in again.'); return }
      const res = await fetchWithReauth(`/api/admin/payouts-csv?status=${status}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
      if (!res.ok) { toast.error((await res.json().catch(() => ({}))).error ?? 'Export failed'); return }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `globproxy-payouts-${status}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Network error — try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button onClick={download} disabled={loading}
      className="text-xs font-mono px-3 py-1.5 rounded-lg border border-border text-ink2 hover:border-ink2 hover:text-ink disabled:opacity-50">
      {loading ? '…' : 'Export CSV ↓'}
    </button>
  )
}
