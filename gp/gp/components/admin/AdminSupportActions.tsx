'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { adminPost } from '@/lib/adminFetch'

// Reply to / resolve / reopen one support report (api/admin/support-report).
export default function AdminSupportActions({ reportId, status }: { reportId: string; status: 'open' | 'resolved' | string }) {
  const [loading, setLoading] = useState(false)

  async function act(action: 'resolve' | 'reopen' | 'reply') {
    let note: string | null = ''
    let reply: string | null = ''
    if (action === 'reply') {
      reply = window.prompt('Message to the customer (emailed from support@; the report stays open):', '')
      if (reply === null) return
      if (reply.trim().length < 2) { toast.error('Write a message first'); return }
    }
    if (action === 'resolve') {
      note = window.prompt('Optional INTERNAL note (what was done) — never sent to the customer:', '')
      if (note === null) return
      reply = window.prompt('Optional message to the customer, included in the "resolved" email (leave blank to send none):', '')
      if (reply === null) return
    }
    setLoading(true)
    const { ok, data } = await adminPost('/api/admin/support-report', { reportId, action, note, reply })
    if (!ok) { toast.error(data.error ?? 'Action failed'); setLoading(false); return }
    const d = data as any
    if (d.warning) toast.error(d.warning, { duration: 8000 })
    else if (action !== 'reopen' && d.customer_notified === false) toast.error('Saved, but the email to the customer could not be sent.', { duration: 8000 })
    else toast.success(action === 'resolve' ? 'Report resolved' : action === 'reply' ? 'Reply sent' : 'Report reopened')
    setTimeout(() => window.location.reload(), d.warning ? 2500 : 600)
  }

  return status === 'open' ? (
    <div className="flex gap-2">
      <button onClick={() => act('reply')} disabled={loading}
        className="text-xs font-mono text-accent border border-accent/30 px-3 py-1.5 rounded-lg hover:bg-accent-light disabled:opacity-50">
        {loading ? '…' : 'Reply'}
      </button>
      <button onClick={() => act('resolve')} disabled={loading}
        className="text-xs font-mono text-accent2 border border-accent2/30 px-3 py-1.5 rounded-lg hover:bg-accent2-light disabled:opacity-50">
        {loading ? '…' : 'Resolve'}
      </button>
    </div>
  ) : (
    <button onClick={() => act('reopen')} disabled={loading}
      className="text-xs font-mono text-muted border border-border px-3 py-1.5 rounded-lg hover:text-ink hover:border-ink2 disabled:opacity-50">
      {loading ? '…' : 'Reopen'}
    </button>
  )
}
