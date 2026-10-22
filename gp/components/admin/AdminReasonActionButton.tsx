'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// One button for the admin actions that need a written reason (void a
// commission, void a referral's earnings, waive a clawback). The reason is
// asked for, sent with the call, and recorded in the audit log server-side.
export default function AdminReasonActionButton({
  label, endpoint, payload, confirmText, successText, tone = 'danger',
}: {
  label: string
  endpoint: string
  payload: Record<string, unknown>
  confirmText: string
  successText: string
  tone?: 'danger' | 'neutral'
}) {
  const [loading, setLoading] = useState(false)

  async function run() {
    if (!window.confirm(confirmText)) return
    const reason = window.prompt('Reason (kept in the audit log):')?.trim()
    if (!reason || reason.length < 3) { toast.error('A reason of at least 3 characters is required.'); return }
    setLoading(true)
    const { ok, data } = await adminPost(endpoint, { ...payload, reason })
    if (!ok) { toast.error(data.error ?? 'Failed'); setLoading(false); return }
    toast.success(successText)
    window.location.reload()
  }

  const cls = tone === 'danger'
    ? 'text-red-600 border-red-300 hover:bg-red-50'
    : 'text-ink border-border hover:bg-surface'
  return (
    <button onClick={run} disabled={loading}
      className={`text-[11px] font-mono px-2.5 py-1 rounded-lg border disabled:opacity-50 whitespace-nowrap ${cls}`}>
      {loading ? '...' : label}
    </button>
  )
}
